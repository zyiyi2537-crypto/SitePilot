import crypto from "node:crypto";

import { PolicyError } from "./core.js";

const PROFILES = Object.freeze({
  website: ["links", "locale", "responsive", "form", "seo"],
  industrial: ["links", "locale", "responsive", "product-fields", "form", "seo"],
  saas: ["links", "locale", "responsive", "pricing-evidence", "form", "seo"],
});

export class QualityAdapter {
  constructor({ preview, checkers = {} } = {}) {
    if (!preview || typeof preview.inspect !== "function") throw new PolicyError("QA preview adapter is required", "CONFIG_REQUIRED");
    this.preview = preview;
    this.checkers = new Map(Object.entries(checkers));
  }

  async run({ candidateId, candidateHash, qaPreviewId, routes = ["/"], locales = ["en"], viewports = [{ width: 1280, height: 800 }, { width: 390, height: 844 }], checkProfile = "website", testMode = "read-only" } = {}) {
    if (!candidateId || !candidateHash || !qaPreviewId) throw new PolicyError("candidate_id, candidate_hash and qa_preview_id are required", "INVALID_INPUT");
    if (testMode !== "read-only" && testMode !== "sandbox-write") throw new PolicyError("Unsupported QA test mode", "POLICY_DENIED");
    const checks = PROFILES[checkProfile];
    if (!checks) throw new PolicyError(`Unknown QA profile: ${checkProfile}`, "INVALID_INPUT");
    const observations = await this.preview.inspect({ qaPreviewId, routes, locales, viewports, checks, testMode });
    const results = [];
    for (const check of checks) {
      const checker = this.checkers.get(check);
      const result = checker ? await checker({ observations, routes, locales, viewports }) : observations?.checks?.[check];
      if (!result || typeof result.passed !== "boolean") {
        results.push({ check, passed: false, details: "check produced no signed result" });
        continue;
      }
      results.push({ check, passed: Boolean(result?.passed), details: result?.details || "" });
    }
    const passed = results.every((result) => result.passed);
    const reportHash = crypto.createHash("sha256").update(JSON.stringify({ candidateId, candidateHash, qaPreviewId, results })).digest("hex");
    return { candidateId, candidateHash, qaPreviewId, results, passed, reportHash, deliveryPreviewMoved: false, testMode };
  }
}
