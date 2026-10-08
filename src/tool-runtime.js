import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { PolicyError } from "./core.js";

const STATUSES = new Set(["queued", "intent_committed", "running", "succeeded", "failed", "partial", "needs_input", "interrupted", "cancelled"]);

export class JsonToolJournal {
  constructor(file) {
    if (!file || !path.isAbsolute(file)) throw new PolicyError("Tool journal path must be absolute", "POLICY_DENIED");
    this.file = path.resolve(file);
    this.records = new Map();
    this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    const values = JSON.parse(fs.readFileSync(this.file, "utf8"));
    for (const value of values) {
      let record = value;
      if (record?.id && STATUSES.has(record.status)) {
        if (record.status === "intent_committed" || record.status === "running") record = { ...record, status: "interrupted", error: { code: "INTERRUPTED", message: "Process ended before tool settlement" }, finishedAt: new Date().toISOString() };
        this.records.set(record.id, record);
      }
    }
  }

  write(record) {
    this.records.set(record.id, structuredClone(record));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify([...this.records.values()], null, 2), "utf8");
    fs.renameSync(temporary, this.file);
  }

  all() { return [...this.records.values()]; }
}

export class ToolRuntime {
  constructor({ store, handlers = {}, policyVersion = "policy-v1", journal = null } = {}) {
    if (!store) throw new PolicyError("Tool runtime store is required", "CONFIG_REQUIRED");
    this.store = store;
    this.handlers = new Map(Object.entries(handlers));
    this.policyVersion = policyVersion;
    this.journal = journal;
    this.runs = new Map();
    this.idempotency = new Map();
    for (const record of journal?.all?.() || []) {
      this.runs.set(record.id, record);
      this.idempotency.set(record.idempotencyKey, { requestHash: record.requestHash, record });
    }
  }

  async execute({ tool, runId, agentRunId, inputSnapshotId, idempotencyKey, timeoutMs = 120000, requestedScope = {}, input = {}, replay = "unsafe" } = {}) {
    if (!tool || !runId || !agentRunId || !inputSnapshotId || !idempotencyKey) throw new PolicyError("tool, run, snapshot and idempotency fields are required", "INVALID_INPUT");
    const handler = this.handlers.get(tool);
    if (typeof handler !== "function") throw new PolicyError(`Tool handler is not registered: ${tool}`, "POLICY_DENIED");
    const previous = this.idempotency.get(idempotencyKey);
    const requestHash = crypto.createHash("sha256").update(JSON.stringify({ tool, runId, agentRunId, inputSnapshotId, requestedScope, input })).digest("hex");
    if (previous) {
      if (previous.requestHash !== requestHash) throw new PolicyError("Idempotency key input conflict", "IDEMPOTENCY_CONFLICT");
      if (previous.record.status === "interrupted") throw new PolicyError("Tool execution was interrupted; create a new reviewed run", "INTERRUPTED");
      return previous.record;
    }
    if (replay !== "safe" && replay !== "unsafe") throw new PolicyError("Invalid tool replay policy", "INVALID_INPUT");
    const record = { id: `toolrun_${crypto.randomUUID().replaceAll("-", "")}`, tool, runId, agentRunId, inputSnapshotId, idempotencyKey, requestHash, requestedScope, policyVersion: this.policyVersion, replay, status: "intent_committed", startedAt: new Date().toISOString() };
    this.runs.set(record.id, record);
    this.journal?.write(record);
    record.status = "running";
    this.journal?.write(record);
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new PolicyError("Tool execution timed out", "TIMEOUT")), Math.min(Math.max(timeoutMs, 1), 15 * 60 * 1000));
      });
      const output = await Promise.race([handler(input), timeout]);
      record.status = "succeeded";
      record.output = output;
      record.finishedAt = new Date().toISOString();
      this.journal?.write(record);
    } catch (error) {
      record.status = error.code === "NEEDS_INPUT" ? "needs_input" : "failed";
      record.error = { code: error.code || "TOOL_FAILED", message: error.message };
      record.finishedAt = new Date().toISOString();
      this.journal?.write(record);
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.idempotency.set(idempotencyKey, { requestHash, record });
    if (record.status === "failed" || record.status === "needs_input") throw Object.assign(new PolicyError(record.error.message, record.error.code), { toolRun: record });
    return record;
  }

  async resumeInterrupted({ idempotencyKey, newIdempotencyKey, newAgentRunId, reviewedBy, input, timeoutMs, requestedScope } = {}) {
    if (!idempotencyKey || !newIdempotencyKey || !newAgentRunId || !reviewedBy || !input) {
      throw new PolicyError("Interrupted tool recovery requires a new run, idempotency key, input and reviewer", "INVALID_INPUT");
    }
    const previous = this.idempotency.get(idempotencyKey);
    if (!previous || previous.record.status !== "interrupted") throw new PolicyError("Interrupted tool record not found", "RESOURCE_NOT_FOUND");
    if (previous.record.replay !== "safe") throw new PolicyError("Unsafe interrupted tools require a new reviewed operation", "POLICY_DENIED");
    const decision = { reviewedBy, recoveredFrom: previous.record.id, at: new Date().toISOString() };
    const result = await this.execute({
      tool: previous.record.tool,
      runId: previous.record.runId,
      agentRunId: newAgentRunId,
      inputSnapshotId: previous.record.inputSnapshotId,
      idempotencyKey: newIdempotencyKey,
      timeoutMs,
      requestedScope: requestedScope || previous.record.requestedScope,
      input,
      replay: "safe"
    });
    result.recovery = decision;
    this.journal?.write(result);
    return result;
  }
}
