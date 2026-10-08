import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { PolicyError } from "./core.js";

function hashRoutes(routes) {
  return crypto.createHash("sha256").update(JSON.stringify(routes)).digest("hex");
}

export async function validateGeneratedCandidate({ worktreeRoot } = {}) {
  if (!worktreeRoot || !path.isAbsolute(worktreeRoot)) throw new PolicyError("Build worktree root must be absolute", "POLICY_DENIED");
  const root = path.resolve(worktreeRoot);
  const manifestPath = path.join(root, "src/generated/sitepilot-manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new PolicyError(`Generated candidate manifest is invalid: ${error.message}`, "BUILD_FAILED");
  }
  if (!Array.isArray(manifest.routes) || !manifest.sourceManifestHash || hashRoutes(manifest.routes) !== manifest.sourceManifestHash) {
    throw new PolicyError("Generated candidate manifest hash is invalid", "BUILD_FAILED");
  }
  const missingFiles = [];
  for (const route of manifest.routes) {
    if (typeof route.file !== "string" || !route.file.startsWith("src/app/")) {
      missingFiles.push(route.file || "missing route file");
      continue;
    }
    try {
      const file = await fs.readFile(path.join(root, route.file), "utf8");
      if (!file.includes(`data-sitepilot-page=\"${route.page}\"`)) missingFiles.push(route.file);
    } catch {
      missingFiles.push(route.file);
    }
  }
  if (missingFiles.length) throw new PolicyError(`Generated candidate files are missing or invalid: ${missingFiles.join(", ")}`, "BUILD_FAILED");
  return Object.freeze({ passed: true, check: "generated-candidate", routeCount: manifest.routes.length, sourceManifestHash: manifest.sourceManifestHash });
}
