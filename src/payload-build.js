import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

import lock from "../sources/payload-website.lock.json" with { type: "json" };
import { PolicyError } from "./core.js";
import { TemplateSnapshotVerifier } from "./template-verifier.js";
import { ProjectWorktreeManager } from "./worktree.js";
import { BuildExecutor, DockerSandboxRunner, LockedDependencyInstaller } from "./build-executor.js";
import { verifyPayloadCandidateBinding } from "./payload-binding.js";

const execFile = promisify(nodeExecFile);

export class PayloadBuildPipeline {
  constructor({ sourceRoot, worktreeRoot, image, runner = execFile, previewNetwork = null, previewFetch = globalThis.fetch } = {}) {
    if (![sourceRoot, worktreeRoot].every((value) => typeof value === "string" && path.isAbsolute(value))) throw new PolicyError("Payload source and worktree roots must be absolute", "CONFIG_REQUIRED");
    this.sourceRoot = path.resolve(sourceRoot);
    this.worktreeRoot = path.resolve(worktreeRoot);
    this.runner = runner;
    this.image = image;
    this.previewNetwork = previewNetwork;
    this.previewFetch = previewFetch;
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

  async build({ candidateId, candidateHash, worktree, grant } = {}) {
    if (grant?.level !== "L2") throw new PolicyError("Payload build requires L2", "POLICY_DENIED");
    if (!worktree || worktree.baseCommit !== lock.commit || typeof worktree.repositoryPathRef !== "string") throw new PolicyError("Build requires a pinned Payload worktree", "STALE_REVISION");
    const sandbox = new DockerSandboxRunner({ image: this.image, runner: this.runner });
    const root = path.resolve(this.worktreeRoot);
    const projectRoot = path.resolve(root, worktree.repositoryPathRef);
    const [actualRoot, actualProject] = await Promise.all([fs.realpath(root), fs.realpath(projectRoot)]);
    if (!actualProject.startsWith(`${actualRoot}${path.sep}`)) throw new PolicyError("Payload worktree escapes configured root", "POLICY_DENIED");
    const head = (await this.git(["-C", actualProject, "rev-parse", "HEAD"])).trim().toLowerCase();
    if (head !== lock.commit) throw new PolicyError("Payload worktree HEAD differs from lock", "STALE_REVISION");
    const worktreeList = await this.git(["-C", this.sourceRoot, "worktree", "list", "--porcelain"]);
    if (!worktreeList.split(/\n(?=worktree )/).some((entry) => entry.split("\n", 1)[0] === `worktree ${actualProject}`)) {
      throw new PolicyError("Payload worktree is not registered by the pinned source", "STALE_REVISION");
    }
    if (candidateHash) await verifyPayloadCandidateBinding({ payloadRoot: root, payloadWorktree: worktree });
    const lockPath = path.resolve(projectRoot, "pnpm-lock.yaml");
    const actualLock = await fs.realpath(lockPath);
    if (!actualLock.startsWith(`${actualProject}${path.sep}`)) throw new PolicyError("Payload lockfile escapes worktree root", "POLICY_DENIED");
    let runtime;
    try {
      runtime = await sandbox.run("node", ["--version"], { cwd: actualProject, timeout: 10_000, maxBuffer: 1024 });
    } catch (error) {
      if (error.code === "ENOENT") throw new PolicyError("Docker sandbox is not installed", "SANDBOX_REQUIRED");
      throw error;
    }
    const version = /^v(\d+)\.(\d+)\.(\d+)/.exec(String(runtime.stdout || "").trim());
    if (!version || Number(version[1]) < 24 || Number(version[1]) === 24 && Number(version[2]) < 15) throw new PolicyError("Payload template requires Node 24.15+ in sandbox", "SANDBOX_REQUIRED");
    let pnpm;
    try {
      pnpm = await sandbox.run("pnpm", ["--version"], { cwd: actualProject, timeout: 10_000, maxBuffer: 1024 });
    } catch (error) {
      if (error.code === "ENOENT" || /executable file not found|not found/i.test(error.stderr || error.message || "")) {
        throw new PolicyError("Payload sandbox image must include pnpm; corepack alone is insufficient offline", "SANDBOX_REQUIRED");
      }
      throw error;
    }
    if (!/^\d+\.\d+\.\d+/.test(String(pnpm.stdout || "").trim())) throw new PolicyError("Payload sandbox pnpm version could not be verified", "SANDBOX_REQUIRED");
    const lockHash = crypto.createHash("sha256").update(await fs.readFile(lockPath)).digest("hex");
    const installer = new LockedDependencyInstaller({ worktreeRoot: root, sandbox, approvedWorkspaceFilters: ["website..."] });
    const install = await installer.install({ worktreePath: worktree.repositoryPathRef, packageManager: "pnpm", lockHash: { file: "pnpm-lock.yaml", sha256: lockHash }, workspaceFilter: "website...", grant });
    const executor = new BuildExecutor({ worktreeRoot: root, sandbox, approvedScripts: { "website-build": { command: "pnpm", args: ["--filter", "website", "build"] } } });
    const build = await executor.run({ candidateId, worktreePath: worktree.repositoryPathRef, commit: lock.commit, approvedScriptIds: ["website-build"], grant, timeoutMs: 15 * 60 * 1000 });
    return Object.freeze({ candidateId, candidateHash: candidateHash || null, sourceCommit: lock.commit, lockHash, install, build, buildState: "sandbox_build_passed" });
  }

  async startPreview({ candidateId, candidateHash, worktree, grant, ttlMs = 15 * 60 * 1000 } = {}) {
    if (grant?.level !== "L2") throw new PolicyError("Payload preview requires L2", "POLICY_DENIED");
    if (!candidateId || typeof candidateHash !== "string" || !/^[a-f0-9]{64}$/i.test(candidateHash)) throw new PolicyError("Payload preview requires a bound candidate hash", "STALE_REVISION");
    if (!this.previewNetwork || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(this.previewNetwork) || ["host", "none"].includes(this.previewNetwork)) throw new PolicyError("Payload preview requires an explicitly configured isolated Docker network", "SANDBOX_REQUIRED");
    if (typeof this.previewFetch !== "function") throw new PolicyError("Payload preview readiness probe is not configured", "CONFIG_REQUIRED");
    let networkState;
    try {
      networkState = await this.runner("docker", ["network", "inspect", "--format", "{{.Internal}}|{{index .Labels \"sitepilot.preview\"}}", this.previewNetwork], { timeout: 10_000, maxBuffer: 1024 });
    } catch (error) {
      if (error.code === "ENOENT") throw new PolicyError("Docker sandbox is not installed", "SANDBOX_REQUIRED");
      throw error;
    }
    if (String(networkState?.stdout || networkState || "").trim() !== "true|true") throw new PolicyError("Payload preview Docker network must be Internal=true and labeled sitepilot.preview=true", "SANDBOX_REQUIRED");
    if (!worktree || worktree.baseCommit !== lock.commit || typeof worktree.repositoryPathRef !== "string") throw new PolicyError("Preview requires a pinned Payload worktree", "STALE_REVISION");
    const root = path.resolve(this.worktreeRoot);
    const projectRoot = path.resolve(root, worktree.repositoryPathRef);
    const [actualRoot, actualProject] = await Promise.all([fs.realpath(root), fs.realpath(projectRoot)]);
    if (!actualProject.startsWith(`${actualRoot}${path.sep}`)) throw new PolicyError("Payload worktree escapes configured root", "POLICY_DENIED");
    const head = (await this.git(["-C", actualProject, "rev-parse", "HEAD"])).trim().toLowerCase();
    if (head !== lock.commit) throw new PolicyError("Payload worktree HEAD differs from lock", "STALE_REVISION");
    const worktreeList = await this.git(["-C", this.sourceRoot, "worktree", "list", "--porcelain"]);
    if (!worktreeList.split(/\n(?=worktree )/).some((entry) => entry.split("\n", 1)[0] === `worktree ${actualProject}`)) throw new PolicyError("Payload worktree is not registered by the pinned source", "STALE_REVISION");
    if (candidateHash) await verifyPayloadCandidateBinding({ payloadRoot: root, payloadWorktree: worktree });
    const port = await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const value = probe.address().port;
        probe.close((error) => error ? reject(error) : resolve(value));
      });
    });
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (!Number.isInteger(uid) || uid === 0 || !Number.isInteger(gid)) throw new PolicyError("Payload preview runner must be launched by a non-root user", "SANDBOX_REQUIRED");
    const args = [
      "run", "--rm", "--detach", "--network", this.previewNetwork, "--publish", `127.0.0.1:${port}:3000`,
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "128", "--memory", "768m", "--cpus", "1",
      "--user", `${uid}:${gid}`, "--workdir", "/workspace", "--mount", `type=bind,src=${actualProject},dst=/workspace,readonly`, "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m", "--tmpfs", "/workspace/website/.next/cache:rw,nosuid,nodev,size=128m",
      "--env", "HOME=/tmp", "--env", "CI=1", "--env", "NEXT_TELEMETRY_DISABLED=1", this.image,
      "pnpm", "--filter", "website", "exec", "next", "start", "--hostname", "0.0.0.0", "--port", "3000",
    ];
    let containerId;
    try {
      const result = await this.runner("docker", args, { timeout: 30_000, maxBuffer: 4096 });
      containerId = String(result?.stdout || result || "").trim().split(/\s+/)[0];
      if (!/^[a-f0-9]{12,64}$/i.test(containerId)) throw new PolicyError("Payload preview runner returned no container id", "SANDBOX_REQUIRED");
      const baseUrl = `http://127.0.0.1:${port}/`;
      const deadline = Date.now() + 20_000;
      let ready = false;
      while (Date.now() < deadline) {
        try {
          const response = await this.previewFetch(new URL("api/users/me", baseUrl), { redirect: "manual" });
          const contentType = response?.headers?.get?.("content-type") || "";
          if ([200, 401, 403].includes(response?.status) && contentType.includes("application/json")) { ready = true; break; }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!ready) throw new PolicyError("Payload preview did not become ready", "SANDBOX_REQUIRED");
      const expiresAt = Date.now() + Math.min(Math.max(Number(ttlMs) || 0, 60_000), 60 * 60 * 1000);
      let stopped = false;
      return Object.freeze({ candidateId, candidateHash, baseUrl, containerId, expiresAt, stop: async () => {
        if (stopped) return;
        stopped = true;
        await this.runner("docker", ["stop", "--time", "5", containerId], { timeout: 15_000, maxBuffer: 4096 }).catch(() => {});
      } });
    } catch (error) {
      if (containerId) await this.runner("docker", ["stop", "--time", "1", containerId], { timeout: 15_000, maxBuffer: 4096 }).catch(() => {});
      throw error;
    }
  }

  async git(args) {
    const result = await this.runner("git", args, { maxBuffer: 16 * 1024 * 1024 });
    return typeof result === "string" ? result : result.stdout || "";
  }
}
