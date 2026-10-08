import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

import { PolicyError } from "./core.js";

const execFile = promisify(nodeExecFile);
const SHA = /^[0-9a-f]{40}$/i;
const LOCKFILES = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb"]);
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/i;

function requireSha(value, label) {
  if (typeof value !== "string" || !SHA.test(value)) throw new PolicyError(`${label} requires a full commit SHA`, "REVISION_REQUIRED");
  return value.toLowerCase();
}

async function safeRoot(root, worktreePath) {
  if (!path.isAbsolute(root) || typeof worktreePath !== "string" || path.isAbsolute(worktreePath)) throw new PolicyError("Worktree path must be an internal relative reference", "POLICY_DENIED");
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, worktreePath);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new PolicyError("Worktree path escapes configured root", "POLICY_DENIED");
  const [actualRoot, actualWorktree] = await Promise.all([fs.realpath(resolvedRoot), fs.realpath(resolved)]);
  if (!actualWorktree.startsWith(`${actualRoot}${path.sep}`)) throw new PolicyError("Worktree resolves outside configured root", "POLICY_DENIED");
  return actualWorktree;
}

export class DockerSandboxRunner {
  constructor({ image, runner = execFile, memory = "768m", cpus = "1", pids = 128 } = {}) {
    if (typeof image !== "string" || !/@sha256:[0-9a-f]{64}$/i.test(image) || !IMAGE_DIGEST.test(image.slice(image.lastIndexOf("@") + 1))) {
      throw new PolicyError("Sandbox image must be pinned by sha256 digest", "SANDBOX_REQUIRED");
    }
    this.image = image;
    this.runner = runner;
    this.memory = memory;
    this.cpus = cpus;
    this.pids = pids;
  }

  async run(command, args, options) {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (!Number.isInteger(uid) || uid === 0 || !Number.isInteger(gid)) throw new PolicyError("Sandbox runner must be launched by a non-root user", "SANDBOX_REQUIRED");
    const dockerArgs = [
      "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--pids-limit", String(this.pids),
      "--memory", this.memory, "--cpus", this.cpus,
      "--user", `${uid}:${gid}`, "--workdir", "/workspace",
      "--mount", `type=bind,src=${options.cwd},dst=/workspace`,
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m",
      "--env", "HOME=/tmp", "--env", "CI=1", this.image, command, ...args,
    ];
    return this.runner("docker", dockerArgs, {
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      env: { PATH: process.env.PATH || "", HOME: "/nonexistent" },
    });
  }
}

export class LockedDependencyInstaller {
  constructor({ worktreeRoot, sandbox, approvedWorkspaceFilters = [] } = {}) {
    if (!worktreeRoot || !path.isAbsolute(worktreeRoot)) throw new PolicyError("Dependency worktree root must be absolute", "POLICY_DENIED");
    this.worktreeRoot = path.resolve(worktreeRoot);
    if (!(sandbox instanceof DockerSandboxRunner)) throw new PolicyError("Dependency installer requires a Docker sandbox runner", "SANDBOX_REQUIRED");
    this.sandbox = sandbox;
    this.approvedWorkspaceFilters = new Set(approvedWorkspaceFilters);
  }

