import crypto from "node:crypto";

import { PolicyError } from "./core.js";

const ALLOWED_OPERATIONS = new Set(["upsert_page", "upsert_global", "upsert_media_ref", "upsert_form"]);
const ALLOWED_LOCALES = new Set(["zh-CN", "en", "en-US", "ja", "de", "fr"]);

function assertPublicHost(url) {
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "metadata.google.internal" || host === "169.254.169.254" || host === "::1" || host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) throw new PolicyError("Payload sandbox host is private or reserved", "SSRF_BLOCKED");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function payloadValueMatches(actual, expected) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => payloadValueMatches(actual[index], value));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([key, value]) => payloadValueMatches(actual[key], value));
  }
  return JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected));
}

function payloadFieldsMatch(actual, expected) {
  // Payload adds generated ids and bookkeeping fields to nested blocks. Every submitted
  // field must survive unchanged, while those server-owned additions are ignored.
  return payloadValueMatches(actual, expected);
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

  async apply({ candidateId, candidateHash, expectedCmsSnapshot, operations, requestHash, designDraftId, designHash, designMappings }) {
    const records = [];
    for (const [operationIndex, operation] of operations.entries()) {
      if (!this.allowedCollections.has(operation.collection)) throw new PolicyError(`Payload collection is not allowed: ${operation.collection}`, "POLICY_DENIED");
      const endpoint = `${this.baseUrl}/api/${encodeURIComponent(operation.collection)}`;
      const headers = {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "x-sitepilot-cms-snapshot": expectedCmsSnapshot,
      };
      if (designDraftId) headers["x-sitepilot-design-draft"] = designDraftId;
      if (designHash) headers["x-sitepilot-design-hash"] = designHash;
      if (designMappings) headers["x-sitepilot-design-mapping-hash"] = hash(designMappings);
      if (candidateHash) headers["x-sitepilot-candidate-hash"] = candidateHash;
      headers["idempotency-key"] = `${requestHash}:${operationIndex}`;
      const collectionUrl = new URL(endpoint);
      if (operation.locale) collectionUrl.searchParams.set("locale", operation.locale);
      const response = await this.fetch(collectionUrl.href, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...operation.data, _status: "draft" }),
      });
      if (!response.ok) throw new PolicyError(`Payload sandbox rejected ${operation.collection}: HTTP ${response.status}`, "CMS_REJECTED");
      const result = await response.json();
      const recordId = result?.doc?.id || result?.id;
      if (!recordId) throw new PolicyError("Payload sandbox returned no record id", "CMS_INVALID_RECEIPT");
      const readbackUrl = new URL(`${endpoint}/${encodeURIComponent(recordId)}`);
      readbackUrl.searchParams.set("draft", "true");
      readbackUrl.searchParams.set("depth", "0");
      if (operation.locale) readbackUrl.searchParams.set("locale", operation.locale);
      const readbackResponse = await this.fetch(readbackUrl.href, { method: "GET", headers: { authorization: `Bearer ${this.token}` } });
      if (!readbackResponse.ok) throw new PolicyError(`Payload sandbox draft could not be read back: HTTP ${readbackResponse.status}`, "CMS_INVALID_RECEIPT");
      const readbackResult = await readbackResponse.json();
      const document = readbackResult?.doc || readbackResult;
      if (String(document?.id) !== String(recordId) || document?._status !== "draft" || !payloadFieldsMatch(document, { ...operation.data, _status: "draft" })) {
        throw new PolicyError("Payload sandbox readback differs from the submitted draft", "CMS_INVALID_RECEIPT");
      }
      records.push({ collection: operation.collection, id: recordId });
    }
    return { snapshotId: `payload_${requestHash.slice(0, 24)}`, recordRefs: records, diff: operations.map((operation) => `${operation.collection}/${operation.data.slug || operation.data.id || "new"}`) };
  }
}

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isValidDesignMappings(value, designDraftId, designHash) {
  if (!designDraftId || !designHash || !value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.schemaVersion !== "payload-website-block-map-v1" || value.designDraftId !== designDraftId || value.designHash !== designHash || !Array.isArray(value.pages) || value.pages.length < 1 || value.pages.length > 25) return false;
  const pages = new Set();
  const routes = new Set();
  for (const page of value.pages) {
    if (!page || typeof page.page !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(page.page) || typeof page.route !== "string" || !page.route.startsWith("/") || page.route.length > 256 || !Array.isArray(page.claimRefs) || page.claimRefs.length > 100 || page.claimRefs.some((claim) => typeof claim !== "string" || claim.length > 200) || !Array.isArray(page.components) || page.components.length < 1 || page.components.length > 40) return false;
    if (pages.has(page.page) || routes.has(page.route)) return false;
    pages.add(page.page);
    routes.add(page.route);
    const instances = new Set();
    let heroes = 0;
    let layoutIndex = 0;
    for (const component of page.components) {
      if (!component || typeof component.instanceId !== "string" || component.instanceId.length > 128 || typeof component.registryId !== "string" || component.registryId.length > 128 || !/^[a-f0-9]{64}$/i.test(component.propsHash || "") || !["Hero", "Content", "CTA"].includes(component.name) || component.copyPolicy !== "approved_content_required") return false;
      if (instances.has(component.instanceId)) return false;
      instances.add(component.instanceId);
      const expected = component.name === "Hero" ? { target: "hero", blockType: null } : { target: `layout[${layoutIndex++}]`, blockType: component.name === "Content" ? "content" : "cta" };
      if (component.payloadTarget !== expected.target || component.blockType !== expected.blockType) return false;
      if (component.name === "Hero") heroes += 1;
    }
    if (heroes !== 1 || page.components[0].name !== "Hero") return false;
  }
  return true;
}

