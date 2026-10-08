import path from "node:path";

import { PolicyError } from "./core.js";

export function validateDeploymentConfig(env = process.env) {
  for (const name of ["SITEPILOT_API_TOKEN", "SITEPILOT_REVIEW_TOKEN", "SITEPILOT_REVIEWER_ID"]) {
    if (!env[name]) throw new PolicyError(`${name} is required`, "CONFIG_REQUIRED");
  }
  if (env.SITEPILOT_API_TOKEN.length < 32 || env.SITEPILOT_REVIEW_TOKEN.length < 32 || env.SITEPILOT_API_TOKEN === env.SITEPILOT_REVIEW_TOKEN) throw new PolicyError("API and reviewer tokens must be distinct and at least 32 characters", "POLICY_DENIED");
  for (const name of ["SITEPILOT_STATE_FILE", "SITEPILOT_REGISTRY_FILE", "SITEPILOT_EVIDENCE_FILE", "SITEPILOT_WORKTREE_ROOT", "SITEPILOT_QUARANTINE_ROOT"]) {
    if (!env[name] || !path.isAbsolute(env[name])) throw new PolicyError(`${name} must be an absolute path`, "CONFIG_REQUIRED");
  }
  if (!/^[1-9]\d{0,4}$/.test(String(env.PORT || "3100")) || Number(env.PORT || 3100) > 65535) throw new PolicyError("PORT must be between 1 and 65535", "INVALID_INPUT");
  if (!["127.0.0.1", "0.0.0.0"].includes(env.SITEPILOT_HOST || "127.0.0.1")) throw new PolicyError("SITEPILOT_HOST must be 127.0.0.1 or 0.0.0.0", "POLICY_DENIED");
  const codeAtlas = [env.CODEATLAS_MCP_URL, env.CODEATLAS_MCP_TOKEN, env.CODEATLAS_REPOSITORIES];
  if (codeAtlas.some(Boolean) && codeAtlas.some((value) => !value)) throw new PolicyError("CodeAtlas URL, token and repository allowlist must be configured together", "CONFIG_REQUIRED");
  if (env.CODEATLAS_MCP_URL && new URL(env.CODEATLAS_MCP_URL).protocol !== "https:") throw new PolicyError("CodeAtlas MCP must use HTTPS", "POLICY_DENIED");
  const payload = [env.PAYLOAD_SANDBOX_URL, env.PAYLOAD_SANDBOX_TOKEN];
  if (payload.some(Boolean) && payload.some((value) => !value)) throw new PolicyError("Payload sandbox URL and token must be configured together", "CONFIG_REQUIRED");
  if (env.PAYLOAD_SANDBOX_URL && new URL(env.PAYLOAD_SANDBOX_URL).protocol !== "https:") throw new PolicyError("Payload sandbox must use HTTPS", "POLICY_DENIED");
  return Object.freeze({ valid: true, codeAtlasConfigured: codeAtlas.every(Boolean), payloadSandboxConfigured: payload.every(Boolean), persistentStoresConfigured: true });
}
