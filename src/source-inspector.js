import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { PolicyError } from "./core.js";

const SNAPSHOT_ID = /^source_[a-z0-9]+$/;
const LICENSE_NAMES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING", "NOTICE", "NOTICE.md"];
const LOCK_NAMES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb"];

function safeSnapshotPath(root, id) {
  if (!path.isAbsolute(root) || typeof id !== "string" || !SNAPSHOT_ID.test(id)) {
    throw new PolicyError("Invalid quarantine snapshot reference", "POLICY_DENIED");
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, id);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new PolicyError("Snapshot escapes quarantine root", "POLICY_DENIED");
  return resolved;
}

async function readOptional(file) {
  try { return await fs.readFile(file, "utf8"); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export class SourcePackageInspector {
  constructor({ quarantineRoot }) {
    if (!quarantineRoot || !path.isAbsolute(quarantineRoot)) throw new PolicyError("Quarantine root must be absolute", "POLICY_DENIED");
    this.quarantineRoot = path.resolve(quarantineRoot);
  }

  async inspect({ quarantineSnapshotId, paths = [], targetStack = "nextjs-payload" } = {}) {
    const root = safeSnapshotPath(this.quarantineRoot, quarantineSnapshotId);
    const stat = await fs.stat(root).catch(() => null);
    if (!stat?.isDirectory()) throw new PolicyError("Quarantine snapshot does not exist", "RESOURCE_NOT_FOUND");
    const requested = paths.length ? paths : ["."];
    const files = await this.listFiles(root, requested);
    const names = new Set(files.map((file) => path.relative(root, file).replaceAll(path.sep, "/")));
    const licenseFiles = [...names].filter((name) => LICENSE_NAMES.includes(name) || LICENSE_NAMES.some((license) => name.endsWith(`/${license}`)));
    const packageFiles = [...names].filter((name) => name === "package.json" || name.endsWith("/package.json"));
    const lockFiles = [...names].filter((name) => LOCK_NAMES.includes(name));
    const scripts = [];
    const dependencies = {};
    for (const packageFile of packageFiles) {
      const parsed = await this.readJson(path.join(root, packageFile));
      if (!parsed) continue;
      for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        for (const [name, version] of Object.entries(parsed[section] || {})) dependencies[name] = String(version);
      }
      for (const [name, command] of Object.entries(parsed.scripts || {})) scripts.push({ name, command: String(command), packagePath: packageFile });
    }
    const unsafeScripts = scripts.filter(({ command }) => /\b(curl|wget|nc|ssh|sudo|rm\s+-rf|git\s+push)\b/i.test(command));
    const assetFiles = [...names].filter((name) => /\.(?:png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf)$/i.test(name));
    const manifest = files.map((file) => path.relative(root, file).replaceAll(path.sep, "/")).sort();
    const manifestHash = crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    const licenseConclusion = licenseFiles.length ? "identified" : "missing";
    const risks = [];
    if (!licenseFiles.length) risks.push("license_or_notice_missing");
    if (!lockFiles.length) risks.push("lockfile_missing");
    if (unsafeScripts.length) risks.push("script_requires_manual_review");
    if (assetFiles.length) risks.push("assets_require_file_level_attribution");
    return {
      quarantineSnapshotId,
      targetStack,
      licenseConclusion,
      licenseFiles,
      dependencies,
      lockFiles,
      scripts,
      assets: assetFiles,
      risks,
      reuseMode: licenseConclusion === "identified" && !unsafeScripts.length ? "copied-with-modification" : "reference-only",
      allowedToAdapt: licenseConclusion === "identified" && !unsafeScripts.length,
      fileManifest: manifest,
      fileManifestHash: manifestHash,
    };
  }

  async listFiles(root, requested) {
    const results = [];
    for (const requestedPath of requested) {
      if (typeof requestedPath !== "string" || path.isAbsolute(requestedPath)) throw new PolicyError("Inspection paths must be relative", "POLICY_DENIED");
      const target = path.resolve(root, requestedPath);
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new PolicyError("Inspection path escapes snapshot", "POLICY_DENIED");
      await this.walk(root, target, results);
    }
    return [...new Set(results)];
  }

  async walk(root, target, results) {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new PolicyError("Symlinks are not allowed in source inspection", "SOURCE_INVALID");
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(target)) await this.walk(root, path.join(target, entry), results);
      return;
    }
    if (stat.isFile()) results.push(target);
  }

  async readJson(file) {
    const content = await readOptional(file);
    if (!content) return null;
    try { return JSON.parse(content); } catch { return null; }
  }
}
