import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

import lock from "../sources/payload-website.lock.json" with { type: "json" };
import { PolicyError } from "./core.js";
import { TemplateSnapshotVerifier } from "./template-verifier.js";
import { ProjectWorktreeManager } from "./worktree.js";
import { BuildExecutor, DockerSandboxRunner, LockedDependencyInstaller } from "./build-executor.js";

const execFile = promisify(nodeExecFile);

export class PayloadBuildPipeline {
  constructor({ sourceRoot, worktreeRoot, image, runner = execFile } = {}) {
    if (![sourceRoot, worktreeRoot].every((value) => typeof value === "string" && path.isAbsolute(value))) throw new PolicyError("Payload source and worktree roots must be absolute", "CONFIG_REQUIRED");
    this.sourceRoot = path.resolve(sourceRoot);
    this.worktreeRoot = path.resolve(worktreeRoot);
    this.runner = runner;
    this.image = image;
  }

  async prepare({ projectId, runId, grant } = {}) {
    if (grant?.level !== "L2") throw new PolicyError("Payload worktree preparation requires L2", "POLICY_DENIED");
    const verified = await new TemplateSnapshotVerifier({ lock, root: this.sourceRoot }).verify();
    const head = (await this.git(["-C", this.sourceRoot, "rev-parse", "HEAD"])).trim().toLowerCase();
    if (head !== lock.commit) throw new PolicyError("Payload source HEAD differs from lock", "STALE_REVISION");
    const dirty = (await this.git(["-C", this.sourceRoot, "status", "--porcelain", "--untracked-files=all"])).trim();
    if (dirty) throw new PolicyError("Pinned Payload source has local changes", "STALE_REVISION");
    const manager = new ProjectWorktreeManager({ root: this.worktreeRoot, snapshots: { [lock.commit]: { path: this.sourceRoot, includePaths: lock.includePaths, projectPath: lock.path } }, runner: this.runner });
    const worktree = await manager.create({ projectId, runId, templateCommit: lock.commit, grant });
    return Object.freeze({ ...worktree, sourceId: lock.sourceId, templateManifestHash: verified.manifestHash, buildState: "prepared_not_built" });
  }

  async build({ candidateId, worktree, grant } = {}) {
    if (grant?.level !== "L2") throw new PolicyError("Payload build requires L2", "POLICY_DENIED");
    if (!worktree || worktree.baseCommit !== lock.commit || typeof worktree.repositoryPathRef !== "string") throw new PolicyError("Build requires a pinned Payload worktree", "STALE_REVISION");
    const sandbox = new DockerSandboxRunner({ image: this.image, runner: this.runner });
    const root = path.resolve(this.worktreeRoot);
    const projectRoot = path.resolve(root, worktree.repositoryPathRef);
    const [actualRoot, actualProject] = await Promise.all([fs.realpath(root), fs.realpath(projectRoot)]);
    if (!actualProject.startsWith(`${actualRoot}${path.sep}`)) throw new PolicyError("Payload worktree escapes configured root", "POLICY_DENIED");
    const lockPath = path.resolve(projectRoot, "pnpm-lock.yaml");
    if (!lockPath.startsWith(`${root}${path.sep}`)) throw new PolicyError("Payload lockfile escapes worktree root", "POLICY_DENIED");
    let runtime;
    try {
      runtime = await sandbox.run("node", ["--version"], { cwd: actualProject, timeout: 10_000, maxBuffer: 1024 });
    } catch (error) {
      if (error.code === "ENOENT") throw new PolicyError("Docker sandbox is not installed", "SANDBOX_REQUIRED");
      throw error;
    }
    const version = /^v(\d+)\.(\d+)\.(\d+)/.exec(String(runtime.stdout || "").trim());
    if (!version || Number(version[1]) < 24 || Number(version[1]) === 24 && Number(version[2]) < 15) throw new PolicyError("Payload template requires Node 24.15+ in sandbox", "SANDBOX_REQUIRED");
    const lockHash = crypto.createHash("sha256").update(await fs.readFile(lockPath)).digest("hex");
    const installer = new LockedDependencyInstaller({ worktreeRoot: root, sandbox, approvedWorkspaceFilters: ["website..."] });
    const install = await installer.install({ worktreePath: worktree.repositoryPathRef, packageManager: "pnpm", lockHash: { file: "pnpm-lock.yaml", sha256: lockHash }, workspaceFilter: "website...", grant });
    const executor = new BuildExecutor({ worktreeRoot: root, sandbox, approvedScripts: { "website-build": { command: "pnpm", args: ["--filter", "website", "build"] } } });
    const build = await executor.run({ candidateId, worktreePath: worktree.repositoryPathRef, commit: lock.commit, approvedScriptIds: ["website-build"], grant, timeoutMs: 15 * 60 * 1000 });
    return Object.freeze({ candidateId, sourceCommit: lock.commit, lockHash, install, build, buildState: "sandbox_build_passed" });
  }

  async git(args) {
    const result = await this.runner("git", args, { maxBuffer: 16 * 1024 * 1024 });
    return typeof result === "string" ? result : result.stdout || "";
  }
}