export function computePayloadRequestHash({ candidateId, candidateHash, expectedCmsSnapshot, pageOperations = [], environment = "sandbox", designDraftId, designHash, designMappings } = {}) {
  return hash({ candidateId, candidateHash: candidateHash || null, expectedCmsSnapshot, pageOperations, environment, designDraftId: designDraftId || null, designHash: designHash || null, designMappings: designMappings || null });
}

export class PayloadSandboxAdapter {
  constructor({ backend, allowedCollections = ["pages", "posts", "media", "categories", "forms", "globals"] } = {}) {
    if (!backend || typeof backend.apply !== "function") throw new PolicyError("Payload sandbox backend is required", "CONFIG_REQUIRED");
    this.backend = backend;
    this.allowedCollections = new Set(allowedCollections);
    this.receipts = new Map();
    this.pending = new Map();
  }

  async createDraft({ candidateId, candidateHash, expectedCmsSnapshot, pageOperations = [], idempotencyKey, environment = "sandbox", designDraftId, designHash, designMappings } = {}) {
    if (!candidateId || !expectedCmsSnapshot) throw new PolicyError("candidate_id and expected CMS snapshot are required", "INVALID_INPUT");
    if (!idempotencyKey || typeof idempotencyKey !== "string") throw new PolicyError("idempotency_key is required", "INVALID_INPUT");
    if (environment !== "sandbox") throw new PolicyError("Payload writes are limited to the sandbox environment", "POLICY_DENIED");
    if ((designDraftId && !designHash) || (!designDraftId && designHash)) throw new PolicyError("designDraftId and designHash must be provided together", "INVALID_INPUT");
    if (designDraftId !== undefined && (typeof designDraftId !== "string" || !designDraftId || designDraftId.length > 128)) throw new PolicyError("designDraftId is invalid", "INVALID_INPUT");
    if (designHash !== undefined && (typeof designHash !== "string" || !/^[a-f0-9]{64}$/i.test(designHash))) throw new PolicyError("designHash is invalid", "INVALID_INPUT");
    if (candidateHash !== undefined && (typeof candidateHash !== "string" || !/^[a-f0-9]{64}$/i.test(candidateHash))) throw new PolicyError("candidateHash is invalid", "INVALID_INPUT");
    if (designMappings !== undefined && designMappings !== null) {
      if (!isValidDesignMappings(designMappings, designDraftId, designHash)) {
        throw new PolicyError("Design mapping must bind to the supplied DesignDraft revision", "STALE_REVISION");
      }
      if (JSON.stringify(designMappings).length > 128 * 1024) throw new PolicyError("Design mapping exceeds size limit", "INVALID_INPUT");
      designMappings = structuredClone(designMappings);
    } else {
      designMappings = null;
    }
    const requestHash = computePayloadRequestHash({ candidateId, candidateHash, expectedCmsSnapshot, pageOperations, environment, designDraftId, designHash, designMappings });
    const previous = this.receipts.get(idempotencyKey);
    if (previous) {
      if (previous.requestHash !== requestHash) throw new PolicyError("Idempotency key was reused with different input", "IDEMPOTENCY_CONFLICT");
      return previous.receipt;
    }
    const pending = this.pending.get(idempotencyKey);
    if (pending) {
      if (pending.requestHash !== requestHash) throw new PolicyError("Idempotency key was reused with different input", "IDEMPOTENCY_CONFLICT");
      return pending.promise;
    }
    this.validateOperations(pageOperations);
    const intent = { candidateId, candidateHash: candidateHash || null, expectedCmsSnapshot, operations: pageOperations, requestHash, designDraftId: designDraftId || null, designHash: designHash || null, designMappings };
    const promise = (async () => {
      const result = await this.backend.apply(intent);
      if (!result || typeof result.snapshotId !== "string") throw new PolicyError("Payload backend returned no snapshot receipt", "UNKNOWN_RESULT");
      const receipt = Object.freeze({
        candidateId,
        candidateHash: candidateHash || null,
        designDraftId: designDraftId || null,
        designHash: designHash || null,
        designMappings,
        cmsSnapshotId: result.snapshotId,
        idempotencyKey,
        cmsRecordRefs: result.recordRefs || [],
        diff: result.diff || [],
        requestHash,
        status: "sandbox_draft",
        promotesDeliveryPreview: false,
        createsDraftVersion: false,
      });
      this.receipts.set(idempotencyKey, { requestHash, receipt });
      return receipt;
    })();
    this.pending.set(idempotencyKey, { requestHash, promise });
    try { return await promise; }
    finally { if (this.pending.get(idempotencyKey)?.promise === promise) this.pending.delete(idempotencyKey); }
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
