import http from "node:http";
import crypto from "node:crypto";
import { SitePilotStore, PolicyError, planStrategy } from "./core.js";
import { JsonSitePilotStore, SqliteSitePilotStore } from "./persistence.js";
import { EvidenceStore, JsonEvidenceStore, SqliteEvidenceStore } from "./evidence.js";
import { planPayloadSchema } from "./payload-schema.js";
import { BlockRegistry, JsonBlockRegistry, SqliteBlockRegistry } from "./registry.js";
import { researchComponents } from "./research-agent.js";
import { composePagePlan } from "./page-composer.js";
import { createCodeAtlasAdapterFromEnvironment } from "./codeatlas.js";
import { PayloadHttpSandboxBackend, PayloadSandboxAdapter, computePayloadRequestHash } from "./payload-adapter.js";
import { WorktreePolicy } from "./core.js";
import { materializePagePlan } from "./code-generator.js";
import { validateGeneratedCandidate } from "./local-build.js";
import path from "node:path";
import fs from "node:fs/promises";
import { GrantStore, SqliteGrantStore } from "./grants.js";
import { QualityAdapter } from "./quality-adapter.js";
import { PlaywrightPreviewAdapter } from "./playwright-preview.js";
import { PayloadBuildPipeline } from "./payload-build.js";
import { PINNED_SOURCES } from "./pinned-sources.js";
import { LocalPreviewServer, loadPreviewManifest } from "./preview-server.js";
import { createPayloadDraftPlan } from "./payload-template.js";
import { createIntakeAdapterFromEnvironment, createOpenAICompatibleIntakeAdapter } from "./intake.js";
import { createPiModelRuntime, SitePilotAgentRuntime } from "./agent-runtime.js";
import { createAgentToolRuntime, runCreationSupervisor } from "./agent-supervisor.js";
import { JsonToolJournal, resolveToolJournalPath } from "./tool-runtime.js";
import { applyUnifiedDiff, validateUnifiedDiff } from "./code-patch.js";

function applyRequirementBrief(strategy, brief, confirmed = {}) {
  if (!brief) return strategy;
  const resolved = new Set();
  if (confirmed.audience && String(confirmed.audience).trim()) resolved.add("audience");
  if (confirmed.primaryConversion && String(confirmed.primaryConversion).trim()) resolved.add("primaryConversion");
  if (confirmed.brandConstraints && confirmed.brandConstraints.length) resolved.add("brandConstraints");
  if (confirmed.contentAvailable && confirmed.contentAvailable.length) resolved.add("contentAvailable");
  if (confirmed.localeProvided || brief.locales.length) resolved.add("locale");
  const questions = [...(brief.openQuestions || []).filter((question) => !resolved.has(question.field)), ...(strategy.openQuestions || [])];
  const seen = new Set();
  const openQuestions = questions.filter((question) => {
    if (seen.has(question.field)) return false;
    seen.add(question.field);
    return true;
  }).slice(0, 3);
  return {
    ...strategy,
    openQuestions,
    requirementSummary: brief.summary,
    recommendedPages: brief.recommendedPages,
    designSuggestions: brief.designSuggestions,
    assumptions: brief.assumptions,
  };
}

function modelConfigFromInput(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PolicyError("Model configuration must be an object", "INVALID_INPUT");
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
  const model = typeof input.model === "string" ? input.model.trim() : "";
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const apiMode = typeof input.apiMode === "string" ? input.apiMode.trim() : "chat_completions";
  if (!baseUrl || baseUrl.length > 500 || !model || model.length > 200 || !apiKey || apiKey.length > 8192) throw new PolicyError("Model URL, model name and API key are required", "INVALID_INPUT");
  if (!["chat_completions", "codex_responses"].includes(apiMode)) throw new PolicyError("Unsupported model API mode", "INVALID_INPUT");
  return { baseUrl, model, apiKey, apiMode };
}

function contentModelHash(model = {}) {
  return crypto.createHash("sha256").update(JSON.stringify({
    candidateId: model.candidateId || null,
    candidateHash: model.candidateHash || null,
    designDraftId: model.designDraftId || null,
    designHash: model.designHash || null,
    pagePlanHash: model.pagePlanHash || null,
    contentByPage: model.contentByPage || null,
  })).digest("hex");
}

function codePatchHash(patch = {}) {
  const { codePatchHash: omitted, ...canonical } = patch;
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function reviewDecisionHash(decision = {}) {
  return crypto.createHash("sha256").update(JSON.stringify(decision)).digest("hex");
}

function normalizeRepairPatch(input, { candidate, source, reviewDecision, expectedReviewHash } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PolicyError("Repair patch must be an object", "SCHEMA_REJECTED");
  const allowed = new Set(["whyNow", "expectedObservation", "stopIf", "risk", "status", "candidateId", "candidateHash", "expectedHead", "reviewDecisionHash", "files", "expectedTests", "risks", "codePatchHash"]);
  if (Object.keys(input).some((field) => !allowed.has(field))) throw new PolicyError("Repair patch contains an unsupported field", "SCHEMA_REJECTED");
  if (input.candidateId !== candidate.id || input.candidateHash !== candidate.candidateHash || input.expectedHead !== source.expectedHead || input.reviewDecisionHash !== expectedReviewHash) throw new PolicyError("Repair patch does not match the current candidate, source or ReviewDecision", "STALE_REVISION");
  if (!/^[a-f0-9]{64}$/i.test(input.candidateHash) || !/^[a-f0-9]{64}$/i.test(input.reviewDecisionHash)) throw new PolicyError("Repair patch revision hashes are invalid", "SCHEMA_REJECTED");
  if (input.status !== undefined && input.status !== "proposed") throw new PolicyError("Repair patch status is invalid", "SCHEMA_REJECTED");
  if (typeof input.whyNow !== "string" || input.whyNow.length < 8 || input.whyNow.length > 300 || typeof input.expectedObservation !== "string" || input.expectedObservation.length < 8 || input.expectedObservation.length > 300 || !Array.isArray(input.stopIf) || input.stopIf.length > 5 || input.stopIf.some((item) => typeof item !== "string" || !item.trim() || item.length > 120) || !["low", "medium", "high"].includes(input.risk)) throw new PolicyError("Repair patch decision record is invalid", "SCHEMA_REJECTED");
  if (!Array.isArray(input.expectedTests) || input.expectedTests.length < 1 || input.expectedTests.length > 12 || input.expectedTests.some((item) => typeof item !== "string" || !item.trim() || item.length > 240)) throw new PolicyError("Repair patch expected tests are invalid", "SCHEMA_REJECTED");
  if (!Array.isArray(input.risks || []) || input.risks.length > 8 || input.risks.some((item) => typeof item !== "string" || !item.trim() || item.length > 300)) throw new PolicyError("Repair patch risks are invalid", "SCHEMA_REJECTED");
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 20) throw new PolicyError("Repair patch requires one to twenty files", "SCHEMA_REJECTED");
  const allowedPaths = new Set(source.sourceFiles);
  const pathFindings = (reviewDecision.findings || []).filter((finding) => typeof finding?.path === "string");
  const addressedFindings = new Set();
  const files = input.files.map((file) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) throw new PolicyError("Repair patch file entry is invalid", "SCHEMA_REJECTED");
    if (Object.keys(file).some((key) => !["path", "operation", "summary", "diff", "findingIndexes"].includes(key))) throw new PolicyError("Repair patch file entry contains an unsupported field", "SCHEMA_REJECTED");
    if (typeof file.path !== "string" || !file.path.trim() || file.path.length > 240 || file.path.startsWith("/") || file.path.split(/[\\/]/).includes("..") || /(^|[\\/])(?:\.env(?:\.|$)|\.git(?:[\\/]|$)|node_modules(?:[\\/]|$)|secrets?(?:[\\/]|$))/i.test(file.path) || !allowedPaths.has(file.path.replaceAll("\\", "/"))) throw new PolicyError(`Repair patch path is not in the current candidate: ${file.path}`, "POLICY_DENIED");
    const normalizedPath = file.path.replaceAll("\\", "/");
    if (file.operation !== undefined && file.operation !== "modify") throw new PolicyError("Repair patch may only modify existing candidate files", "SCHEMA_REJECTED");
    if (typeof file.summary !== "string" || !file.summary.trim() || file.summary.length > 500) throw new PolicyError("Repair patch file summary is invalid", "SCHEMA_REJECTED");
    const diff = validateUnifiedDiff(file.diff, normalizedPath);
    const indexes = file.findingIndexes === undefined ? [] : file.findingIndexes;
    if (!Array.isArray(indexes) || indexes.length > 12 || indexes.some((index) => !Number.isInteger(index) || index < 0 || index >= reviewDecision.findings.length)) throw new PolicyError("Repair patch finding references are invalid", "SCHEMA_REJECTED");
    const referenced = indexes.map((index) => reviewDecision.findings[index]);
    if (pathFindings.length && !pathFindings.some((finding) => finding.path === normalizedPath) && !referenced.some((finding) => !finding?.path)) throw new PolicyError(`Repair patch is not bound to a Review finding: ${normalizedPath}`, "POLICY_DENIED");
    if (referenced.some((finding) => finding?.path && finding.path !== normalizedPath)) throw new PolicyError(`Repair patch finding does not match ${normalizedPath}`, "POLICY_DENIED");
    indexes.forEach((index) => addressedFindings.add(index));
    reviewDecision.findings.forEach((finding, index) => { if (finding.path === normalizedPath) addressedFindings.add(index); });
    return { path: normalizedPath, operation: "modify", summary: file.summary.trim(), diff, findingIndexes: [...new Set(indexes)] };
  });
  if (new Set(files.map((file) => file.path)).size !== files.length) throw new PolicyError("Repair patch contains duplicate file paths", "SCHEMA_REJECTED");
  if (reviewDecision.findings.some((_, index) => !addressedFindings.has(index))) throw new PolicyError("Repair patch does not address every Review finding", "POLICY_DENIED");
  const normalized = {
    whyNow: input.whyNow,
    expectedObservation: input.expectedObservation,
    stopIf: [...input.stopIf],
    risk: input.risk,
    status: "proposed",
    candidateId: candidate.id,
    candidateHash: candidate.candidateHash,
    expectedHead: source.expectedHead,
    reviewDecisionHash: expectedReviewHash,
    files,
    expectedTests: [...input.expectedTests],
    risks: [...(input.risks || [])],
  };
  const expectedHash = codePatchHash(normalized);
  if (input.codePatchHash && input.codePatchHash !== expectedHash) throw new PolicyError("Repair patch hash does not match its contents", "STALE_REVISION");
  return { ...normalized, codePatchHash: expectedHash };
}

