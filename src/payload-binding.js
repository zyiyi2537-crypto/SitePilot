import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { PolicyError } from "./core.js";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const ROUTE_FILE = /^src\/app\/\(frontend\)\/(?:[A-Za-z][A-Za-z0-9-]*\/)?page\.tsx$/;
const MANIFEST_FILE = "src/generated/sitepilot-manifest.json";
const SOURCES_FILE = "SOURCES.md";

function relativeFile(value, label) {
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) {
    throw new PolicyError(`${label} must be an internal relative path`, "POLICY_DENIED");
  }
  const normalized = value.replaceAll("\\", "/");
  if (/(^|\/)\.(?:env|git)(?:\/|$)|(^|\/)(?:node_modules|secrets?)(?:\/|$)/i.test(normalized)) {
    throw new PolicyError(`${label} is not writable`, "POLICY_DENIED");
  }
  return normalized;
}

function inside(root, target, label) {
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new PolicyError(`${label} escapes configured root`, "POLICY_DENIED");
  return target;
}

function allowedGeneratedFile(file) {
  return ROUTE_FILE.test(file) || file === MANIFEST_FILE || file === SOURCES_FILE;
}

async function readBounded(root, file) {
  const target = inside(root, path.resolve(root, file), "Generated source");
  const actual = await fs.realpath(target);
  inside(root, actual, "Generated source");
  const stat = await fs.stat(actual);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new PolicyError(`Generated source file is not bounded: ${file}`, "SOURCE_INVALID");
  const content = await fs.readFile(actual);
  if (content.includes(0)) throw new PolicyError(`Generated source contains binary data: ${file}`, "SOURCE_INVALID");
  return { content, size: content.length, sha256: crypto.createHash("sha256").update(content).digest("hex") };
}

export async function bindGeneratedCandidateToPayloadWorktree({ sourceRoot, files, payloadRoot, payloadWorktree } = {}) {
  if (![sourceRoot, payloadRoot].every((value) => typeof value === "string" && path.isAbsolute(value))) throw new PolicyError("Candidate and Payload worktree roots must be absolute", "CONFIG_REQUIRED");
  if (!payloadWorktree || typeof payloadWorktree.repositoryPathRef !== "string" || typeof payloadWorktree.pathRef !== "string") throw new PolicyError("Payload worktree binding is incomplete", "PAYLOAD_WORKTREE_REQUIRED");
  if (!Array.isArray(files) || files.length < 1) throw new PolicyError("Generated candidate files are required", "SOURCE_PACKAGE_REQUIRED");
  const source = await fs.realpath(sourceRoot);
  const payload = await fs.realpath(payloadRoot);
  const repository = inside(payload, await fs.realpath(path.resolve(payload, relativeFile(payloadWorktree.repositoryPathRef, "Payload repository path"))), "Payload repository");
  const project = inside(repository, await fs.realpath(path.resolve(payload, relativeFile(payloadWorktree.pathRef, "Payload project path"))), "Payload project");
  const selected = [...new Set(files.map((file) => relativeFile(file, "Generated source path")).filter(allowedGeneratedFile))].sort();
  if (!selected.some((file) => ROUTE_FILE.test(file))) throw new PolicyError("Generated candidate has no Payload route files", "SOURCE_PACKAGE_REQUIRED");
  const boundFiles = [];
  for (const file of selected) {
    const data = await readBounded(source, file);
    const target = inside(project, path.resolve(project, file), "Payload target");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data.content, "utf8");
    boundFiles.push({ sourcePath: file, targetPath: path.relative(payload, target).replaceAll(path.sep, "/"), size: data.size, sha256: data.sha256 });
  }
  const sourceManifestHash = crypto.createHash("sha256").update(JSON.stringify(boundFiles)).digest("hex");
  const bindingManifestPath = path.relative(payload, path.join(project, "src/generated/sitepilot-candidate-binding.json")).replaceAll(path.sep, "/");
  const manifest = { schemaVersion: "payload-candidate-binding-v1", baseCommit: payloadWorktree.baseCommit || null, sourceManifestHash, files: boundFiles };
  const manifestTarget = inside(payload, path.resolve(payload, bindingManifestPath), "Payload binding manifest");
  await fs.mkdir(path.dirname(manifestTarget), { recursive: true });
  await fs.writeFile(manifestTarget, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return Object.freeze({
    ...payloadWorktree,
    bindingManifestPath,
    sourceManifestHash,
    boundFiles,
  });
}

export async function verifyPayloadCandidateBinding({ payloadRoot, payloadWorktree } = {}) {
  if (typeof payloadRoot !== "string" || !path.isAbsolute(payloadRoot) || !payloadWorktree?.bindingManifestPath || !payloadWorktree?.sourceManifestHash) {
    throw new PolicyError("Payload candidate binding is missing", "STALE_REVISION");
  }
  const root = await fs.realpath(payloadRoot);
  const manifestPath = inside(root, path.resolve(root, relativeFile(payloadWorktree.bindingManifestPath, "Payload binding manifest")), "Payload binding manifest");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== "payload-candidate-binding-v1" || manifest.sourceManifestHash !== payloadWorktree.sourceManifestHash || !Array.isArray(manifest.files)) throw new PolicyError("Payload candidate binding manifest is stale", "STALE_REVISION");
  if (JSON.stringify(manifest.files) !== JSON.stringify(payloadWorktree.boundFiles || [])) throw new PolicyError("Payload candidate binding files changed", "STALE_REVISION");
  for (const file of manifest.files) {
    const actual = await readBounded(root, relativeFile(file.targetPath, "Payload target path"));
    if (actual.sha256 !== file.sha256) throw new PolicyError(`Payload candidate file changed: ${file.targetPath}`, "STALE_REVISION");
  }
  return manifest;
}
