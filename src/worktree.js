import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

import { PolicyError } from "./core.js";

const execFile = promisify(nodeExecFile);
const ID = /^[a-zA-Z0-9_-]+$/;
const SHA = /^[0-9a-f]{40}$/i;

export class ProjectWorktreeManager {
  constructor({ root, snapshots = {}, runner = execFile } = {}) {
    if (!root || !path.isAbsolute(root)) throw new PolicyError("Worktree root must be absolute", "POLICY_DENIED");
    this.root = path.resolve(root);
    this.snapshots = new Map(Object.entries(snapshots));
    this.runner = runner;
  }

  async create({ projectId, runId, templateCommit, grant, allowedPaths = ["src", "public", "tests", "package.json", "pnpm-lock.yaml", "README.md"] } = {}) {
    if (grant?.level !== "L2") throw new PolicyError("create_project_worktree requires an L2 grant", "POLICY_DENIED");
    if (![projectId, runId].every((value) => typeof value === "string" && ID.test(value))) throw new PolicyError("Invalid project or run identifier", "INVALID_INPUT");
    if (typeof templateCommit !== "string" || !SHA.test(templateCommit)) throw new PolicyError("Worktree requires a full template commit SHA", "REVISION_REQUIRED");
    const registered = this.snapshots.get(templateCommit.toLowerCase());
    const snapshot = typeof registered === "string" ? { path: registered } : registered;
    const snapshotPath = snapshot?.path;
    if (!snapshotPath || !path.isAbsolute(snapshotPath)) throw new PolicyError("Template snapshot is not registered", "RESOURCE_NOT_FOUND");
    const includePaths = snapshot.includePaths || null;
    if (includePaths && (!Array.isArray(includePaths) || includePaths.some((item) => typeof item !== "string" || path.isAbsolute(item) || item.split(/[\\/]/).includes("..")))) {
      throw new PolicyError("Registered sparse checkout paths are invalid", "POLICY_DENIED");
    }
    const projectPath = snapshot.projectPath || "";
    if (projectPath && (!includePaths || !includePaths.some((item) => projectPath === item || projectPath.startsWith(`${item}/`)))) {
      throw new PolicyError("Project path must be inside registered sparse checkout paths", "POLICY_DENIED");
    }
    const worktreeId = `worktree_${crypto.randomUUID().replaceAll("-", "")}`;
    const target = path.resolve(this.root, projectId, runId, worktreeId);
    if (!target.startsWith(`${this.root}${path.sep}`)) throw new PolicyError("Generated worktree escapes configured root", "POLICY_DENIED");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await this.runGit(["-C", snapshotPath, "worktree", "add", "--detach", ...(includePaths ? ["--no-checkout"] : []), target, templateCommit.toLowerCase()]);
    if (includePaths) {
      await this.runGit(["-C", target, "sparse-checkout", "init", "--no-cone"]);
      await this.runGit(["-C", target, "sparse-checkout", "set", "--no-cone", "--", ...includePaths]);
      await this.runGit(["-C", target, "checkout", "--quiet", "--detach", templateCommit.toLowerCase()]);
    }
    const projectRoot = projectPath ? path.join(target, projectPath) : target;
    return { worktreeId, pathRef: path.relative(this.root, projectRoot), repositoryPathRef: path.relative(this.root, target), baseCommit: templateCommit.toLowerCase(), allowedPaths };
  }

  async runGit(args) {
    return this.runner("git", args, { maxBuffer: 16 * 1024 * 1024 });
  }
}
