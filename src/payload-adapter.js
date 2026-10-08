import crypto from "node:crypto";

import { PolicyError } from "./core.js";

const ALLOWED_OPERATIONS = new Set(["upsert_page", "upsert_global", "upsert_media_ref", "upsert_form"]);
const ALLOWED_LOCALES = new Set(["zh-CN", "en", "en-US", "ja", "de", "fr"]);

function assertPublicHost(url) {
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "metadata.google.internal" || host === "169.254.169.254" || host === "::1" || host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) throw new PolicyError("Payload sandbox host is private or reserved", "SSRF_BLOCKED");
}

export class PayloadHttpSandboxBackend {
  constructor({ baseUrl, token, fetchImpl = globalThis.fetch, allowedCollections = ["pages", "posts", "media", "categories", "forms", "globals"] } = {}) {
    if (!baseUrl || !token || typeof fetchImpl !== "function") throw new PolicyError("Payload sandbox URL, token and fetch are required", "CONFIG_REQUIRED");
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:") throw new PolicyError("Payload sandbox must use HTTPS", "POLICY_DENIED");
    assertPublicHost(parsed);
    this.baseUrl = parsed.href.replace(/\/$/, "");
    this.token = token;
    this.fetch = fetchImpl;
    this.allowedCollections = new Set(allowedCollections);
  }

  async apply({ candidateId, expectedCmsSnapshot, operations, requestHash }) {
    const records = [];
    for (const operation of operations) {
      if (!this.allowedCollections.has(operation.collection)) throw new PolicyError(`Payload collection is not allowed: ${operation.collection}`, "POLICY_DENIED");
      const body = { ...operation.data, _sitepilotCandidateId: candidateId, _sitepilotRequestHash: requestHash };
      const endpoint = `${this.baseUrl}/api/${encodeURIComponent(operation.collection)}`;
      const response = await this.fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", "x-sitepilot-cms-snapshot": expectedCmsSnapshot },
        body: JSON.stringify({ ...body, _status: "draft", locale: operation.locale }),
      });
      if (!response.ok) throw new PolicyError(`Payload sandbox rejected ${operation.collection}: HTTP ${response.status}`, "CMS_REJECTED");
      const result = await response.json();
      if (!result?.doc?.id && !result?.id) throw new PolicyError("Payload sandbox returned no record id", "CMS_INVALID_RECEIPT");
      records.push({ collection: operation.collection, id: result.doc?.id || result.id });
    }
    return { snapshotId: `payload_${requestHash.slice(0, 24)}`, recordRefs: records, diff: operations.map((operation) => `${operation.collection}/${operation.data.slug || operation.data.id || "new"}`) };
  }
}

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class PayloadSandboxAdapter {
  constructor({ backend, allowedCollections = ["pages", "posts", "media", "categories", "forms", "globals"] } = {}) {
    if (!backend || typeof backend.apply !== "function") throw new PolicyError("Payload sandbox backend is required", "CONFIG_REQUIRED");
    this.backend = backend;
    this.allowedCollections = new Set(allowedCollections);
    this.receipts = new Map();
  }

  async createDraft({ candidateId, expectedCmsSnapshot, pageOperations = [], idempotencyKey, environment = "sandbox" } = {}) {
    if (!candidateId || !expectedCmsSnapshot) throw new PolicyError("candidate_id and expected CMS snapshot are required", "INVALID_INPUT");
    if (!idempotencyKey || typeof idempotencyKey !== "string") throw new PolicyError("idempotency_key is required", "INVALID_INPUT");
    if (environment !== "sandbox") throw new PolicyError("Payload writes are limited to the sandbox environment", "POLICY_DENIED");
    const requestHash = hash({ candidateId, expectedCmsSnapshot, pageOperations, environment });
    const previous = this.receipts.get(idempotencyKey);
    if (previous) {
      if (previous.requestHash !== requestHash) throw new PolicyError("Idempotency key was reused with different input", "IDEMPOTENCY_CONFLICT");
      return previous.receipt;
    }
    this.validateOperations(pageOperations);
    const intent = { candidateId, expectedCmsSnapshot, operations: pageOperations, requestHash };
    const result = await this.backend.apply(intent);
    if (!result || typeof result.snapshotId !== "string") throw new PolicyError("Payload backend returned no snapshot receipt", "UNKNOWN_RESULT");
    const receipt = Object.freeze({
      candidateId,
      cmsSnapshotId: result.snapshotId,
      cmsRecordRefs: result.recordRefs || [],
      diff: result.diff || [],
      requestHash,
      status: "sandbox_draft",
      promotesDeliveryPreview: false,
      createsDraftVersion: false,
    });
    this.receipts.set(idempotencyKey, { requestHash, receipt });
    return receipt;
  }

  validateOperations(operations) {
    if (!Array.isArray(operations) || operations.length > 100) throw new PolicyError("Payload operations must be a bounded array", "INVALID_INPUT");
    for (const operation of operations) {
      if (!operation || !ALLOWED_OPERATIONS.has(operation.type)) throw new PolicyError(`Payload operation is not allowed: ${operation?.type || "missing"}`, "POLICY_DENIED");
      if (!this.allowedCollections.has(operation.collection)) throw new PolicyError(`Payload collection is not allowed: ${operation.collection || "missing"}`, "POLICY_DENIED");
      if (operation.locale && !ALLOWED_LOCALES.has(operation.locale)) throw new PolicyError(`Locale is not allowed: ${operation.locale}`, "POLICY_DENIED");
      if (operation.data === undefined || operation.data === null || typeof operation.data !== "object") throw new PolicyError("Payload operation data must be an object", "INVALID_INPUT");
      if (JSON.stringify(operation).length > 256 * 1024) throw new PolicyError("Payload operation exceeds size limit", "INVALID_INPUT");
      if (Object.keys(operation.data).some((key) => /(?:password|token|secret|apiKey|privateKey)/i.test(key))) throw new PolicyError("Secrets are not allowed in Payload drafts", "POLICY_DENIED");
    }
  }
}
