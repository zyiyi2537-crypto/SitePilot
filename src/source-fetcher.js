import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

import { PolicyError } from "./core.js";

const execFile = promisify(nodeExecFile);
const FULL_SHA = /^[0-9a-f]{40}$/i;
const MAX_DEFAULT_BYTES = 250 * 1024 * 1024;

function fullSha(value) {
  if (typeof value !== "string" || !FULL_SHA.test(value)) {
    throw new PolicyError("Pinned source requires a full 40-character commit SHA", "REVISION_REQUIRED");
  }
  return value.toLowerCase();
}

function assertGrant(grant) {
  if (grant?.level !== "L2") throw new PolicyError("fetch_pinned_source requires an L2 grant", "POLICY_DENIED");
}

function assertEvidenceId(value) {
  if (typeof value !== "string" || !value.trim()) throw new PolicyError("source_evidence_id is required", "INVALID_INPUT");
}

function normalizeIncludePaths(values) {
  if (values == null) return null;
  if (!Array.isArray(values) || values.length === 0) throw new PolicyError("include_paths must be a non-empty array", "INVALID_INPUT");
  const paths = [...new Set(values)].map((value) => {
    if (typeof value !== "string" || !value.trim() || path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) {
      throw new PolicyError("include_paths must contain safe relative paths", "POLICY_DENIED");
    }
    return value.replaceAll(path.sep, "/").replace(/^\.\//, "").replace(/\/$/, "");
  });
  return paths;
}

function pathIncluded(file, includePaths) {
  return !includePaths || includePaths.some((prefix) => file === prefix || file.startsWith(`${prefix}/`));
}

export class PinnedSourceFetcher {
  constructor({ quarantineRoot = path.join(os.tmpdir(), "sitepilot-quarantine"), repositories = {}, runner = execFile } = {}) {
    if (!path.isAbsolute(quarantineRoot)) throw new PolicyError("Quarantine root must be absolute", "POLICY_DENIED");
    this.quarantineRoot = path.resolve(quarantineRoot);
    this.repositories = new Map(Object.entries(repositories));
    this.runner = runner;
  }

  async fetch({ repositoryId, commitSha, sourceEvidenceId, sizeLimit = MAX_DEFAULT_BYTES, includePaths = null, grant } = {}) {
    assertGrant(grant);
    assertEvidenceId(sourceEvidenceId);
    const commit = fullSha(commitSha);
    const repository = this.repositories.get(repositoryId);
    if (!repository || typeof repository.url !== "string" || !repository.url.trim()) {
      throw new PolicyError(`Repository is not in the server-side source allowlist: ${repositoryId || "missing"}`, "REPOSITORY_DENIED");
    }
    if (repository.commit && fullSha(repository.commit) !== commit) {
      throw new PolicyError("Requested commit is not the allowlisted repository revision", "STALE_REVISION");
    }
    if (!Number.isSafeInteger(sizeLimit) || sizeLimit <= 0 || sizeLimit > MAX_DEFAULT_BYTES) {
      throw new PolicyError("Invalid source size limit", "INVALID_INPUT");
    }
    const configuredPaths = normalizeIncludePaths(repository.includePaths);
    const requestedPaths = normalizeIncludePaths(includePaths);
    if (configuredPaths && requestedPaths && JSON.stringify(configuredPaths) !== JSON.stringify(requestedPaths)) {
      throw new PolicyError("Requested paths differ from the server-locked source scope", "POLICY_DENIED");
    }
    const scopedPaths = configuredPaths || requestedPaths;

    await fs.mkdir(this.quarantineRoot, { recursive: true });
    const snapshotId = `source_${crypto.randomUUID().replaceAll("-", "")}`;
    const snapshotPath = path.join(this.quarantineRoot, snapshotId);
    await fs.mkdir(snapshotPath, { recursive: true });
    try {
      await this.git(["init", "--quiet", snapshotPath]);
      await this.git(["-C", snapshotPath, "remote", "add", "origin", repository.url]);
      await this.git(["-C", snapshotPath, "fetch", "--quiet", "--no-tags", "--depth", "1", "origin", commit]);
      const verified = (await this.git(["-C", snapshotPath, "rev-parse", "FETCH_HEAD"])).trim().toLowerCase();
      if (verified !== commit) throw new PolicyError("Fetched source commit does not match requested SHA", "STALE_REVISION");
      await this.git(["-C", snapshotPath, "checkout", "--quiet", "--detach", verified]);
      const manifest = await this.inspectTree(snapshotPath, sizeLimit, scopedPaths);
      const archiveArgs = ["-C", snapshotPath, "archive", "--format=tar", verified];
      if (scopedPaths) archiveArgs.push("--", ...scopedPaths);
      const contentHash = crypto.createHash("sha256")
        .update(await this.gitBuffer(archiveArgs))
        .digest("hex");
      if (repository.fileManifestHash && manifest.hash !== repository.fileManifestHash) throw new PolicyError("Pinned source tree manifest does not match lock", "SOURCE_HASH_MISMATCH");
      if (repository.contentHash && contentHash !== repository.contentHash) throw new PolicyError("Pinned source archive does not match lock", "SOURCE_HASH_MISMATCH");
      return {
        quarantineSnapshotId: snapshotId,
        quarantinePathRef: snapshotId,
        repositoryId,
        verifiedCommit: verified,
        fileManifest: manifest.entries,
        fileManifestHash: manifest.hash,
        contentHash,
        sizeBytes: manifest.sizeBytes,
        includePaths: scopedPaths,
        sourceEvidenceId,
      };
    } catch (error) {
      await fs.rm(snapshotPath, { recursive: true, force: true });
      throw error;
    }
  }

  async git(args) {
    const result = await this.runner("git", args, { maxBuffer: 16 * 1024 * 1024 });
    return typeof result === "string" ? result : result.stdout || "";
  }

  async gitBuffer(args) {
    const result = await this.runner("git", args, { maxBuffer: 512 * 1024 * 1024, encoding: "buffer" });
    return Buffer.isBuffer(result) ? result : Buffer.from(result.stdout || "");
  }

  async inspectTree(root, sizeLimit, includePaths = null) {
    const listing = await this.git(["-C", root, "ls-tree", "-r", "-l", "HEAD"]);
    const entries = [];
    let sizeBytes = 0;
    for (const line of listing.splitLines ? listing.splitLines() : listing.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const match = line.match(/^(\d+)\s+(\w+)\s+([0-9a-f]{40})\s+(\d+|-)\t(.+)$/i);
      if (!match) throw new PolicyError("Unable to validate source tree manifest", "SOURCE_INVALID");
      const [, mode, type, blob, sizeValue, file] = match;
      if (!pathIncluded(file, includePaths)) continue;
      if (mode === "120000" || mode === "160000" || type === "commit") throw new PolicyError(`Source contains forbidden link or submodule: ${file}`, "SOURCE_INVALID");
      if (/(^|\/)(?:\.git|\.githooks)(?:\/|$)/i.test(file)) throw new PolicyError(`Source contains forbidden Git control path: ${file}`, "SOURCE_INVALID");
      const size = sizeValue === "-" ? 0 : Number(sizeValue);
      sizeBytes += size;
      if (sizeBytes > sizeLimit) throw new PolicyError("Pinned source exceeds size limit", "SOURCE_TOO_LARGE");
      entries.push({ path: file, mode, type, blob, size });
    }
    const hash = crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
    return { entries, hash, sizeBytes };
  }
}