  async install({ worktreePath, packageManager, lockHash, workspaceFilter, registryAllowlist = [], grant } = {}) {
    if (grant?.level !== "L2") throw new PolicyError("install_locked_dependencies requires an L2 grant", "POLICY_DENIED");
    const root = await safeRoot(this.worktreeRoot, worktreePath);
    if (!LOCKFILES.has(String(lockHash?.file || ""))) throw new PolicyError("A supported lockfile is required", "LOCKFILE_REQUIRED");
    if (!Array.isArray(registryAllowlist) || registryAllowlist.some((value) => typeof value !== "string" || !/^https:\/\//.test(value))) throw new PolicyError("Registry allowlist must contain HTTPS URLs", "POLICY_DENIED");
    const lockContent = await fs.readFile(path.join(root, lockHash.file));
    const actualHash = crypto.createHash("sha256").update(lockContent).digest("hex");
    if (lockHash.sha256 && lockHash.sha256 !== actualHash) throw new PolicyError("Lockfile hash does not match worktree", "STALE_REVISION");
    if (workspaceFilter && !this.approvedWorkspaceFilters.has(workspaceFilter)) throw new PolicyError("Workspace filter is not approved", "POLICY_DENIED");
    if (workspaceFilter && packageManager !== "pnpm") throw new PolicyError("Workspace filters require pnpm", "POLICY_DENIED");
    const pnpmArgs = ["install", ...(workspaceFilter ? ["--filter", workspaceFilter] : []), "--frozen-lockfile", "--offline", "--ignore-scripts"];
    const command = packageManager === "pnpm" ? ["pnpm", pnpmArgs] : packageManager === "npm" ? ["npm", ["ci", "--offline", "--ignore-scripts"]] : packageManager === "yarn" ? ["yarn", ["install", "--immutable", "--immutable-cache", "--mode=skip-builds"]] : null;
    if (!command) throw new PolicyError("Package manager is not approved", "POLICY_DENIED");
    const result = await this.sandbox.run(command[0], command[1], { cwd: root, timeout: 15 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });
    return { lockfile: lockHash.file, lockfileHash: actualHash, packageManager, registryAllowlist, output: result.stdout || "" };
  }
}

export class BuildExecutor {
  constructor({ worktreeRoot, approvedScripts = {}, sandbox } = {}) {
    if (!worktreeRoot || !path.isAbsolute(worktreeRoot)) throw new PolicyError("Build worktree root must be absolute", "POLICY_DENIED");
    this.worktreeRoot = path.resolve(worktreeRoot);
    this.approvedScripts = new Map(Object.entries(approvedScripts));
    if (!(sandbox instanceof DockerSandboxRunner)) throw new PolicyError("BuildExecutor requires a Docker sandbox runner", "SANDBOX_REQUIRED");
    this.sandbox = sandbox;
  }

  async run({ candidateId, worktreePath, commit, approvedScriptIds = [], grant, timeoutMs = 120000 } = {}) {
    if (grant?.level !== "L2") throw new PolicyError("run_build_and_tests requires an L2 grant", "POLICY_DENIED");
    if (!candidateId) throw new PolicyError("candidate_id is required", "INVALID_INPUT");
    const verifiedCommit = requireSha(commit, "Build commit");
    const root = await safeRoot(this.worktreeRoot, worktreePath);
    if (!Array.isArray(approvedScriptIds) || !approvedScriptIds.length) throw new PolicyError("At least one approved script is required", "SCRIPT_NOT_APPROVED");
    const outputs = [];
    for (const scriptId of approvedScriptIds) {
      const script = this.approvedScripts.get(scriptId);
      if (!script || typeof script.command !== "string" || !Array.isArray(script.args)) throw new PolicyError(`Script is not approved: ${scriptId}`, "SCRIPT_NOT_APPROVED");
      if (!/^(pnpm|npm|yarn|node)$/.test(script.command)) throw new PolicyError(`Executable is not approved: ${script.command}`, "SCRIPT_NOT_APPROVED");
      const result = await this.sandbox.run(script.command, script.args, {
        cwd: root,
        timeout: Math.min(Math.max(timeoutMs, 1000), 15 * 60 * 1000),
        maxBuffer: 64 * 1024 * 1024,
      });
      outputs.push({ scriptId, stdout: result.stdout || "", stderr: result.stderr || "", exitCode: 0 });
    }
    const reportHash = crypto.createHash("sha256").update(JSON.stringify({ candidateId, verifiedCommit, outputs })).digest("hex");
    return { candidateId, commit: verifiedCommit, passed: true, scripts: outputs, reportHash, network: "disabled-by-default" };
  }
}
