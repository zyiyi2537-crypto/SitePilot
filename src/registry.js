import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { PolicyError } from "./core.js";
import { SqliteState } from "./sqlite-state.js";

const SHA = /^[0-9a-f]{40}$/i;
const STATES = new Set(["candidate", "approved", "revoked"]);

function hash(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export class BlockRegistry {
  constructor({ version = "registry-v1" } = {}) {
    this.version = version;
    this.blocks = new Map();
  }

  register(input = {}) {
    const required = ["name", "kind", "repository", "commit", "path", "license"];
    for (const field of required) if (typeof input[field] !== "string" || !input[field].trim()) throw new PolicyError(`Block registry field is required: ${field}`, "INVALID_INPUT");
    if (!SHA.test(input.commit)) throw new PolicyError("Block registry requires a full commit SHA", "REVISION_REQUIRED");
    const id = input.id || `block_${crypto.randomUUID().replaceAll("-", "")}`;
    const block = Object.freeze({
      id, name: input.name, kind: input.kind, repository: input.repository,
      commit: input.commit.toLowerCase(), path: input.path, license: input.license,
      propsSchema: input.propsSchema || {}, supportedLocales: input.supportedLocales || ["zh-CN", "en"],
      targetStacks: input.targetStacks || ["nextjs-payload"], tests: input.tests || [],
      compatibility: input.compatibility || {}, state: input.state || "candidate",
      sourceRefs: input.sourceRefs || [], createdAt: input.createdAt || new Date().toISOString(),
    });
    if (!STATES.has(block.state)) throw new PolicyError(`Unknown block state: ${block.state}`, "INVALID_INPUT");
    this.blocks.set(id, block);
    return block;
  }

  transition(id, state, review = {}) {
    const block = this.blocks.get(id);
    if (!block) throw new PolicyError("Block not found", "RESOURCE_NOT_FOUND");
    if (!STATES.has(state)) throw new PolicyError(`Unknown block state: ${state}`, "INVALID_INPUT");
    if (state === "approved" && (!review.reviewerId || review.licenseVerified !== true || review.testsPassed !== true)) throw new PolicyError("Block approval requires reviewer, license and test evidence", "POLICY_DENIED");
    const updated = Object.freeze({ ...block, state, review: { ...review, reviewedAt: new Date().toISOString() } });
    this.blocks.set(id, updated);
    return updated;
  }

  select({ kind, stack = "nextjs-payload", locales = [] } = {}) {
    return [...this.blocks.values()].filter((block) => block.state === "approved" && (!kind || block.kind === kind) && block.targetStacks.includes(stack) && locales.every((locale) => block.supportedLocales.includes(locale)));
  }

  manifest() {
    const blocks = [...this.blocks.values()].sort((a, b) => a.id.localeCompare(b.id));
    return { version: this.version, blocks, hash: hash({ version: this.version, blocks }) };
  }
}

export class JsonBlockRegistry extends BlockRegistry {
  constructor(file, options = {}) {
    super(options);
    if (!file || !path.isAbsolute(file)) throw new PolicyError("Registry file must be an absolute configured path", "POLICY_DENIED");
    this.file = path.resolve(file);
    if (fs.existsSync(this.file)) {
      const state = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.version = state.version || this.version;
      for (const block of state.blocks || []) this.blocks.set(block.id, Object.freeze(block));
    }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify({ version: this.version, blocks: [...this.blocks.values()] }, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }

  register(input) { const block = super.register(input); this.persist(); return block; }
  transition(...args) { const block = super.transition(...args); this.persist(); return block; }
}

export class SqliteBlockRegistry extends BlockRegistry {
  constructor(file, options = {}) {
    super(options);
    this.state = new SqliteState(file, "registry", { version: this.version, blocks: [] });
    this.version = this.state.data.version;
    for (const block of this.state.data.blocks || []) this.blocks.set(block.id, Object.freeze(block));
  }
  persist() { this.state.save({ version: this.version, blocks: [...this.blocks.values()] }); }
  register(input) { const block = super.register(input); this.persist(); return block; }
  transition(...args) { const block = super.transition(...args); this.persist(); return block; }
  close() { this.state.close(); }
}
