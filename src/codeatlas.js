import crypto from "node:crypto";

import { PolicyError } from "./core.js";

const FULL_SHA = /^[0-9a-f]{40}$/i;

function requireCommit(commit) {
  if (typeof commit !== "string" || !FULL_SHA.test(commit)) {
    throw new PolicyError("CodeAtlas evidence requires a full 40-character commit SHA", "REVISION_REQUIRED");
  }
  return commit.toLowerCase();
}

function normalizeRepository(value) {
  return typeof value === "string" ? value : value?.id || value?.repo || value?.repository;
}

function normalizeCommit(value) {
  return value?.commit || value?.metadata?.commit || value?.revision || "";
}

function normalizePath(value) {
  return value?.path || value?.metadata?.path || "";
}

function normalizeLocator(value) {
  const start = Number(value?.start_line || value?.metadata?.start_line || value?.line || 1);
  const end = Number(value?.end_line || value?.metadata?.end_line || value?.line || start);
  return { startLine: start, endLine: Math.max(start, end) };
}

function unwrapToolResult(result) {
  if (result?.isError) throw new Error(result.content?.map((part) => part.text || "").join(" ") || "CodeAtlas MCP tool failed");
  if (result?.structuredContent !== undefined) {
    const structured = result.structuredContent;
    return structured && typeof structured === "object" && Object.keys(structured).length === 1 && "result" in structured ? structured.result : structured;
  }
  const text = result?.content?.find((part) => part.type === "text")?.text;
  if (text === undefined) return result;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && Object.keys(parsed).length === 1 && "result" in parsed ? parsed.result : parsed;
  } catch { return text; }
}

export class JsonRpcMcpTransport {
  constructor({ url, token, fetchImpl = globalThis.fetch }) {
    if (!url || !token || typeof fetchImpl !== "function") throw new PolicyError("CodeAtlas MCP URL and token are required", "CONFIG_REQUIRED");
    this.url = url;
    this.token = token;
    this.fetch = fetchImpl;
    this.requestId = 0;
    this.initialized = false;
    this.sessionId = null;
  }

  async callTool(name, arguments_) {
    await this.initialize();
    return this.request("tools/call", { name, arguments: arguments_ });
  }

  async initialize() {
    if (this.initialized) return;
    const response = await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "sitepilot", version: "0.1.0" },
    });
    if (!response?.protocolVersion) throw new Error("CodeAtlas MCP initialize returned no protocol version");
    await this.notify("notifications/initialized", {});
    this.initialized = true;
  }

  async notify(method, params) {
    await this.send({ jsonrpc: "2.0", method, params });
  }

  async request(method, params) {
    const result = await this.send({ jsonrpc: "2.0", id: ++this.requestId, method, params });
    if (result?.error) throw new Error(result.error.message || `CodeAtlas MCP error: ${method}`);
    return unwrapToolResult(result?.result ?? result);
  }

  async send(payload) {
    const headers = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${this.token}`,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const response = await this.fetch(this.url, { method: "POST", headers, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(`CodeAtlas MCP HTTP ${response.status}`);
    const session = response.headers.get?.("mcp-session-id");
    if (session) this.sessionId = session;
    const text = await response.text();
    if (!text) return {};
    if (response.headers.get?.("content-type")?.includes("text/event-stream")) {
      const data = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (!data) throw new Error("CodeAtlas MCP SSE response contained no data event");
      return JSON.parse(data);
    }
    return JSON.parse(text);
  }
}

export class CodeAtlasMcpAdapter {
  constructor({ transport, repositories = [], licenseReferences = {} } = {}) {
    if (!transport || typeof transport.callTool !== "function") throw new PolicyError("CodeAtlas MCP transport is required", "CONFIG_REQUIRED");
    this.transport = transport;
    this.repositories = new Set(repositories);
    this.licenseReferences = { ...licenseReferences };
  }

  assertRepository(repository) {
    if (!repository || !this.repositories.has(repository)) {
      throw new PolicyError(`CodeAtlas repository is outside the allowlist: ${repository || "missing"}`, "REPOSITORY_DENIED");
    }
  }

  assertEvidence(evidence, expectedCommit) {
    const repository = normalizeRepository(evidence);
    const commit = requireCommit(normalizeCommit(evidence));
    this.assertRepository(repository);
    if (commit !== requireCommit(expectedCommit)) {
      throw new PolicyError("CodeAtlas result does not match the frozen source commit", "STALE_REVISION");
    }
    return { repository, commit };
  }

  async conventions({ language = "", framework = "", task = "" } = {}) {
    return this.transport.callTool("get_company_conventions", { language, framework, task });
  }

  async indexStatus() {
    return this.transport.callTool("index_status", {});
  }

  async search({ query, repository, expectedCommit, language, topK = 5 } = {}) {
    this.assertRepository(repository);
    const frozenCommit = requireCommit(expectedCommit);
    const raw = await this.transport.callTool("search_code", { query, repository, language, top_k: topK });
    const rows = Array.isArray(raw) ? raw : raw?.results || [];
    return rows.map((value) => {
      const { repository: repo, commit } = this.assertEvidence(value, frozenCommit);
      const path = normalizePath(value);
      if (!path) throw new PolicyError("CodeAtlas result has no file path", "INVALID_EVIDENCE");
      return {
        repository: repo,
        commit,
        path,
        locator: normalizeLocator(value),
        licenseReference: this.licenseReferences[repo] || value.license_reference || null,
        indexStatus: value.index_status || "active",
        compatibilityNotes: value.compatibility_notes || [],
        evidenceId: crypto.createHash("sha256").update(`${repo}:${commit}:${path}:${JSON.stringify(normalizeLocator(value))}`).digest("hex"),
      };
    });
  }

  async getFile({ repository, path, expectedCommit, startLine = 1, endLine = 200 } = {}) {
    this.assertRepository(repository);
    const raw = await this.transport.callTool("get_file", { repository, path, start_line: startLine, end_line: endLine, commit: requireCommit(expectedCommit) });
    const { repository: repo, commit } = this.assertEvidence(raw, expectedCommit);
    return {
      repository: repo,
      commit,
      path: normalizePath(raw) || path,
      locator: normalizeLocator(raw),
      content: raw.content || "",
      licenseReference: this.licenseReferences[repo] || raw.license_reference || null,
    };
  }
}

export class FixtureCodeAtlasTransport {
  constructor(fixtures = {}) { this.fixtures = fixtures; }
  async callTool(name, args) {
    const handler = this.fixtures[name];
    if (typeof handler !== "function") throw new Error(`No fixture for CodeAtlas tool: ${name}`);
    return handler(args);
  }
}

export function createCodeAtlasAdapterFromEnvironment({ repositories = [], licenseReferences = {} } = {}) {
  return new CodeAtlasMcpAdapter({
    repositories: repositories.length ? repositories : (process.env.CODEATLAS_REPOSITORIES || "").split(",").map((value) => value.trim()).filter(Boolean),
    licenseReferences,
    transport: new JsonRpcMcpTransport({
      url: process.env.CODEATLAS_MCP_URL,
      token: process.env.CODEATLAS_MCP_TOKEN,
    }),
  });
}
