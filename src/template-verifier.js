import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { PolicyError } from "./core.js";

const SHA = /^[0-9a-f]{40}$/i;

export class TemplateSnapshotVerifier {
  constructor({ lock, root } = {}) {
    if (!lock || !SHA.test(lock.commit) || lock.path !== "templates/website") throw new PolicyError("Invalid Payload source lock", "SOURCE_INVALID");
    if (!root || !path.isAbsolute(root)) throw new PolicyError("Template snapshot root must be absolute", "POLICY_DENIED");
    this.lock = lock;
    this.root = path.resolve(root);
  }

  async verify() {
    const template = path.join(this.root, this.lock.path);
    const required = this.lock.requiredFiles.map((file) => path.join(this.root, file));
    for (const file of required) {
      const stat = await fs.stat(file).catch(() => null);
      if (!stat || (!stat.isFile() && !stat.isDirectory())) throw new PolicyError(`Pinned template file is missing: ${file}`, "SOURCE_INCOMPLETE");
    }
    const packageJson = JSON.parse(await fs.readFile(path.join(template, "package.json"), "utf8"));
    if (packageJson.license !== this.lock.expectedLicense) throw new PolicyError("Pinned template license does not match source lock", "LICENSE_INVALID");
    const entries = [];
    await this.walk(template, template, entries);
    entries.sort((a, b) => a.path.localeCompare(b.path));
    const manifestHash = crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
    if (this.lock.templateManifestHash && manifestHash !== this.lock.templateManifestHash) throw new PolicyError("Pinned template manifest does not match source lock", "SOURCE_HASH_MISMATCH");
    if (this.lock.templateFileCount && entries.length !== this.lock.templateFileCount) throw new PolicyError("Pinned template file count does not match source lock", "SOURCE_HASH_MISMATCH");
    const licensePath = this.lock.licenseFiles?.find((file) => file.endsWith("LICENSE.md"));
    if (licensePath && this.lock.verifiedMetadata?.[licensePath]) {
      const licenseHash = crypto.createHash("sha256").update(await fs.readFile(path.join(this.root, licensePath))).digest("hex");
      if (licenseHash !== this.lock.verifiedMetadata[licensePath]) throw new PolicyError("Pinned license file does not match source lock", "SOURCE_HASH_MISMATCH");
    }
    return { sourceId: this.lock.sourceId, commit: this.lock.commit, templatePath: this.lock.path, license: packageJson.license, entries, manifestHash, verified: true };
  }

  async walk(root, current, entries) {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new PolicyError(`Pinned template contains a symlink: ${current}`, "SOURCE_INVALID");
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(current)) await this.walk(root, path.join(current, name), entries);
      return;
    }
    const relative = path.relative(root, current).replaceAll(path.sep, "/");
    entries.push({ path: relative, size: stat.size, sha256: crypto.createHash("sha256").update(await fs.readFile(current)).digest("hex") });
  }
}
