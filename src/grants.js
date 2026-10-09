import crypto from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { PolicyError } from "./core.js";

const id = () => `grant_${crypto.randomUUID().replaceAll("-", "")}`;

export class GrantStore {
  constructor() { this.grants = new Map(); }

  issue({ projectId, runId, tool, resource, planHash, expiresAt, issuedBy } = {}) {
    if (![projectId, runId, tool, resource, planHash, expiresAt, issuedBy].every((value) => typeof value === "string" && value.trim())) throw new PolicyError("Grant requires project, run, tool, resource, plan, expiry and issuer", "INVALID_INPUT");
    const expires = Date.parse(expiresAt);
    if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 15 * 60_000) throw new PolicyError("Grant expiry must be within 15 minutes", "INVALID_INPUT");
    const grant = Object.freeze({ id: id(), projectId, runId, tool, resource, planHash, expiresAt: new Date(expires).toISOString(), issuedBy, revoked: false, usedAt: null });
    this.grants.set(grant.id, grant);
    return grant;
  }

  consume(grantId, { projectId, runId, tool, resource, planHash } = {}) {
    const grant = this.grants.get(grantId);
    if (!grant) throw new PolicyError("L2 grant not found", "GRANT_REQUIRED");
    if (grant.revoked || grant.usedAt || Date.parse(grant.expiresAt) <= Date.now()) throw new PolicyError("L2 grant is expired, revoked or already used", "GRANT_INVALID");
    if (grant.projectId !== projectId || grant.runId !== runId || grant.tool !== tool || grant.resource !== resource || grant.planHash !== planHash) throw new PolicyError("L2 grant scope does not match request", "GRANT_SCOPE_MISMATCH");
    const consumed = Object.freeze({ ...grant, usedAt: new Date().toISOString() });
    this.grants.set(grant.id, consumed);
    return consumed;
  }

  revoke(grantId) {
    const grant = this.grants.get(grantId);
    if (!grant) throw new PolicyError("L2 grant not found", "RESOURCE_NOT_FOUND");
    const revoked = Object.freeze({ ...grant, revoked: true });
    this.grants.set(grant.id, revoked);
    return revoked;
  }
}

export class SqliteGrantStore extends GrantStore {
  constructor(file) {
    super();
    if (typeof file !== "string" || !file.startsWith("/")) throw new PolicyError("SQLite path must be absolute", "INVALID_INPUT");
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
    for (const row of this.db.prepare("SELECT data FROM grants").all()) {
      const grant = Object.freeze(JSON.parse(row.data));
      this.grants.set(grant.id, grant);
    }
  }

  persist(grant, prior = null) {
    const result = prior === null
      ? this.db.prepare("INSERT INTO grants (id, data) VALUES (?, ?)").run(grant.id, JSON.stringify(grant))
      : this.db.prepare("UPDATE grants SET data=? WHERE id=? AND data=?").run(JSON.stringify(grant), grant.id, prior);
    if (!result.changes) throw new PolicyError("L2 grant changed by another writer", "GRANT_INVALID");
    return grant;
  }

  issue(input) { return this.persist(super.issue(input)); }
  consume(id, scope) {
    const prior = this.db.prepare("SELECT data FROM grants WHERE id=?").get(id)?.data;
    if (!prior) throw new PolicyError("L2 grant not found", "GRANT_REQUIRED");
    this.grants.set(id, Object.freeze(JSON.parse(prior)));
    return this.persist(super.consume(id, scope), prior);
  }
  revoke(id) {
    const prior = this.db.prepare("SELECT data FROM grants WHERE id=?").get(id)?.data;
    if (!prior) throw new PolicyError("L2 grant not found", "RESOURCE_NOT_FOUND");
    this.grants.set(id, Object.freeze(JSON.parse(prior)));
    return this.persist(super.revoke(id), prior);
  }
  close() { this.db.close(); }
}