export function createServer(store = new SitePilotStore(), auth = {}, evidence = new EvidenceStore(), registry = new BlockRegistry(), codeAtlas = null, payload = null, quality = null, generation = null, grants = new GrantStore(), payloadBuild = null, intake = null, modelAdapterFactory = createOpenAICompatibleIntakeAdapter, agentModelRuntimeFactory = createPiModelRuntime, agentToolJournal = null) {
  intake = intake || createIntakeAdapterFromEnvironment();
  const environmentIntake = intake;
  const environmentModelConfig = environmentIntake ? { baseUrl: environmentIntake.endpoint || null, model: environmentIntake.modelVersion || null, apiMode: environmentIntake.apiMode || "chat_completions", source: "server" } : null;
  let activeIntake = environmentIntake;
  let activeModelConfig = environmentModelConfig;
  let activeModelSecret = process.env.SITEPILOT_MODEL_API_KEY || null;
  const generatingRuns = new Set();
  const executingCodePatches = new Set();
  const runningAgentRuns = new Set();
  const previewSessions = new Map();
  const intakePreviews = new Map();
  const previewTtlMs = 15 * 60 * 1000;
  const apiToken = auth.apiToken ?? process.env.SITEPILOT_API_TOKEN ?? "";
  const reviewerToken = auth.reviewerToken ?? process.env.SITEPILOT_REVIEW_TOKEN ?? "";
  const l2Token = auth.l2Token ?? process.env.SITEPILOT_L2_TOKEN ?? "";
  const reviewerId = auth.reviewerId ?? process.env.SITEPILOT_REVIEWER_ID ?? "";
  const validToken = (provided, expected) => {
    if (typeof provided !== "string" || !provided.startsWith("Bearer ")) return false;
    const actual = Buffer.from(provided.slice(7));
    const wanted = Buffer.from(expected);
    return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
  };
  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  const readJson = async (req) => {
    let text = "";
    for await (const chunk of req) {
      text += chunk;
      if (text.length > 1024 * 1024) throw new Error("request too large");
    }
    return text ? JSON.parse(text) : {};
  };
  const latestCandidate = (run) => run?.candidateIds?.length ? store.candidates.get(run.candidateIds.at(-1)) : null;
  const generationWorkspace = (run, designId) => path.resolve(generation.worktreeRoot, run.id, run.candidateIds?.length ? designId : "");
  const codePatchWorkspace = (run, candidate, patch) => {
    if (!generation?.worktreeRoot) throw new PolicyError("Candidate patch execution is not configured", "GENERATION_NOT_CONFIGURED");
    const root = path.resolve(generation.worktreeRoot);
    const target = path.resolve(root, run.id, `patch-${candidate.id}-${patch.codePatchHash.slice(0, 16)}`);
    if (!target.startsWith(`${root}${path.sep}`)) throw new PolicyError("CodePatch worktree escapes configured root", "POLICY_DENIED");
    return target;
  };
  const inspectCandidateSource = async (run, candidate) => {
    if (!generation?.worktreeRoot || !path.isAbsolute(generation.worktreeRoot)) throw new PolicyError("Candidate source inspection is not configured", "GENERATION_NOT_CONFIGURED");
    const declaredFiles = candidate.codeArtifact?.files;
    if (!Array.isArray(declaredFiles) || declaredFiles.length < 1 || declaredFiles.length > 200) throw new PolicyError("Candidate source manifest is invalid", "SOURCE_PACKAGE_REQUIRED");
    const configuredRunRoot = path.resolve(generation.worktreeRoot, run.id);
    const workspace = candidate.codeArtifact?.workspace ? path.resolve(candidate.codeArtifact.workspace) : generationWorkspace(run, candidate.designDraftId);
    if (workspace !== generationWorkspace(run, candidate.designDraftId) && !workspace.startsWith(`${configuredRunRoot}${path.sep}`)) throw new PolicyError("Candidate source workspace is not the server-owned run workspace", "POLICY_DENIED");
    const root = await fs.realpath(workspace);
    const configuredRoot = await fs.realpath(generation.worktreeRoot);
    if (!root.startsWith(`${configuredRoot}${path.sep}`)) throw new PolicyError("Candidate source resolves outside the configured worktree root", "POLICY_DENIED");
    const normalizedFiles = [...new Set(declaredFiles)].map((file) => {
      if (typeof file !== "string" || !file.trim() || path.isAbsolute(file) || file.split(/[\\/]/).includes("..") || /(^|[\\/])(?:\.env(?:\.|$)|\.git(?:[\\/]|$)|node_modules(?:[\\/]|$)|secrets?(?:[\\/]|$))/i.test(file)) throw new PolicyError("Candidate source manifest contains an unsafe path", "POLICY_DENIED");
      return file.replaceAll("\\", "/");
    }).sort();
    if (normalizedFiles.length !== declaredFiles.length) throw new PolicyError("Candidate source manifest contains duplicate paths", "SCHEMA_REJECTED");
    const manifest = [];
    let totalBytes = 0;
    for (const file of normalizedFiles) {
      const target = path.resolve(root, file);
      if (!target.startsWith(`${root}${path.sep}`)) throw new PolicyError("Candidate source path escapes its worktree", "POLICY_DENIED");
      const actual = await fs.realpath(target);
      if (!actual.startsWith(`${root}${path.sep}`)) throw new PolicyError("Candidate source path resolves outside its worktree", "POLICY_DENIED");
      const stat = await fs.stat(actual);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new PolicyError(`Candidate source file is not a bounded regular file: ${file}`, "SOURCE_INVALID");
      totalBytes += stat.size;
      if (totalBytes > 25 * 1024 * 1024) throw new PolicyError("Candidate source package exceeds the inspection limit", "SOURCE_TOO_LARGE");
      const content = await fs.readFile(actual);
      if (content.includes(0)) throw new PolicyError(`Candidate source contains a binary file: ${file}`, "SOURCE_INVALID");
      manifest.push({ path: file, size: content.length, sha256: crypto.createHash("sha256").update(content).digest("hex") });
    }
    const expectedHead = crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    return {
      sourceFiles: manifest.map((item) => item.path),
      sourceManifest: manifest,
      expectedHead,
      async assertCurrent() {
        const current = await inspectCandidateSource(run, candidate);
        if (current.expectedHead !== expectedHead) throw new PolicyError("Candidate source changed during Coding review", "STALE_REVISION");
        return expectedHead;
      },
      async readFiles(paths = []) {
        const current = await inspectCandidateSource(run, candidate);
        if (current.expectedHead !== expectedHead) throw new PolicyError("Candidate source changed during Coding inspection", "STALE_REVISION");
        if (!Array.isArray(paths) || paths.length < 1 || paths.length > 5 || paths.some((file) => !current.sourceFiles.includes(file))) throw new PolicyError("Coding requested files outside the current candidate source manifest", "POLICY_DENIED");
        let returnedBytes = 0;
        const files = [];
        for (const file of [...new Set(paths)]) {
          const target = path.resolve(root, file);
          const actual = await fs.realpath(target);
          if (!actual.startsWith(`${root}${path.sep}`)) throw new PolicyError("Candidate source path resolves outside its worktree", "POLICY_DENIED");
          const bytes = await fs.readFile(actual);
          returnedBytes += bytes.length;
          if (bytes.length > 64 * 1024 || returnedBytes > 128 * 1024) throw new PolicyError("Coding source read exceeds the text inspection limit", "SOURCE_TOO_LARGE");
          const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
          if (current.sourceManifest.find((item) => item.path === file)?.sha256 !== sha256) throw new PolicyError("Candidate source changed while it was being read", "STALE_REVISION");
          const content = bytes.toString("utf8");
          if (content.includes("\uFFFD") || /-----BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY-----|AKIA[0-9A-Z]{16}|(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']{12,}/i.test(content)) throw new PolicyError(`Candidate source may contain binary data or a secret: ${file}`, "SOURCE_SENSITIVE");
          files.push({ path: file, sha256, content });
        }
        return files;
      },
    };
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && ["/studio", "/studio.css", "/studio-delivery.css", "/studio.js", "/design-preview.js"].includes(url.pathname)) {
        const file = { "/studio": "studio.html", "/studio.css": "studio.css", "/studio-delivery.css": "studio-delivery.css", "/studio.js": "studio.js", "/design-preview.js": "design-preview.js" }[url.pathname];
        const type = file.endsWith("html") ? "text/html" : file.endsWith("css") ? "text/css" : "text/javascript";
        const content = await fs.readFile(new URL(`./${file}`, import.meta.url));
        res.writeHead(200, { "content-type": `${type}; charset=utf-8`, "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' data:; connect-src 'self'; img-src 'self'; frame-src blob:; base-uri 'none'; form-action 'self'", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        return res.end(content);
      }
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { status: "ok", service: "sitepilot" });
      if (apiToken.length < 32 || reviewerToken.length < 32 || !reviewerId || apiToken === reviewerToken) return send(res, 503, { code: "AUTH_NOT_CONFIGURED", message: "Distinct 32-character API and reviewer credentials are required" });
      const authorization = req.headers.authorization || "";
      const reviewMatch = url.pathname.match(/^\/candidates\/([^/]+)\/review$/);
      const reworkMatch = url.pathname.match(/^\/candidates\/([^/]+)\/rework$/);
      const reworkExecutionMatch = url.pathname.match(/^\/candidates\/([^/]+)\/rework-execution$/);
      const contentApprovalMatch = url.pathname.match(/^\/candidates\/([^/]+)\/content-approval$/);
      const codePatchApprovalMatch = url.pathname.match(/^\/candidates\/([^/]+)\/code-patch-approval$/);
      const codePatchExecutionMatch = url.pathname.match(/^\/candidates\/([^/]+)\/code-patch-execution$/);
      const blockReviewMatch = url.pathname.match(/^\/components\/([^/]+)\/review$/);
      const generateMatch = url.pathname.match(/^\/runs\/([^/]+)\/generate$/);
      const grantMatch = url.pathname.match(/^\/runs\/([^/]+)\/grants$/);
      const grantRevokeMatch = url.pathname.match(/^\/grants\/([^/]+)\/revoke$/);
      const payloadPrepareMatch = url.pathname.match(/^\/runs\/([^/]+)\/payload-prepare$/);
      const payloadBuildMatch = url.pathname.match(/^\/runs\/([^/]+)\/payload-build$/);
      const candidatePreviewMatch = url.pathname.match(/^\/candidates\/([^/]+)\/preview$/);
      const payloadPlanMatch = url.pathname.match(/^\/candidates\/([^/]+)\/payload-plan$/);
      const previewMatch = url.pathname.match(/^\/previews\/([^/]+)$/);
      if ((generateMatch || codePatchExecutionMatch || reworkExecutionMatch) && (l2Token.length < 32 || l2Token === apiToken || l2Token === reviewerToken)) return send(res, 503, { code: "L2_NOT_CONFIGURED" });
      if ((payloadPrepareMatch || payloadBuildMatch) && (l2Token.length < 32 || l2Token === apiToken || l2Token === reviewerToken)) return send(res, 503, { code: "L2_NOT_CONFIGURED" });
      const requiredToken = req.method === "POST" && (reviewMatch || reworkMatch || contentApprovalMatch || codePatchApprovalMatch || blockReviewMatch || grantMatch || grantRevokeMatch) ? reviewerToken : req.method === "POST" && (generateMatch || codePatchExecutionMatch || reworkExecutionMatch || payloadPrepareMatch || payloadBuildMatch) ? l2Token : apiToken;
      if (!validToken(authorization, requiredToken)) return send(res, 401, { code: "UNAUTHORIZED", message: "Valid SitePilot credential required" });
      if (req.method === "GET" && url.pathname === "/model/status") {
        return send(res, 200, activeIntake ? { configured: true, model: activeModelConfig?.model || activeIntake.modelVersion, baseUrl: activeModelConfig?.baseUrl || activeIntake.endpoint || null, apiMode: activeModelConfig?.apiMode || activeIntake.apiMode || "chat_completions", keyConfigured: true, source: activeModelConfig?.source || "server" } : { configured: false, model: null, baseUrl: null, apiMode: null, keyConfigured: false, source: null });
      }
      if (req.method === "GET" && url.pathname === "/payload/status") {
        const status = { configured: Boolean(payload), connection: payload ? "unchecked" : "not_configured", sandboxOnly: true, writeMode: "draft_only", publishAllowed: false };
        if (payload && typeof payload.checkConnection === "function") {
          try {
            const result = await payload.checkConnection();
            status.connection = ["connected", "rejected", "unreachable"].includes(result?.state) ? result.state : "unreachable";
            status.checkedAt = new Date().toISOString();
          } catch {
            status.connection = "unreachable";
            status.checkedAt = new Date().toISOString();
          }
        }
        return send(res, 200, status);
      }
      if (req.method === "POST" && url.pathname === "/model/test") {
        const config = modelConfigFromInput(await readJson(req));
        const candidate = modelAdapterFactory(config);
        try { await candidate.testConnection(); }
        catch (error) { return send(res, error.status || 502, { code: error.code || "MODEL_TEST_FAILED", message: error.message || "Model connection failed" }); }
        return send(res, 200, { ok: true, model: config.model, baseUrl: config.baseUrl, apiMode: config.apiMode });
      }
      if (req.method === "POST" && url.pathname === "/model/config") {
        const input = await readJson(req);
        if (input.clear === true) {
          activeIntake = environmentIntake;
          activeModelConfig = environmentModelConfig;
          activeModelSecret = process.env.SITEPILOT_MODEL_API_KEY || null;
          return send(res, 200, { configured: Boolean(activeIntake), cleared: true, model: activeModelConfig?.model || null, baseUrl: activeModelConfig?.baseUrl || null, apiMode: activeModelConfig?.apiMode || null, source: activeModelConfig?.source || null });
        }
        const config = modelConfigFromInput(input);
        activeIntake = modelAdapterFactory(config);
        activeModelConfig = { baseUrl: config.baseUrl, model: config.model, apiMode: config.apiMode, source: "studio-memory" };
        activeModelSecret = config.apiKey;
        return send(res, 200, { configured: true, model: config.model, baseUrl: config.baseUrl, apiMode: config.apiMode, keyConfigured: true, persisted: false });
      }
      if (req.method === "POST" && url.pathname === "/intake/preview") {
        if (!activeIntake || typeof activeIntake.analyze !== "function") return send(res, 503, { code: "MODEL_NOT_CONFIGURED", message: "Configure a model provider in Studio before analyzing requirements" });
        try {
          const input = await readJson(req);
          const requirementBrief = await activeIntake.analyze(input.requestText);
          const intakeId = "intake_" + crypto.randomUUID().replaceAll("-", "");
          const expiresAt = Date.now() + previewTtlMs;
          for (const [key, value] of intakePreviews) if (value.expiresAt <= Date.now()) intakePreviews.delete(key);
          if (intakePreviews.size >= 100) return send(res, 429, { code: "INTAKE_PREVIEW_LIMIT", message: "Too many unconfirmed requirement previews" });
          intakePreviews.set(intakeId, { requestText: input.requestText.trim(), requirementBrief, expiresAt });
          return send(res, 200, { intakeId, expiresAt: new Date(expiresAt).toISOString(), requirementBrief });
        } catch (error) {
          return send(res, error.status || 422, { code: error.code || "INTAKE_FAILED", message: error.status ? error.message : "Requirement analysis failed" });
        }
      }
      if (req.method === "POST" && url.pathname === "/intake/confirm") {
        const input = await readJson(req);
        const preview = intakePreviews.get(input.intakeId);
        if (!preview || preview.expiresAt <= Date.now()) {
          intakePreviews.delete(input.intakeId);
          return send(res, 404, { code: "INTAKE_PREVIEW_EXPIRED" });
        }
        const supplemental = input.supplemental && typeof input.supplemental === "object" ? input.supplemental : {};
        const manualText = (key, fallback = "") => {
          if (supplemental[key] === undefined || supplemental[key] === "") return fallback;
          if (typeof supplemental[key] !== "string" || supplemental[key].length > 500) throw new PolicyError("Invalid supplemental field: " + key, "INVALID_INPUT");
          return supplemental[key].trim();
        };
        const manualList = (key, fallback) => {
          if (supplemental[key] === undefined || supplemental[key] === "") return fallback;
          if (!Array.isArray(supplemental[key]) || supplemental[key].length > 20 || supplemental[key].some((item) => typeof item !== "string" || item.length > 240)) {
            throw new PolicyError("Invalid supplemental field: " + key, "INVALID_INPUT");
          }
          return supplemental[key].map((item) => item.trim()).filter(Boolean);
        };
        const brief = preview.requirementBrief;
        const industry = manualText("industry", brief.industry);
        if (!["general", "industrial", "saas"].includes(industry)) return send(res, 422, { code: "INVALID_INDUSTRY" });
        const locales = manualList("locale", brief.locales.map((item) => item.value));
        const allowedLocales = new Set(["zh-CN", "en", "en-US", "ja", "de", "fr"]);
        if (locales.some((locale) => !allowedLocales.has(locale))) return send(res, 422, { code: "UNSUPPORTED_LOCALE" });
        const project = store.createProject({
          goal: preview.requestText,
          initialRequest: preview.requestText,
          requirementBrief: brief,
          localeProvided: locales.length > 0,
          industry,
          audience: manualText("audience", brief.audience ? brief.audience.value : ""),
          primaryConversion: manualText("primaryConversion", brief.primaryConversion ? brief.primaryConversion.value : ""),
          locale: locales.length ? locales : undefined,
          brandConstraints: manualList("brandConstraints", brief.brandConstraints.map((item) => item.value)),
          contentAvailable: manualList("contentAvailable", brief.contentAvailable.map((item) => item.value)),
        });
        const run = store.createRun(project.id, { modelVersion: activeIntake.modelVersion || "configured-model" });
        run.strategy = applyRequirementBrief(planStrategy(project), brief, project);
        run.payloadSchema = planPayloadSchema({ projectId: project.id, strategy: run.strategy, locales: project.locale });
        run.checkpoint = "strategy_ready";
        store.event(run.id, "strategy.created", { strategy: run.strategy.strategy, source: "natural-language-intake" });
        store.persist?.();
        intakePreviews.delete(input.intakeId);
        return send(res, 201, { project, run });
      }
      const agentRunMatch = url.pathname.match(/^\/runs\/([^/]+)\/agent$/);
      if (req.method === "GET" && agentRunMatch) {
        const run = store.runs.get(agentRunMatch[1]);
        if (!run) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        const agentState = run.agentState || null;
        const roleDecisions = (store.audit || [])
          .filter((event) => event.runId === run.id && event.type === "agent.decision" && event.data?.role !== "Supervisor")
          .map(({ data }) => ({
            agentRunId: data.agentRunId,
            role: data.role,
            action: data.action,
            whyNow: data.whyNow,
            expectedObservation: data.expectedObservation,
            stopIf: data.stopIf || [],
            risk: data.risk,
            at: data.at,
          }));
        const decisions = [...(agentState?.decisions || []), ...roleDecisions]
          .sort((left, right) => Date.parse(left.at || left.createdAt) - Date.parse(right.at || right.createdAt));
        return send(res, 200, {
          runId: run.id,
          checkpoint: run.checkpoint,
          agentState,
          decisions,
          artifacts: store.artifactsForRun?.(run.id) || [],
        });
      }
      if (req.method === "POST" && agentRunMatch) {
        if (!activeModelConfig?.baseUrl || !activeModelConfig?.model || !activeModelSecret) return send(res, 503, { code: "MODEL_NOT_CONFIGURED" });
        const run = store.runs.get(agentRunMatch[1]);
        if (!run) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        if (runningAgentRuns.has(run.id)) return send(res, 409, { code: "AGENT_RUN_ALREADY_ACTIVE" });
        const input = await readJson(req);
        const hasRepository = typeof input.repository === "string" && input.repository.trim().length > 0;
        const hasCommit = typeof input.expectedCommit === "string" && /^[a-f0-9]{40}$/i.test(input.expectedCommit);
        if (hasRepository !== hasCommit) return send(res, 422, { code: "INVALID_INPUT", message: "repository and full expectedCommit must be supplied together" });
        if (hasRepository && (!codeAtlas || typeof codeAtlas.search !== "function")) return send(res, 503, { code: "CODEATLAS_NOT_CONFIGURED" });
        if (hasRepository && codeAtlas.repositories instanceof Set && !codeAtlas.repositories.has(input.repository.trim())) return send(res, 403, { code: "REPOSITORY_DENIED" });
        let contentCms = null;
        let review = null;
        if (input.phase !== undefined && !["content", "coding", "repair", "review"].includes(input.phase)) return send(res, 422, { code: "INVALID_AGENT_PHASE" });
        if (input.phase === "content") {
          if (typeof input.candidateId !== "string") return send(res, 422, { code: "CANDIDATE_REQUIRED" });
          const candidate = store.candidates.get(input.candidateId);
          if (!candidate || candidate.runId !== run.id) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
          if (!candidate.build?.passed) return send(res, 422, { code: "BUILD_GATE_REQUIRED" });
          if (!candidate.designDraftId || candidate.designDraftId !== run.designDraftId) return send(res, 409, { code: "STALE_DESIGN_REVISION" });
          if (!run.strategy || !run.research) return send(res, 422, { code: "STRATEGY_RESEARCH_REQUIRED" });
          if (!run.pagePlan) return send(res, 422, { code: "PAGE_PLAN_REQUIRED" });
          const designDraft = candidate.designDraftId ? store.designs.get(candidate.designDraftId) : null;
          if (!designDraft) return send(res, 422, { code: "DESIGN_DRAFT_REQUIRED" });
          const snapshot = evidence.snapshot(run.projectId);
          const sourceById = new Map(snapshot.sources.map((source) => [source.id, source]));
          const recordById = new Map(snapshot.records.filter((record) => record.status === "active").map((record) => [record.id, record]));
          const claims = snapshot.claims.filter((claim) => claim.status === "supported")
            .map((claim) => ({ claim, records: claim.evidenceIds.map((id) => recordById.get(id)).filter(Boolean) }))
            .filter(({ claim, records }) => claim.evidenceIds.length > 0 && records.length === claim.evidenceIds.length && records.every((record) => sourceById.get(record.sourceId)?.kind === "client"))
            .slice(0, 30);
          const allowedClaimRefs = claims.map(({ claim }) => claim.id);
          const customerFacts = claims.map(({ claim, records }) => ({
            claimId: claim.id,
            statement: claim.statement.slice(0, 500),
            evidence: records.slice(0, 3).map((record) => ({ quote: record.quote.slice(0, 1200), locator: record.locator.slice(0, 300), version: String(record.sourceVersion).slice(0, 120) })),
          }));
          contentCms = {
            candidateId: candidate.id,
            candidateHash: candidate.candidateHash,
            candidate,
            designDraft,
            pagePlan: run.pagePlan,
            payloadSchema: run.payloadSchema,
            customerFacts,
            allowedClaimRefs,
            contentOnly: true,
          };
        }
        let coding = null;
        if (input.phase === "coding") {
          if (typeof input.candidateId !== "string") return send(res, 422, { code: "CANDIDATE_REQUIRED" });
          const candidate = store.candidates.get(input.candidateId);
          if (!candidate || candidate.runId !== run.id) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
          if (latestCandidate(run)?.id !== candidate.id) return send(res, 409, { code: "STALE_CANDIDATE" });
          if (run.codingPatch?.candidateHash === candidate.candidateHash && run.codingPatch?.designHash === candidate.revision?.designHash) return send(res, 409, { code: "CODE_PATCH_ALREADY_PROPOSED" });
          if (!candidate.build?.passed) return send(res, 422, { code: "BUILD_GATE_REQUIRED" });
          if (!candidate.designDraftId || candidate.designDraftId !== run.designDraftId) return send(res, 409, { code: "STALE_DESIGN_REVISION" });
          if (!run.strategy || !run.research) return send(res, 422, { code: "STRATEGY_RESEARCH_REQUIRED" });
          if (!run.pagePlan) return send(res, 422, { code: "PAGE_PLAN_REQUIRED" });
          const designDraft = store.designs.get(candidate.designDraftId);
          if (!designDraft) return send(res, 422, { code: "DESIGN_DRAFT_REQUIRED" });
          const contentModel = candidate.contentModel || (run.contentModel?.candidateId === candidate.id ? run.contentModel : null);
          const expectedContentHash = contentModel ? contentModelHash(contentModel) : null;
          if (!contentModel || contentModel.status !== "proposed" || !contentModel.contentHash || contentModel.contentHash !== expectedContentHash) return send(res, 422, { code: "CONTENT_MODEL_REQUIRED" });
          const approval = candidate.contentApproval;
          if (!approval || approval.candidateId !== candidate.id || approval.candidateHash !== candidate.candidateHash || approval.designDraftId !== designDraft.id || approval.designHash !== designDraft.designHash || approval.contentHash !== expectedContentHash) return send(res, 422, { code: "CONTENT_APPROVAL_REQUIRED" });
          if (!Array.isArray(candidate.codeArtifact?.files) || !candidate.codeArtifact.files.length) return send(res, 422, { code: "SOURCE_PACKAGE_REQUIRED" });
          const source = await inspectCandidateSource(run, candidate);
          coding = {
            codingOnly: true,
            candidateId: candidate.id,
            candidateHash: candidate.candidateHash,
            candidate,
            designDraft,
            designDraftId: designDraft.id,
            designHash: designDraft.designHash,
            contentModel,
            pagePlanHash: run.pagePlan.sourceManifestHash || null,
            expectedHead: source.expectedHead,
            sourceId: `candidate:${candidate.id}`,
            sourceFiles: source.sourceFiles,
            sourceManifest: source.sourceManifest,
            assertCurrent: source.assertCurrent,
            readFiles: source.readFiles,
            sourceRefs: Array.isArray(candidate.sourceRefs) ? candidate.sourceRefs.map((item) => typeof item === "string" ? item : ({ evidenceId: item?.evidenceId || item?.id || null, repository: item?.repository || null, commit: item?.commit || null, path: item?.path || null, licenseReference: item?.licenseReference || null })).filter((item) => typeof item === "string" || item.evidenceId) : [],
            fileCount: source.sourceFiles.length,
          };
        }
        let repair = null;
        if (input.phase === "repair") {
          if (typeof input.candidateId !== "string") return send(res, 422, { code: "CANDIDATE_REQUIRED" });
          const candidate = store.candidates.get(input.candidateId);
          if (!candidate || candidate.runId !== run.id) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
          if (latestCandidate(run)?.id !== candidate.id) return send(res, 409, { code: "STALE_CANDIDATE" });
          const cycle = run.reviewCycle;
          if (!cycle || cycle.status !== "awaiting_repair" || cycle.parentCandidateId !== candidate.id) return send(res, 422, { code: "REPAIR_NOT_READY" });
          const decision = candidate.independentReview;
          if (!decision || decision.status !== "changes_requested" || decision.candidateId !== candidate.id || decision.candidateHash !== candidate.candidateHash) return send(res, 422, { code: "REVIEW_CHANGES_REQUIRED" });
          const { decisionHash: storedDecisionHash, ...decisionContent } = decision;
          const expectedDecisionHash = cycle.reviewDecisionHash || storedDecisionHash || reviewDecisionHash(decisionContent);
          if (expectedDecisionHash !== reviewDecisionHash(decisionContent)) return send(res, 409, { code: "REVIEW_DECISION_CHANGED" });
          if (cycle.reviewDecisionHash && cycle.reviewDecisionHash !== expectedDecisionHash) return send(res, 409, { code: "STALE_REVISION" });
          if (!candidate.build?.passed) return send(res, 422, { code: "BUILD_GATE_REQUIRED" });
          if (!candidate.designDraftId || candidate.designDraftId !== run.designDraftId) return send(res, 409, { code: "STALE_DESIGN_REVISION" });
          if (!run.strategy || !run.research || !run.pagePlan) return send(res, 422, { code: "STRATEGY_RESEARCH_REQUIRED" });
          const designDraft = store.designs.get(candidate.designDraftId);
          if (!designDraft) return send(res, 422, { code: "DESIGN_DRAFT_REQUIRED" });
          if (!Array.isArray(candidate.codeArtifact?.files) || !candidate.codeArtifact.files.length) return send(res, 422, { code: "SOURCE_PACKAGE_REQUIRED" });
          const source = await inspectCandidateSource(run, candidate);
          repair = {
            repairOnly: true,
            candidateId: candidate.id,
            candidateHash: candidate.candidateHash,
            candidate,
            designDraft,
            designDraftId: designDraft.id,
            designHash: designDraft.designHash,
            pagePlanHash: run.pagePlan.sourceManifestHash || null,
            contentModel: candidate.contentModel || (run.contentModel?.candidateId === candidate.id ? run.contentModel : null),
            repairDecision: decisionContent,
            repairDecisionHash: expectedDecisionHash,
            reviewDecisionHash: expectedDecisionHash,
            expectedHead: source.expectedHead,
            sourceId: `candidate:${candidate.id}`,
            sourceFiles: source.sourceFiles,
            sourceManifest: source.sourceManifest,
            assertCurrent: async () => {
              const currentHead = await source.assertCurrent();
              const currentCandidate = store.candidates.get(candidate.id);
              if (!currentCandidate || currentCandidate.candidateHash !== candidate.candidateHash || latestCandidate(run)?.id !== candidate.id || run.reviewCycle?.reviewDecisionHash !== expectedDecisionHash) throw new PolicyError("Candidate or ReviewDecision changed during repair Coding", "STALE_REVISION");
              return currentHead;
            },
            readFiles: source.readFiles,
            sourceRefs: Array.isArray(candidate.sourceRefs) ? candidate.sourceRefs.map((item) => typeof item === "string" ? item : ({ evidenceId: item?.evidenceId || item?.id || null, repository: item?.repository || null, commit: item?.commit || null, path: item?.path || null, licenseReference: item?.licenseReference || null })).filter((item) => typeof item === "string" || item.evidenceId) : [],
            fileCount: source.sourceFiles.length,
          };
        }
        if (input.phase === "review") {
          if (typeof input.candidateId !== "string") return send(res, 422, { code: "CANDIDATE_REQUIRED" });
          const candidate = store.candidates.get(input.candidateId);
          if (!candidate || candidate.runId !== run.id) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
          if (latestCandidate(run)?.id !== candidate.id) return send(res, 409, { code: "STALE_CANDIDATE" });
          if (!candidate.quality?.passed) return send(res, 422, { code: "QUALITY_GATE_REQUIRED" });
          if (!candidate.quality.reportHash || typeof candidate.quality.reportHash !== "string") return send(res, 422, { code: "QUALITY_REPORT_REQUIRED" });
          if (run.reviewDecision?.candidateId === candidate.id && run.reviewDecision?.candidateHash === candidate.candidateHash && run.reviewDecision?.qualityReportHash === candidate.quality.reportHash) return send(res, 409, { code: "REVIEW_ALREADY_COMPLETED" });
          if (!Array.isArray(candidate.codeArtifact?.files) || !candidate.codeArtifact.files.length) return send(res, 422, { code: "SOURCE_PACKAGE_REQUIRED" });
          const source = await inspectCandidateSource(run, candidate);
          review = {
            reviewOnly: true,
            candidateId: candidate.id,
            candidateHash: candidate.candidateHash,
            candidate,
            quality: candidate.quality,
            qualityReportHash: candidate.quality.reportHash,
            sourceId: `candidate:${candidate.id}`,
            sourceFiles: source.sourceFiles,
            sourceManifest: source.sourceManifest,
            assertCurrent: async () => {
              const currentHead = await source.assertCurrent();
              const currentCandidate = store.candidates.get(candidate.id);
              if (!currentCandidate || currentCandidate.candidateHash !== candidate.candidateHash || !currentCandidate.quality?.passed || currentCandidate.quality.reportHash !== candidate.quality.reportHash) throw new PolicyError("Candidate or QA report changed during Review", "STALE_REVISION");
              return currentHead;
            },
            readFiles: source.readFiles,
          };
        }
        runningAgentRuns.add(run.id);
        try {
          const modelRuntime = agentModelRuntimeFactory({ ...activeModelConfig, apiKey: activeModelSecret });
          const agentRuntime = new SitePilotAgentRuntime({ modelRuntime, store });
          const result = await runCreationSupervisor({ run, runtime: agentRuntime, store, registry, codeAtlas, toolRuntime: createAgentToolRuntime(store, agentToolJournal), repository: hasRepository ? input.repository.trim() : null, expectedCommit: hasCommit ? input.expectedCommit.toLowerCase() : null, grant: { level: "L0" }, contentCms, coding: coding || repair, review });
          if (run.strategy) run.payloadSchema = planPayloadSchema({ projectId: run.projectId, strategy: run.strategy, locales: run.strategy.locales || run.inputSnapshot.locale });
          const returnedContentModel = result.contentModel || (contentCms?.candidate ? run.contentModel : null);
          if (returnedContentModel) {
            const model = returnedContentModel.status === "proposed"
              ? { ...returnedContentModel, contentHash: contentModelHash(returnedContentModel) }
              : returnedContentModel;
            run.contentModel = model;
            if (contentCms?.candidate) contentCms.candidate.contentModel = model;
            result.contentModel = model;
          }
          if (repair && result.codePatch?.status === "proposed") {
            const generatedRepair = normalizeRepairPatch({
              whyNow: result.codePatch.whyNow,
              expectedObservation: result.codePatch.expectedObservation,
              stopIf: result.codePatch.stopIf,
              risk: result.codePatch.risk,
              status: result.codePatch.status,
              candidateId: result.codePatch.candidateId,
              candidateHash: result.codePatch.candidateHash,
              expectedHead: result.codePatch.expectedHead,
              reviewDecisionHash: repair.reviewDecisionHash,
              files: result.codePatch.files.map((file) => ({ path: file.path, operation: file.operation, summary: file.summary, diff: file.diff, findingIndexes: file.findingIndexes })),
              expectedTests: result.codePatch.expectedTests,
              risks: result.codePatch.risks,
            }, { candidate: repair.candidate, source: { expectedHead: repair.expectedHead, sourceFiles: repair.sourceFiles }, reviewDecision: repair.repairDecision, expectedReviewHash: repair.reviewDecisionHash });
            if (run.repairPatch && run.repairPatch.codePatchHash !== generatedRepair.codePatchHash) throw new PolicyError("A different repair patch is already proposed", "REPAIR_PATCH_ALREADY_PROPOSED");
            run.repairPatch = Object.freeze(generatedRepair);
            run.checkpoint = "repair_ready_for_execution";
            store.event(run.id, "coding.repair_patch.proposed", { candidateId: repair.candidateId, candidateHash: repair.candidateHash, reviewDecisionHash: repair.reviewDecisionHash, patchHash: generatedRepair.codePatchHash });
            result.repairPatch = generatedRepair;
          }
          store.persist?.();
          return send(res, 200, result);
        } finally {
          runningAgentRuns.delete(run.id);
        }
      }
      if (req.method === "GET" && url.pathname === "/projects") return send(res, 200, { projects: [...store.projects.values()] });
      const projectRunsMatch = url.pathname.match(/^\/projects\/([^/]+)\/runs$/);
      if (req.method === "GET" && projectRunsMatch) return send(res, 200, { runs: [...store.runs.values()].filter((run) => run.projectId === projectRunsMatch[1]) });
      if (req.method === "GET" && url.pathname === "/candidates") return send(res, 200, { candidates: [...store.candidates.values()] });
      if (req.method === "POST" && candidatePreviewMatch) {
        if (!generation?.worktreeRoot) return send(res, 503, { code: "GENERATION_NOT_CONFIGURED" });
        const candidate = store.candidates.get(candidatePreviewMatch[1]);
        if (!candidate) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        if (!candidate.build?.passed) return send(res, 422, { code: "BUILD_GATE_REQUIRED" });
        const workspace = candidate.codeArtifact?.workspace;
        const run = store.runs.get(candidate.runId);
        const runRoot = run ? path.resolve(generation.worktreeRoot, run.id) : null;
        const expectedWorkspace = workspace ? path.resolve(workspace) : null;
        if (!expectedWorkspace || !runRoot || (expectedWorkspace !== runRoot && !expectedWorkspace.startsWith(`${runRoot}${path.sep}`))) throw new PolicyError("Preview workspace is outside the server-owned run directory", "POLICY_DENIED");
        const active = [...previewSessions.values()].find((session) => session.candidateId === candidate.id && session.expiresAt > Date.now());
        if (active) return send(res, 200, active.public);
        const manifest = await loadPreviewManifest(expectedWorkspace);
        const expectedDesignHash = candidate.codeArtifact?.designHash || null;
        if (expectedDesignHash && manifest.design?.designHash !== expectedDesignHash) throw new PolicyError("Preview manifest design hash does not match candidate", "STALE_REVISION");
        await validateGeneratedCandidate({ worktreeRoot: expectedWorkspace, expectedDesignHash: expectedDesignHash || undefined });
        const preview = new LocalPreviewServer({ plan: manifest });
        const address = await preview.listen();
        const sessionId = `preview_${crypto.randomUUID().replaceAll("-", "")}`;
        const expiresAt = Date.now() + previewTtlMs;
        const publicSession = Object.freeze({ sessionId, candidateId: candidate.id, candidateHash: candidate.candidateHash, designDraftId: candidate.designDraftId || null, designHash: manifest.design?.designHash || null, baseUrl: `http://${address.host}:${address.port}/`, expiresAt: new Date(expiresAt).toISOString(), localOnly: true, writesAllowed: false });
        try { quality?.preview?.registerPreview?.({ id: sessionId, baseUrl: publicSession.baseUrl, candidateHash: candidate.candidateHash, expiresAt }); }
        catch (error) { await preview.close(); throw error; }
        const timer = setTimeout(() => { const session = previewSessions.get(sessionId); previewSessions.delete(sessionId); quality?.preview?.unregisterPreview?.(sessionId); session?.preview.close().catch(() => {}); }, previewTtlMs);
        timer.unref?.();
        previewSessions.set(sessionId, { sessionId, candidateId: candidate.id, expiresAt, preview, public: publicSession, timer });
        store.event(candidate.runId, "candidate.preview.created", { candidateId: candidate.id, sessionId, expiresAt: publicSession.expiresAt });
        return send(res, 201, publicSession);
      }
      if (req.method === "DELETE" && previewMatch) {
        const session = previewSessions.get(previewMatch[1]);
        if (!session) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        previewSessions.delete(session.sessionId);
        clearTimeout(session.timer);
        quality?.preview?.unregisterPreview?.(session.sessionId);
        await session.preview.close();
        return send(res, 200, { sessionId: session.sessionId, closed: true });
      }
      if (req.method === "POST" && payloadPlanMatch) {
        const candidate = store.candidates.get(payloadPlanMatch[1]);
        if (!candidate) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        const run = store.runs.get(candidate.runId);
        if (!run?.strategy) return send(res, 422, { code: "STRATEGY_REQUIRED" });
        const design = candidate.designDraftId ? store.designs.get(candidate.designDraftId) : null;
        if (candidate.designDraftId && !design) return send(res, 422, { code: "DESIGN_DRAFT_REQUIRED" });
        const input = await readJson(req);
        const plan = createPayloadDraftPlan({
          strategy: run.strategy,
          projectId: run.projectId,
          locales: input.locales || run.inputSnapshot.locale,
          contentByPage: input.contentByPage,
          designDraft: design,
          pagePlan: run.pagePlan,
        });
        return send(res, 200, { ...plan, candidateId: candidate.id, designDraftId: design?.id || null, designHash: design?.designHash || null, writesAllowed: false });
      }
      const sourceMatch = url.pathname.match(/^\/projects\/([^/]+)\/sources$/);
      if (req.method === "POST" && sourceMatch) {
        const source = evidence.registerSource({ ...(await readJson(req)), projectId: sourceMatch[1] });
        return send(res, 201, source);
      }
      const evidenceMatch = url.pathname.match(/^\/sources\/([^/]+)\/records$/);
      if (req.method === "POST" && evidenceMatch) return send(res, 201, evidence.addRecord({ ...(await readJson(req)), sourceId: evidenceMatch[1] }));
      const claimMatch = url.pathname.match(/^\/projects\/([^/]+)\/claims$/);
      if (req.method === "POST" && claimMatch) return send(res, 201, evidence.createClaim({ ...(await readJson(req)), projectId: claimMatch[1] }));
      if (req.method === "GET" && url.pathname === "/components") return send(res, 200, { registry: registry.manifest() });
      if (req.method === "POST" && url.pathname === "/components") {
        const input = await readJson(req);
        return send(res, 201, registry.register({ ...input, state: "candidate", review: undefined }));
      }
      if (req.method === "POST" && blockReviewMatch) {
        const decision = await readJson(req);
        if (decision.approved !== true) return send(res, 422, { code: "REVIEW_NOT_APPROVED" });
        return send(res, 200, registry.transition(blockReviewMatch[1], "approved", {
          reviewerId,
          licenseVerified: decision.licenseVerified === true,
          testsPassed: decision.testsPassed === true,
          notes: decision.notes || "",
        }));
      }
      if (req.method === "POST" && url.pathname === "/projects") {
        const project = store.createProject(await readJson(req));
        return send(res, 201, project);
      }
      const runMatch = url.pathname.match(/^\/projects\/([^/]+)\/runs$/);
      if (req.method === "POST" && runMatch) {
        const run = store.createRun(runMatch[1], await readJson(req));
        const project = store.projects.get(run.projectId);
        const strategy = planStrategy(project);
        run.strategy = applyRequirementBrief(strategy, project.requirementBrief, project);
        run.payloadSchema = planPayloadSchema({
          projectId: project.id,
          strategy: run.strategy,
          locales: project.locale,
        });
        run.checkpoint = "strategy_ready";
        store.event(run.id, "strategy.created", { strategy: strategy.strategy });
        return send(res, 201, run);
      }
      if (req.method === "POST" && grantMatch) {
        const run = store.runs.get(grantMatch[1]);
        if (!run) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        const input = await readJson(req);
        const tool = input.tool || "generate_candidate";
        let resource;
        let planHash;
        if (tool === "generate_candidate") {
          if (!generation?.worktreeRoot) return send(res, 503, { code: "GENERATION_NOT_CONFIGURED" });
          if (!run.pagePlan) return send(res, 422, { code: "PAGE_PLAN_REQUIRED" });
          const design = run.designDraftId ? store.designs.get(run.designDraftId) : null;
          if (!design) return send(res, 422, { code: "DESIGN_DRAFT_REQUIRED" });
          const previous = latestCandidate(run);
          if (previous?.designDraftId === design.id) return send(res, 409, { code: "CANDIDATE_ALREADY_EXISTS" });
          resource = generationWorkspace(run, design.id);
          planHash = run.pagePlan.sourceManifestHash;
        } else if (tool === "prepare_payload_template") {
          if (!payloadBuild) return send(res, 503, { code: "PAYLOAD_BUILD_NOT_CONFIGURED" });
          if (run.payloadWorktree) return send(res, 409, { code: "WORKTREE_ALREADY_EXISTS" });
          resource = path.resolve(payloadBuild.worktreeRoot, run.projectId, run.id);
          planHash = PINNED_SOURCES.payloadWebsite.commit;
        } else if (tool === "build_payload_template") {
          if (!payloadBuild || !run.payloadWorktree) return send(res, 422, { code: "PAYLOAD_WORKTREE_REQUIRED" });
          resource = path.resolve(payloadBuild.worktreeRoot, run.payloadWorktree.repositoryPathRef);
          planHash = PINNED_SOURCES.payloadWebsite.commit;
        } else if (tool === "apply_code_patch") {
          if (!generation?.worktreeRoot) return send(res, 503, { code: "GENERATION_NOT_CONFIGURED" });
          const candidate = typeof input.candidateId === "string" ? store.candidates.get(input.candidateId) : null;
          if (!candidate || candidate.runId !== run.id || latestCandidate(run)?.id !== candidate.id) return send(res, 409, { code: "STALE_CANDIDATE" });
          const patch = run.codingPatch;
          const approval = run.codePatchApproval;
          if (!patch || patch.status !== "proposed" || !approval || approval.codePatchHash !== patch.codePatchHash || approval.executionGranted !== false) return send(res, 422, { code: "CODE_PATCH_APPROVAL_REQUIRED" });
          const source = await inspectCandidateSource(run, candidate);
          if (source.expectedHead !== patch.expectedHead) return send(res, 409, { code: "STALE_SOURCE_REVISION" });
          resource = codePatchWorkspace(run, candidate, patch);
          planHash = patch.codePatchHash;
        } else if (tool === "apply_review_repair") {
          if (!generation?.worktreeRoot) return send(res, 503, { code: "GENERATION_NOT_CONFIGURED" });
          const candidate = typeof input.candidateId === "string" ? store.candidates.get(input.candidateId) : null;
          if (!candidate || candidate.runId !== run.id || latestCandidate(run)?.id !== candidate.id) return send(res, 409, { code: "STALE_CANDIDATE" });
          const cycle = run.reviewCycle;
          const patch = run.repairPatch;
          const decision = candidate.independentReview;
          if (!cycle || cycle.status !== "awaiting_repair" || cycle.parentCandidateId !== candidate.id || !patch || patch.candidateId !== candidate.id || !decision || decision.status !== "changes_requested") return send(res, 422, { code: "REPAIR_NOT_READY" });
          const { decisionHash: storedHash, ...decisionContent } = decision;
          const expectedDecisionHash = cycle.reviewDecisionHash || storedHash || reviewDecisionHash(decisionContent);
          const source = await inspectCandidateSource(run, candidate);
          if (expectedDecisionHash !== reviewDecisionHash(decisionContent) || patch.candidateHash !== candidate.candidateHash || patch.reviewDecisionHash !== expectedDecisionHash || patch.expectedHead !== source.expectedHead || codePatchHash(patch) !== patch.codePatchHash) return send(res, 409, { code: "STALE_REVISION" });
          resource = codePatchWorkspace(run, candidate, patch);
          planHash = patch.codePatchHash;
        } else return send(res, 422, { code: "TOOL_NOT_APPROVED" });
        const grant = grants.issue({ projectId: run.projectId, runId: run.id, tool, resource, planHash, expiresAt: input.expiresAt, issuedBy: reviewerId });
        store.event(run.id, "grant.issued", { grantId: grant.id, tool: grant.tool, resource: grant.resource });
        return send(res, 201, grant);
      }
      if (req.method === "POST" && grantRevokeMatch) {
        const grant = grants.revoke(grantRevokeMatch[1]);
        store.event(grant.runId, "grant.revoked", { grantId: grant.id });
        return send(res, 200, grant);
      }
      if (req.method === "POST" && payloadPrepareMatch) {
        if (!payloadBuild) return send(res, 503, { code: "PAYLOAD_BUILD_NOT_CONFIGURED" });
        const run = store.runs.get(payloadPrepareMatch[1]);
        if (!run) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        if (run.status === "superseded" || run.payloadWorktree) return send(res, 409, { code: "WORKTREE_ALREADY_EXISTS" });
        const input = await readJson(req);
        grants.consume(input.grantId, { projectId: run.projectId, runId: run.id, tool: "prepare_payload_template", resource: path.resolve(payloadBuild.worktreeRoot, run.projectId, run.id), planHash: PINNED_SOURCES.payloadWebsite.commit });
        const prepared = await payloadBuild.prepare({ projectId: run.projectId, runId: run.id, grant: { level: "L2" } });
        run.payloadWorktree = prepared;
        store.event(run.id, "payload.worktree.prepared", { worktreeId: prepared.worktreeId, templateCommit: prepared.baseCommit });
        return send(res, 201, prepared);
      }
      if (req.method === "POST" && payloadBuildMatch) {
        if (!payloadBuild) return send(res, 503, { code: "PAYLOAD_BUILD_NOT_CONFIGURED" });
        const run = store.runs.get(payloadBuildMatch[1]);
        if (!run) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        if (!run.payloadWorktree) return send(res, 422, { code: "PAYLOAD_WORKTREE_REQUIRED" });
        const input = await readJson(req);
        grants.consume(input.grantId, { projectId: run.projectId, runId: run.id, tool: "build_payload_template", resource: path.resolve(payloadBuild.worktreeRoot, run.payloadWorktree.repositoryPathRef), planHash: PINNED_SOURCES.payloadWebsite.commit });
        const report = await payloadBuild.build({ candidateId: `template_${run.id}`, worktree: run.payloadWorktree, grant: { level: "L2" } });
        run.payloadTemplateBuild = report;
        store.event(run.id, "payload.template.built", { reportHash: report.build?.reportHash, templateCommit: report.sourceCommit });
        return send(res, 200, report);
      }
      const answersMatch = url.pathname.match(/^\/runs\/([^/]+)\/answers$/);
      if (req.method === "POST" && answersMatch) {
        const run = store.runs.get(answersMatch[1]);
        if (!run) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        const answers = await readJson(req);
        if (typeof answers.locale === "string") answers.locale = answers.locale.split(",").map((value) => value.trim()).filter(Boolean);
        const revised = store.reviseRun(run.id, answers);
        const project = store.projects.get(revised.projectId);
        const revisedProject = {
          ...project,
          ...revised.inputSnapshot,
        };
        revised.strategy = applyRequirementBrief(planStrategy(revisedProject), revisedProject.requirementBrief, revisedProject);
        revised.payloadSchema = planPayloadSchema({
          projectId: project.id,
          strategy: revised.strategy,
          locales: revised.inputSnapshot.locale,
        });
        revised.checkpoint = "strategy_ready";
        store.persist?.();
        return send(res, 201, revised);
      }
      const designDraftMatch = url.pathname.match(/^\/runs\/([^/]+)\/design-drafts$/);
      if (req.method === "POST" && designDraftMatch) {
        const run = store.runs.get(designDraftMatch[1]);
        if (!run) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        if (!run.pagePlan) return send(res, 422, { code: "PAGE_PLAN_REQUIRED" });
        const input = await readJson(req);
        const draft = store.createDesignDraft(run.id, {
          ...input,
          designTokens: input.designTokens || run.strategy?.designTokens,
        });
        store.persist?.();
        return send(res, 201, draft);
      }
      const runDesignsMatch = url.pathname.match(/^\/runs\/([^/]+)\/design-drafts$/);
      if (req.method === "GET" && runDesignsMatch) {
        const run = store.runs.get(runDesignsMatch[1]);
        if (!run) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        return send(res, 200, { designs: (run.designDraftIds || []).map((id) => store.designs.get(id)).filter(Boolean) });
      }
      const designPatchMatch = url.pathname.match(/^\/design-drafts\/([^/]+)\/patches$/);
      if (req.method === "POST" && designPatchMatch) {
        const design = store.designs.get(designPatchMatch[1]);
        if (!design) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        const input = await readJson(req);
        const result = store.applyDesignPatch(design.id, { ...input, actor: input.actor || "api-operator" });
        store.persist?.();
        return send(res, 201, result);
      }
      const designPatchesMatch = url.pathname.match(/^\/design-drafts\/([^/]+)\/patches$/);
      if (req.method === "GET" && designPatchesMatch) {
        if (!store.designs.has(designPatchesMatch[1])) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        return send(res, 200, { patches: [...store.canvasPatches.values()].filter((patch) => patch.designDraftId === designPatchesMatch[1]) });
      }
      const researchMatch = url.pathname.match(/^\/runs\/([^/]+)\/research$/);
      if (req.method === "POST" && researchMatch) {
        if (!codeAtlas || typeof codeAtlas.search !== "function") return send(res, 503, { code: "CODEATLAS_NOT_CONFIGURED" });
        const run = store.runs.get(researchMatch[1]);
        if (!run) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        const input = await readJson(req);
        if (typeof input.repository !== "string" || typeof input.expectedCommit !== "string") return send(res, 422, { code: "INVALID_INPUT", message: "repository and expectedCommit are required" });
        const result = await researchComponents({ strategy: run.strategy, adapter: codeAtlas, registry, projectId: run.projectId, repository: input.repository, expectedCommit: input.expectedCommit, topK: input.topK });
        run.research = result;
        run.checkpoint = result.componentPlan.requiresReview ? "components_pending_review" : "components_approved";
        store.event(run.id, "research.completed", { repository: result.repository, commit: result.commit, evidenceCount: result.evidence.length, requiresReview: result.componentPlan.requiresReview });
        return send(res, 200, result);
      }
      const planMatch = url.pathname.match(/^\/runs\/([^/]+)\/page-plan$/);
      if (req.method === "POST" && planMatch) {
        const run = store.runs.get(planMatch[1]);
        if (!run) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        const plan = composePagePlan({ strategy: run.strategy, registry, projectId: run.projectId, runId: run.id });
        run.pagePlan = plan;
        run.checkpoint = "page_plan_ready";
        store.event(run.id, "page-plan.created", { sourceManifestHash: plan.sourceManifestHash, routeCount: plan.routes.length });
        return send(res, 200, plan);
      }
      if (req.method === "POST" && generateMatch) {
        if (!generation?.worktreeRoot || !codeAtlas || typeof codeAtlas.getCompleteFile !== "function") return send(res, 503, { code: "GENERATION_NOT_CONFIGURED" });
        const run = store.runs.get(generateMatch[1]);
        if (!run) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        if (run.status === "superseded") return send(res, 409, { code: "RUN_SUPERSEDED" });
        if (!run.pagePlan) return send(res, 422, { code: "PAGE_PLAN_REQUIRED" });
        const designDraft = run.designDraftId ? store.designs.get(run.designDraftId) : null;
        if (!designDraft) return send(res, 422, { code: "DESIGN_DRAFT_REQUIRED" });
        const previousCandidate = latestCandidate(run);
        if (previousCandidate?.designDraftId === designDraft.id || generatingRuns.has(run.id)) return send(res, 409, { code: "CANDIDATE_ALREADY_EXISTS" });
        for (const route of run.pagePlan.routes) for (const component of route.components) {
          const approved = registry.blocks.get(component.registryId);
          if (!approved || approved.state !== "approved" || approved.repository !== component.source.repository || approved.commit !== component.source.commit || approved.path !== component.source.path) return send(res, 422, { code: "COMPONENTS_NOT_APPROVED" });
        }
        const root = generationWorkspace(run, designDraft.id);
        const input = await readJson(req);
        grants.consume(input.grantId, { projectId: run.projectId, runId: run.id, tool: "generate_candidate", resource: root, planHash: run.pagePlan.sourceManifestHash });
        store.event(run.id, "grant.consumed", { grantId: input.grantId });
        generatingRuns.add(run.id);
        try {
        const worktree = new WorktreePolicy(root);
        const generated = await materializePagePlan({
          plan: run.pagePlan,
          designDraft,
          worktree,
          grant: { level: "L2" },
          sourceResolver: (source) => codeAtlas.getCompleteFile({ ...source, expectedCommit: source.commit }),
        });
        const build = await validateGeneratedCandidate({ worktreeRoot: root, expectedDesignHash: designDraft.designHash });
        const candidate = store.createCandidate(run.id, { parentId: previousCandidate?.id || null, designDraftId: designDraft.id, codeArtifact: { workspace: root, files: generated.files, head: "local-uncommitted", designDraftId: designDraft.id, designHash: designDraft.designHash }, build, sourceRefs: run.research?.evidence || [] });
        run.checkpoint = "candidate_ready";
        store.persist?.();
        return send(res, 201, { candidate, generated, build });
        } finally { generatingRuns.delete(run.id); }
      }
      if (req.method === "POST" && (reworkMatch || reworkExecutionMatch)) {
        if (!generation?.worktreeRoot) return send(res, 503, { code: "GENERATION_NOT_CONFIGURED" });
        const repairPathMatch = reworkMatch || reworkExecutionMatch;
        const candidate = store.candidates.get(repairPathMatch[1]);
        if (!candidate) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        const run = store.runs.get(candidate.runId);
        if (reworkExecutionMatch && run?.repairExecution?.candidateId === candidate.id) {
          const existing = store.candidates.get(run.repairExecution.childCandidateId);
          if (existing) return send(res, 200, { candidate: existing, execution: run.repairExecution });
        }
        if (!run || latestCandidate(run)?.id !== candidate.id) return send(res, 409, { code: "STALE_CANDIDATE" });
        const cycle = run.reviewCycle;
        if (!cycle || cycle.status !== "awaiting_repair" || cycle.parentCandidateId !== candidate.id) return send(res, 422, { code: "REPAIR_NOT_READY" });
        const repairRound = Number.isInteger(cycle.repairRound) ? cycle.repairRound : Number.isInteger(cycle.round) ? cycle.round : 0;
        const maxRounds = Number.isInteger(cycle.maxRounds) && cycle.maxRounds > 0 ? cycle.maxRounds : 3;
        if (repairRound >= maxRounds) {
          run.reviewCycle = Object.freeze({ ...cycle, repairRound, round: repairRound, maxRounds, status: "human_required", humanRequiredAt: new Date().toISOString() });
          run.checkpoint = "human_review_required";
          store.event(run.id, "review.repair.limit_exceeded", { candidateId: candidate.id, candidateHash: candidate.candidateHash, repairRound, maxRounds });
          store.persist?.();
          return send(res, 409, { code: "HUMAN_REVIEW_REQUIRED", repairRound, maxRounds, candidateId: candidate.id });
        }
        const reviewDecision = candidate.independentReview;
        if (!reviewDecision || reviewDecision.status !== "changes_requested" || reviewDecision.candidateId !== candidate.id || reviewDecision.candidateHash !== candidate.candidateHash) return send(res, 422, { code: "REVIEW_CHANGES_REQUIRED" });
        const { decisionHash: storedDecisionHash, ...decisionContent } = reviewDecision;
        const actualReviewHash = reviewDecisionHash(decisionContent);
        const expectedReviewHash = cycle.reviewDecisionHash || storedDecisionHash || actualReviewHash;
        if (expectedReviewHash !== actualReviewHash) return send(res, 409, { code: "REVIEW_DECISION_CHANGED" });
        if (cycle.reviewDecisionHash && cycle.reviewDecisionHash !== expectedReviewHash) return send(res, 409, { code: "STALE_REVISION" });
        const input = await readJson(req);
        const source = await inspectCandidateSource(run, candidate);
        let patch = run.repairPatch;
        if (patch && (patch.candidateId !== candidate.id || patch.candidateHash !== candidate.candidateHash || patch.reviewDecisionHash !== expectedReviewHash || patch.expectedHead !== source.expectedHead || codePatchHash(patch) !== patch.codePatchHash)) return send(res, 409, { code: "STALE_REVISION" });
        if (input.patch !== undefined && !reworkMatch) return send(res, 422, { code: "REPAIR_PATCH_NOT_ALLOWED" });
        if (input.patch !== undefined) {
          patch = normalizeRepairPatch(input.patch, { candidate, source, reviewDecision, expectedReviewHash });
          if (run.repairPatch && run.repairPatch.codePatchHash !== patch.codePatchHash) return send(res, 409, { code: "REPAIR_PATCH_ALREADY_PROPOSED" });
          run.repairPatch = Object.freeze(patch);
          run.checkpoint = "repair_ready_for_execution";
          store.event(run.id, "review.repair.proposed", { candidateId: candidate.id, candidateHash: candidate.candidateHash, reviewDecisionHash: expectedReviewHash, patchHash: patch.codePatchHash, repairRound });
          store.persist?.();
        }
        if (!patch) return send(res, 422, { code: "REPAIR_PATCH_REQUIRED" });
        if (patch.candidateId !== candidate.id || patch.candidateHash !== candidate.candidateHash || patch.reviewDecisionHash !== expectedReviewHash || patch.expectedHead !== source.expectedHead || codePatchHash(patch) !== patch.codePatchHash) return send(res, 409, { code: "STALE_REVISION" });
        if (reworkMatch) return send(res, 202, { status: "repair_ready_for_execution", candidateId: candidate.id, candidateHash: candidate.candidateHash, reviewDecisionHash: expectedReviewHash, repairRound, maxRounds, patch });
        if (!input.grantId) return send(res, 422, { code: "GRANT_REQUIRED" });
        const target = codePatchWorkspace(run, candidate, patch);
        const executionKey = `${candidate.id}:${patch.codePatchHash}`;
        if (executingCodePatches.has(executionKey)) return send(res, 409, { code: "REPAIR_EXECUTION_IN_PROGRESS" });
        executingCodePatches.add(executionKey);
        let targetCreated = false;
        try {
          grants.consume(input.grantId, { projectId: run.projectId, runId: run.id, tool: "apply_review_repair", resource: target, planHash: patch.codePatchHash });
          const sourceRoot = await fs.realpath(path.resolve(candidate.codeArtifact.workspace));
          const patchByPath = new Map((patch.files || []).map((file) => [file.path, file]));
          const outputManifest = [];
          await fs.mkdir(target, { recursive: false });
          targetCreated = true;
          for (const entry of source.sourceManifest) {
            const sourcePath = path.resolve(sourceRoot, entry.path);
            const actualSource = await fs.realpath(sourcePath);
            if (!actualSource.startsWith(`${sourceRoot}${path.sep}`)) throw new PolicyError("Candidate source resolves outside its worktree", "POLICY_DENIED");
            const original = (await fs.readFile(actualSource)).toString("utf8");
            const filePlan = patchByPath.get(entry.path);
            const content = filePlan ? applyUnifiedDiff(original, filePlan.diff, entry.path) : original;
            const targetPath = path.resolve(target, entry.path);
            if (!targetPath.startsWith(`${target}${path.sep}`)) throw new PolicyError("Repair target escapes its worktree", "POLICY_DENIED");
            await fs.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.writeFile(targetPath, content, "utf8");
            outputManifest.push({ path: entry.path, size: Buffer.byteLength(content), sha256: crypto.createHash("sha256").update(content).digest("hex") });
          }
          const newHead = crypto.createHash("sha256").update(JSON.stringify(outputManifest.sort((left, right) => left.path.localeCompare(right.path)))).digest("hex");
          const design = candidate.designDraftId ? store.designs.get(candidate.designDraftId) : null;
          const build = await validateGeneratedCandidate({ worktreeRoot: target, expectedDesignHash: design?.designHash || undefined });
          const child = store.createCandidate(run.id, {
            parentId: candidate.id,
            designDraftId: candidate.designDraftId,
            codeArtifact: { ...candidate.codeArtifact, workspace: target, files: source.sourceFiles, head: newHead, patchHash: patch.codePatchHash, repairRound: repairRound + 1, designDraftId: candidate.designDraftId, designHash: design?.designHash || null },
            build: { ...build, mode: "static-rebuild", passed: true },
            sourceRefs: candidate.sourceRefs,
          });
          candidate.status = "superseded";
          // A source revision invalidates all candidate-bound content and CMS approvals.
          // ContentCMS must regenerate the model against the child hash before any CMS
          // snapshot or Coding proposal can be accepted.
          child.contentModel = null;
          child.contentApproval = null;
          const execution = Object.freeze({ candidateId: candidate.id, childCandidateId: child.id, candidateHash: candidate.candidateHash, patchHash: patch.codePatchHash, reviewDecisionHash: expectedReviewHash, sourceHead: patch.expectedHead, newHead, repairRound: repairRound + 1, executedBy: reviewerId, executedAt: new Date().toISOString(), buildPassed: true });
          run.repairExecution = execution;
          run.repairPatch = null;
          run.reviewDecision = null;
          run.codingPatch = null;
          run.codePatchApproval = null;
          run.codePatchExecution = null;
          run.contentModel = null;
          run.reviewCycle = Object.freeze({ ...cycle, repairRound: repairRound + 1, round: repairRound + 1, maxRounds, parentCandidateId: child.id, parentCandidateHash: child.candidateHash, previousReviewDecisionHash: expectedReviewHash, reviewDecisionHash: null, qualityReportHash: null, status: "awaiting_qa", updatedAt: new Date().toISOString() });
          run.checkpoint = "awaiting_qa";
          store.event(run.id, "review.repair.executed", execution);
          store.event(run.id, "candidate.repair-revision.created", { parentCandidateId: candidate.id, candidateId: child.id, patchHash: patch.codePatchHash, repairRound: repairRound + 1, newHead });
          store.persist?.();
          return send(res, 201, { candidate: child, execution, build });
        } catch (error) {
          if (targetCreated) await fs.rm(target, { recursive: true, force: true }).catch(() => {});
          store.event(run.id, "review.repair.execution.failed", { candidateId: candidate.id, patchHash: patch.codePatchHash, code: error.code || "BUILD_FAILED", reason: error.message });
          store.persist?.();
          throw error;
        } finally {
          executingCodePatches.delete(executionKey);
        }
      }
      if (req.method === "POST" && codePatchExecutionMatch) {
        if (!generation?.worktreeRoot) return send(res, 503, { code: "GENERATION_NOT_CONFIGURED" });
        const candidate = store.candidates.get(codePatchExecutionMatch[1]);
        if (!candidate) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        const run = store.runs.get(candidate.runId);
        if (!run || latestCandidate(run)?.id !== candidate.id) return send(res, 409, { code: "STALE_CANDIDATE" });
        const patch = run.codingPatch;
        const approval = run.codePatchApproval;
        const design = candidate.designDraftId ? store.designs.get(candidate.designDraftId) : null;
        if (!patch || patch.status !== "proposed" || !approval || approval.codePatchHash !== patch.codePatchHash || approval.executionGranted !== false) return send(res, 422, { code: "CODE_PATCH_APPROVAL_REQUIRED" });
        if (patch.candidateId !== candidate.id || patch.candidateHash !== candidate.candidateHash || patch.designDraftId !== design?.id || patch.designHash !== design?.designHash || patch.pagePlanHash !== run.pagePlan?.sourceManifestHash) return send(res, 409, { code: "STALE_REVISION" });
        if (codePatchHash(patch) !== patch.codePatchHash) return send(res, 409, { code: "CODE_PATCH_CHANGED" });
        const target = codePatchWorkspace(run, candidate, patch);
        const input = await readJson(req);
        if (run.codePatchExecution?.codePatchHash === patch.codePatchHash && run.codePatchExecution.candidateId === candidate.id) {
          const existing = store.candidates.get(run.codePatchExecution.childCandidateId);
          if (existing) return send(res, 200, { candidate: existing, execution: run.codePatchExecution });
        }
        const source = await inspectCandidateSource(run, candidate);
        if (source.expectedHead !== patch.expectedHead) return send(res, 409, { code: "STALE_SOURCE_REVISION" });
        const executionKey = `${candidate.id}:${patch.codePatchHash}`;
        if (executingCodePatches.has(executionKey)) return send(res, 409, { code: "CODE_PATCH_EXECUTION_IN_PROGRESS" });
        executingCodePatches.add(executionKey);
        let targetCreated = false;
        try {
          grants.consume(input.grantId, { projectId: run.projectId, runId: run.id, tool: "apply_code_patch", resource: target, planHash: patch.codePatchHash });
          const patchByPath = new Map((patch.files || []).map((file) => [file.path, file]));
          const outputManifest = [];
          await fs.mkdir(target, { recursive: false });
          targetCreated = true;
          const sourceRoot = await fs.realpath(path.resolve(candidate.codeArtifact.workspace));
          for (const entry of source.sourceManifest) {
            const sourcePath = path.resolve(sourceRoot, entry.path);
            const actualSource = await fs.realpath(sourcePath);
            if (!actualSource.startsWith(`${sourceRoot}${path.sep}`)) throw new PolicyError("Candidate source resolves outside its worktree", "POLICY_DENIED");
            const original = (await fs.readFile(actualSource)).toString("utf8");
            const filePlan = patchByPath.get(entry.path);
            const content = filePlan ? applyUnifiedDiff(original, filePlan.diff, entry.path) : original;
            const targetPath = path.resolve(target, entry.path);
            if (!targetPath.startsWith(`${target}${path.sep}`)) throw new PolicyError("CodePatch target escapes its worktree", "POLICY_DENIED");
            await fs.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.writeFile(targetPath, content, "utf8");
            outputManifest.push({ path: entry.path, size: Buffer.byteLength(content), sha256: crypto.createHash("sha256").update(content).digest("hex") });
          }
          const newHead = crypto.createHash("sha256").update(JSON.stringify(outputManifest.sort((left, right) => left.path.localeCompare(right.path)))).digest("hex");
          const build = await validateGeneratedCandidate({ worktreeRoot: target, expectedDesignHash: design?.designHash || undefined });
          const child = store.createCandidate(run.id, { parentId: candidate.id, designDraftId: candidate.designDraftId, codeArtifact: { ...candidate.codeArtifact, workspace: target, files: source.sourceFiles, head: newHead, patchHash: patch.codePatchHash, designDraftId: candidate.designDraftId, designHash: design?.designHash || null }, build: { ...build, mode: "static-rebuild", passed: true }, sourceRefs: candidate.sourceRefs });
          candidate.status = "superseded";
          const oldContent = candidate.contentModel || (run.contentModel?.candidateId === candidate.id ? run.contentModel : null);
          if (oldContent) {
            const contentModel = { ...oldContent, candidateId: child.id, candidateHash: child.candidateHash };
            contentModel.contentHash = contentModelHash(contentModel);
            child.contentModel = contentModel;
            run.contentModel = contentModel;
          }
          const execution = Object.freeze({ candidateId: candidate.id, childCandidateId: child.id, candidateHash: candidate.candidateHash, patchHash: patch.codePatchHash, sourceHead: patch.expectedHead, newHead, executedBy: reviewerId, executedAt: new Date().toISOString(), buildPassed: true });
          run.codePatchExecution = execution;
          run.checkpoint = child.contentModel ? "content_review_required" : "candidate_ready";
          store.event(run.id, "code-patch.executed", execution);
          store.event(run.id, "candidate.code-revision.created", { parentCandidateId: candidate.id, candidateId: child.id, patchHash: patch.codePatchHash, newHead });
          store.persist?.();
          return send(res, 201, { candidate: child, execution, build });
        } catch (error) {
          if (targetCreated) await fs.rm(target, { recursive: true, force: true }).catch(() => {});
          store.event(run.id, "code-patch.execution.failed", { candidateId: candidate.id, patchHash: patch.codePatchHash, code: error.code || "BUILD_FAILED", reason: error.message });
          store.persist?.();
          throw error;
        } finally {
          executingCodePatches.delete(executionKey);
        }
      }
      const candidateRunMatch = url.pathname.match(/^\/runs\/([^/]+)\/candidates$/);
      if (req.method === "POST" && candidateRunMatch) {
        const run = store.runs.get(candidateRunMatch[1]);
        if (!run) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        const candidate = store.createCandidate(run.id, await readJson(req));
        run.checkpoint = "candidate_ready";
        store.persist?.();
        return send(res, 201, candidate);
      }
      const payloadMatch = url.pathname.match(/^\/candidates\/([^/]+)\/payload-draft$/);
      if (req.method === "POST" && payloadMatch) {
        if (!payload || typeof payload.createDraft !== "function") return send(res, 503, { code: "PAYLOAD_NOT_CONFIGURED" });
        const candidate = store.candidates.get(payloadMatch[1]);
        if (!candidate) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        const input = await readJson(req);
        const run = store.runs.get(candidate.runId);
        const design = candidate.designDraftId ? store.designs.get(candidate.designDraftId) : null;
        if (candidate.designDraftId && !design) return send(res, 422, { code: "DESIGN_DRAFT_REQUIRED" });
        const autoPlan = input.contentByPage !== undefined || input.usePayloadPlan === true || input.pageOperations === undefined;
        let plan = null;
        let pageOperations = input.pageOperations;
        const boundAgentModel = candidate.contentModel || (run?.contentModel?.candidateId === candidate.id ? run.contentModel : null);
        if (input.useAgentContent === true || boundAgentModel) {
          const model = boundAgentModel;
          const approval = candidate.contentApproval;
          if (!model || model.status !== "proposed" || !model.contentHash) return send(res, 422, { code: "CONTENT_MODEL_REQUIRED" });
          if (!approval || approval.candidateId !== candidate.id || approval.candidateHash !== candidate.candidateHash || approval.designDraftId !== design?.id || approval.designHash !== design?.designHash || approval.contentHash !== model.contentHash) return send(res, 422, { code: "CONTENT_APPROVAL_REQUIRED" });
          if (JSON.stringify(input.contentByPage || null) !== JSON.stringify(model.contentByPage)) return send(res, 409, { code: "CONTENT_MODEL_CHANGED" });
          input.contentByPage = model.contentByPage;
        }
        if (autoPlan) {
          if (!candidate.build?.passed) return send(res, 422, { code: "BUILD_GATE_REQUIRED" });
          if (!run?.strategy) return send(res, 422, { code: "STRATEGY_REQUIRED" });
          plan = createPayloadDraftPlan({
            strategy: run.strategy,
            projectId: run.projectId,
            locales: input.locales || run.inputSnapshot.locale,
            contentByPage: input.contentByPage,
            designDraft: design,
            pagePlan: run.pagePlan,
          });
          pageOperations = plan.operations;
        } else if (!candidate.quality?.passed) {
          // Keep the legacy explicit-operation path behind the existing QA gate.
          return send(res, 422, { code: "QUALITY_GATE_REQUIRED" });
        }
        const expectedRequestHash = computePayloadRequestHash({
          candidateId: candidate.id,
          candidateHash: candidate.candidateHash,
          expectedCmsSnapshot: input.expectedCmsSnapshot,
          pageOperations,
          environment: "sandbox",
          designDraftId: design?.id || null,
          designHash: design?.designHash || null,
          designMappings: plan?.designMappings || null,
        });
        const priorForKey = [...store.candidates.values()].find((item) => item.parentId === candidate.id && item.cmsSnapshot?.idempotencyKey === input.idempotencyKey);
        if (priorForKey) {
          if (priorForKey.cmsSnapshot.requestHash !== expectedRequestHash) throw new PolicyError("Idempotency key was reused with different input", "IDEMPOTENCY_CONFLICT");
          return send(res, 200, { ...priorForKey.cmsSnapshot, candidate: priorForKey, ...(autoPlan ? { plan } : {}), parentCandidateId: candidate.id });
        }
        const receipt = await payload.createDraft({
          ...input,
          pageOperations,
          candidateId: candidate.id,
          candidateHash: candidate.candidateHash,
          designDraftId: design?.id || null,
          designHash: design?.designHash || null,
          designMappings: plan?.designMappings || null,
          environment: "sandbox",
        });
        if (!receipt || receipt.candidateId !== candidate.id || receipt.status !== "sandbox_draft") {
          throw new PolicyError("Payload snapshot receipt is not bound to this sandbox candidate", "CMS_INVALID_RECEIPT");
        }
        if (receipt.candidateHash !== candidate.candidateHash) {
          throw new PolicyError("Payload snapshot receipt is not bound to this candidate hash", "STALE_REVISION");
        }
        if (receipt.requestHash !== expectedRequestHash) {
          throw new PolicyError("Payload snapshot receipt does not match the submitted draft plan", "STALE_REVISION");
        }
        if (design && (receipt?.designDraftId !== design.id || receipt?.designHash !== design.designHash)) {
          throw new PolicyError("Payload snapshot did not preserve the bound design revision", "STALE_REVISION");
        }
        if (plan && JSON.stringify(receipt.designMappings) !== JSON.stringify(plan.designMappings)) {
          throw new PolicyError("Payload snapshot did not preserve the DesignDraft component mapping", "STALE_REVISION");
        }
        const existing = receipt.requestHash ? [...store.candidates.values()].find((item) => item.parentId === candidate.id && item.cmsSnapshot?.requestHash === receipt.requestHash) : null;
        const revision = existing || store.createPayloadCandidate(candidate.id, receipt);
        run.checkpoint = "cms_candidate_ready";
        store.persist?.();
        store.event(candidate.runId, "payload.draft.created", { candidateId: revision.id, parentCandidateId: candidate.id, cmsSnapshotId: receipt.cmsSnapshotId });
        return send(res, existing ? 200 : 201, { ...receipt, candidate: revision, ...(autoPlan ? { plan } : {}), parentCandidateId: candidate.id });
      }
      if (req.method === "POST" && contentApprovalMatch) {
        const candidate = store.candidates.get(contentApprovalMatch[1]);
        if (!candidate) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        const run = store.runs.get(candidate.runId);
        const design = candidate.designDraftId ? store.designs.get(candidate.designDraftId) : null;
        const input = await readJson(req);
        if (input.approved !== true) return send(res, 422, { code: "CONTENT_REVIEW_NOT_APPROVED" });
        const model = candidate.contentModel || (run?.contentModel?.candidateId === candidate.id ? run.contentModel : null);
        if (!model || model.status !== "proposed" || !model.contentHash) return send(res, 422, { code: "CONTENT_MODEL_REQUIRED" });
        if (model.candidateId !== candidate.id || model.candidateHash !== candidate.candidateHash || model.designDraftId !== design?.id || model.designHash !== design?.designHash) return send(res, 409, { code: "STALE_REVISION" });
        const expectedHash = contentModelHash(model);
        if (model.contentHash !== expectedHash || input.expectedContentHash !== expectedHash) return send(res, 409, { code: "CONTENT_MODEL_CHANGED" });
        candidate.contentApproval = Object.freeze({ candidateId: candidate.id, candidateHash: candidate.candidateHash, designDraftId: design.id, designHash: design.designHash, contentHash: expectedHash, approvedBy: reviewerId, approvedAt: new Date().toISOString() });
        if (run) run.checkpoint = "content_approved";
        store.event(candidate.runId, "content-model.approved", { candidateId: candidate.id, contentHash: expectedHash, approvedBy: reviewerId });
        store.persist?.();
        return send(res, 201, { candidateId: candidate.id, candidateHash: candidate.candidateHash, designDraftId: design.id, designHash: design.designHash, contentHash: expectedHash, approvedBy: reviewerId, status: "approved" });
      }
      if (req.method === "POST" && codePatchApprovalMatch) {
        const candidate = store.candidates.get(codePatchApprovalMatch[1]);
        if (!candidate) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        const run = store.runs.get(candidate.runId);
        if (!run || latestCandidate(run)?.id !== candidate.id) return send(res, 409, { code: "STALE_CANDIDATE" });
        const patch = run.codingPatch;
        const design = candidate.designDraftId ? store.designs.get(candidate.designDraftId) : null;
        const contentModel = candidate.contentModel || (run.contentModel?.candidateId === candidate.id ? run.contentModel : null);
        const input = await readJson(req);
        if (input.approved !== true) return send(res, 422, { code: "CODE_PATCH_REVIEW_NOT_APPROVED" });
        if (!patch || patch.status !== "proposed") return send(res, 422, { code: "CODE_PATCH_REQUIRED" });
        if (patch.candidateId !== candidate.id || patch.candidateHash !== candidate.candidateHash || patch.designDraftId !== design?.id || patch.designHash !== design?.designHash || patch.pagePlanHash !== run.pagePlan?.sourceManifestHash || patch.contentHash !== contentModel?.contentHash) return send(res, 409, { code: "STALE_REVISION" });
        const expectedPatchHash = codePatchHash(patch);
        if (patch.codePatchHash !== expectedPatchHash || input.expectedCodePatchHash !== expectedPatchHash) return send(res, 409, { code: "CODE_PATCH_CHANGED" });
        const source = await inspectCandidateSource(run, candidate);
        if (source.expectedHead !== patch.expectedHead) return send(res, 409, { code: "STALE_SOURCE_REVISION" });
        const contentApproval = candidate.contentApproval;
        if (!contentApproval || contentApproval.candidateId !== candidate.id || contentApproval.candidateHash !== candidate.candidateHash || contentApproval.designDraftId !== design?.id || contentApproval.designHash !== design?.designHash || contentApproval.contentHash !== patch.contentHash) return send(res, 422, { code: "CONTENT_APPROVAL_REQUIRED" });
        if (run.codePatchApproval?.codePatchHash === expectedPatchHash) {
          return send(res, 200, { ...run.codePatchApproval, status: "approved_for_execution_review" });
        }
        const approval = Object.freeze({
          candidateId: candidate.id,
          candidateHash: candidate.candidateHash,
          designDraftId: design.id,
          designHash: design.designHash,
          pagePlanHash: patch.pagePlanHash,
          contentHash: patch.contentHash,
          expectedHead: patch.expectedHead,
          codePatchHash: expectedPatchHash,
          approvedBy: reviewerId,
          approvedAt: new Date().toISOString(),
          executionGranted: false,
        });
        run.codePatchApproval = approval;
        store.event(run.id, "code-patch.approved", { candidateId: candidate.id, candidateHash: candidate.candidateHash, designHash: design.designHash, codePatchHash: expectedPatchHash, approvedBy: reviewerId, executionGranted: false });
        store.persist?.();
        return send(res, 201, { ...approval, status: "approved_for_execution_review" });
      }
      const qaMatch = url.pathname.match(/^\/candidates\/([^/]+)\/qa$/);
      if (req.method === "POST" && qaMatch) {
        if (!quality || typeof quality.run !== "function") return send(res, 503, { code: "QA_NOT_CONFIGURED" });
        const candidate = store.candidates.get(qaMatch[1]);
        if (!candidate) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        const run = store.runs.get(candidate.runId);
        if (!run || latestCandidate(run)?.id !== candidate.id) return send(res, 409, { code: "STALE_CANDIDATE" });
        if (candidate.cmsSnapshot && !candidate.build?.passed) return send(res, 422, { code: "BUILD_GATE_REQUIRED" });
        const report = await quality.run({ ...(await readJson(req)), candidateId: candidate.id, candidateHash: candidate.candidateHash });
        if (report.candidateId !== candidate.id || report.candidateHash !== candidate.candidateHash) {
          throw new PolicyError("QA report belongs to a different candidate revision", "STALE_REVISION");
        }
        store.markQuality(candidate.id, { passed: report.passed, reportHash: report.reportHash, checks: report.results });
        if (run.reviewCycle?.parentCandidateId === candidate.id && ["awaiting_qa", "qa_failed"].includes(run.reviewCycle.status)) {
          run.reviewCycle = Object.freeze({ ...run.reviewCycle, status: report.passed ? "awaiting_review" : "qa_failed", qualityReportHash: report.reportHash, updatedAt: new Date().toISOString() });
          run.checkpoint = report.passed ? "qa_passed" : "qa_failed";
        }
        store.persist?.();
        return send(res, 200, report);
      }
      if (req.method === "POST" && reviewMatch) {
        const candidate = store.candidates.get(reviewMatch[1]);
        if (!candidate) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        const decision = await readJson(req);
        if (decision.approved !== true) return send(res, 422, { code: "REVIEW_NOT_APPROVED" });
        const draft = store.packageReview(candidate.id, { approvedByReviewer: reviewerId, notes: decision.notes || "" });
        const run = store.runs.get(candidate.runId);
        if (run) run.checkpoint = "draft_ready_for_review";
        store.persist?.();
        return send(res, 201, draft);
      }
      const statusMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
      if (req.method === "GET" && statusMatch) {
        const run = store.runs.get(statusMatch[1]);
        return run ? send(res, 200, run) : send(res, 404, { code: "RESOURCE_NOT_FOUND" });
      }
      return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
    } catch (error) {
      const status = error.code === "RESOURCE_NOT_FOUND" ? 404 : error.code === "SANDBOX_REQUIRED" || error.code === "CONFIG_REQUIRED" ? 503 : error.code === "POLICY_DENIED" || error.code === "INVALID_INPUT" || error.code === "NEEDS_INPUT" || error.code === "TEMPLATE_CAPABILITY_MISSING" || error.code === "STALE_REVISION" || error.code === "SCHEMA_REJECTED" || error.code === "CMS_INVALID_RECEIPT" || error.code === "CMS_REJECTED" || error.code === "IDEMPOTENCY_CONFLICT" || error.code === "REVIEW_GATE_REQUIRED" || error.code?.startsWith("GRANT_") ? 422 : 400;
      return send(res, status, { code: error.code || "INVALID_INPUT", message: error.message });
    }
  });
  server.on("close", () => {
    for (const session of previewSessions.values()) {
      clearTimeout(session.timer);
      quality?.preview?.unregisterPreview?.(session.sessionId);
      session.preview.close().catch(() => {});
    }
    previewSessions.clear();
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 3100);
  const databaseFile = process.env.SITEPILOT_DB_FILE;
  if (databaseFile && [process.env.SITEPILOT_STATE_FILE, process.env.SITEPILOT_EVIDENCE_FILE, process.env.SITEPILOT_REGISTRY_FILE, process.env.SITEPILOT_GRANTS_DB].some(Boolean)) throw new Error("Configure either SITEPILOT_DB_FILE or legacy state files, not both");
  const store = databaseFile ? new SqliteSitePilotStore(databaseFile) : process.env.SITEPILOT_STATE_FILE ? new JsonSitePilotStore(process.env.SITEPILOT_STATE_FILE) : new SitePilotStore();
  const configuredJournalPath = resolveToolJournalPath({
    explicitPath: process.env.SITEPILOT_TOOL_JOURNAL_PATH,
    databaseFile,
    stateFile: process.env.SITEPILOT_STATE_FILE,
  });
  const agentToolJournal = configuredJournalPath ? new JsonToolJournal(configuredJournalPath) : null;
  const evidence = databaseFile ? new SqliteEvidenceStore(databaseFile) : process.env.SITEPILOT_EVIDENCE_FILE ? new JsonEvidenceStore(process.env.SITEPILOT_EVIDENCE_FILE) : new EvidenceStore();
  const registry = databaseFile ? new SqliteBlockRegistry(databaseFile) : process.env.SITEPILOT_REGISTRY_FILE ? new JsonBlockRegistry(process.env.SITEPILOT_REGISTRY_FILE) : new BlockRegistry();
  const codeAtlasSettings = [process.env.CODEATLAS_MCP_URL, process.env.CODEATLAS_MCP_TOKEN, process.env.CODEATLAS_REPOSITORIES];
  if (codeAtlasSettings.some(Boolean) && codeAtlasSettings.some((value) => !value)) throw new Error("Configure CODEATLAS_MCP_URL, CODEATLAS_MCP_TOKEN, and CODEATLAS_REPOSITORIES together");
  const codeAtlas = codeAtlasSettings.every(Boolean) ? createCodeAtlasAdapterFromEnvironment() : null;
  const payloadSettings = [process.env.PAYLOAD_SANDBOX_URL, process.env.PAYLOAD_SANDBOX_TOKEN];
  if (payloadSettings.some(Boolean) && payloadSettings.some((value) => !value)) throw new Error("Configure PAYLOAD_SANDBOX_URL and PAYLOAD_SANDBOX_TOKEN together");
  const payload = payloadSettings.every(Boolean) ? new PayloadSandboxAdapter({ backend: new PayloadHttpSandboxBackend({ baseUrl: process.env.PAYLOAD_SANDBOX_URL, token: process.env.PAYLOAD_SANDBOX_TOKEN }) }) : null;
  const host = process.env.SITEPILOT_HOST || "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "0.0.0.0") throw new Error("SITEPILOT_HOST must be 127.0.0.1 or 0.0.0.0");
  const grants = databaseFile ? new SqliteGrantStore(databaseFile) : process.env.SITEPILOT_GRANTS_DB ? new SqliteGrantStore(process.env.SITEPILOT_GRANTS_DB) : new GrantStore();
  const quality = process.env.SITEPILOT_QA_PREVIEWS && process.env.SITEPILOT_QA_ARTIFACT_ROOT ? new QualityAdapter({ preview: new PlaywrightPreviewAdapter({ previews: JSON.parse(process.env.SITEPILOT_QA_PREVIEWS), artifactRoot: process.env.SITEPILOT_QA_ARTIFACT_ROOT }) }) : null;
  const payloadBuildSettings = [process.env.SITEPILOT_PAYLOAD_SOURCE_ROOT, process.env.SITEPILOT_WORKTREE_ROOT, process.env.SITEPILOT_SANDBOX_IMAGE];
  const payloadBuild = payloadBuildSettings.every(Boolean) ? new PayloadBuildPipeline({ sourceRoot: process.env.SITEPILOT_PAYLOAD_SOURCE_ROOT, worktreeRoot: process.env.SITEPILOT_WORKTREE_ROOT, image: process.env.SITEPILOT_SANDBOX_IMAGE }) : null;
  createServer(store, {}, evidence, registry, codeAtlas, payload, quality, { worktreeRoot: process.env.SITEPILOT_WORKTREE_ROOT }, grants, payloadBuild, null, createOpenAICompatibleIntakeAdapter, createPiModelRuntime, agentToolJournal).listen(port, host, () => console.log(`SitePilot API listening on http://${host}:${port}`));
}
