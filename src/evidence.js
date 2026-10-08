import crypto from "node:crypto";

import { PolicyError } from "./core.js";

const id = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

export class EvidenceStore {
  constructor() {
    this.sources = new Map();
    this.claims = new Map();
    this.records = new Map();
  }

  registerSource({ projectId, sourceId = id("source"), kind, name, content, version = "1", collectionId = null, locator = null } = {}) {
    if (!projectId || !kind || !name || typeof content !== "string") throw new PolicyError("Evidence source requires project, kind, name and content", "INVALID_INPUT");
    const source = Object.freeze({ id: sourceId, projectId, kind, name, version, collectionId, locator, contentHash: digest(content), status: "active", createdAt: new Date().toISOString() });
    for (const previous of this.sources.values()) {
      if (previous.projectId === projectId && previous.name === name && previous.status === "active" && previous.contentHash !== source.contentHash) {
        this.sources.set(previous.id, Object.freeze({ ...previous, status: "superseded", supersededBy: source.id }));
        for (const record of this.records.values()) if (record.sourceId === previous.id && record.status === "active") this.records.set(record.id, Object.freeze({ ...record, status: "expired", expiredAt: new Date().toISOString() }));
      }
    }
    this.sources.set(source.id, source);
    return source;
  }

  addRecord({ sourceId, locator, quote, sourceType = "client", allowedClaims = [], confidence = "confirmed" } = {}) {
    const source = this.sources.get(sourceId);
    if (!source || source.status !== "active") throw new PolicyError("Evidence source is missing or superseded", "SOURCE_EXPIRED");
    if (!locator || !quote?.trim()) throw new PolicyError("Evidence record requires locator and quote", "INVALID_INPUT");
    const record = Object.freeze({ id: id("evidence"), sourceId, sourceVersion: source.version, sourceHash: source.contentHash, locator, quote: quote.trim(), sourceType, allowedClaims, confidence, status: "active", createdAt: new Date().toISOString() });
    this.records.set(record.id, record);
    return record;
  }

  createClaim({ projectId, statement, evidenceIds = [], status = "proposed" } = {}) {
    if (!projectId || !statement?.trim()) throw new PolicyError("Claim requires a project and statement", "INVALID_INPUT");
    const records = evidenceIds.map((evidenceId) => this.records.get(evidenceId));
    if (records.some((record) => !record || record.status !== "active")) throw new PolicyError("Claim references expired or missing evidence", "SOURCE_EXPIRED");
    const claim = Object.freeze({ id: id("claim"), projectId, statement: statement.trim(), evidenceIds, status: evidenceIds.length ? status : "unsupported", createdAt: new Date().toISOString() });
    this.claims.set(claim.id, claim);
    return claim;
  }

  invalidateExpiredClaims() {
    let count = 0;
    for (const claim of this.claims.values()) {
      if (claim.status !== "unsupported" && claim.evidenceIds.some((evidenceId) => this.records.get(evidenceId)?.status !== "active")) {
        this.claims.set(claim.id, Object.freeze({ ...claim, status: "needs_reconfirmation", invalidatedAt: new Date().toISOString() }));
        count += 1;
      }
    }
    return count;
  }

  snapshot(projectId) {
    return Object.freeze({
      projectId,
      sources: [...this.sources.values()].filter((source) => source.projectId === projectId),
      records: [...this.records.values()].filter((record) => this.sources.get(record.sourceId)?.projectId === projectId),
      claims: [...this.claims.values()].filter((claim) => claim.projectId === projectId),
    });
  }
}
