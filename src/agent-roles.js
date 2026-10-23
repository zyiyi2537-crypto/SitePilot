import { PolicyError } from "./core.js";

export const AGENT_ROLES = Object.freeze([
  "Supervisor",
  "Architect",
  "Research",
  "ContentCMS",
  "Coding",
  "QA",
  "Review",
]);

export const ROLE_POLICIES = Object.freeze({
  Supervisor: Object.freeze({ tools: ["delegate_architect", "delegate_research", "request_customer_input", "complete_plan"], writes: ["artifacts", "task_state"], risk: "medium" }),
  Architect: Object.freeze({ tools: ["submit_site_strategy"], writes: ["SiteStrategy", "PagePlan", "DesignTokens"], risk: "low" }),
  Research: Object.freeze({ tools: ["retrieve_codeatlas", "submit_component_plan"], writes: ["ComponentPlan", "evidence"], risk: "low" }),
  ContentCMS: Object.freeze({ tools: ["inspect_payload_schema", "create_payload_draft"], writes: ["payload_sandbox"], risk: "medium" }),
  Coding: Object.freeze({ tools: ["inspect_source_package", "apply_code_patch", "run_build_and_tests"], writes: ["project_worktree"], risk: "high" }),
  QA: Object.freeze({ tools: ["run_quality_checks"], writes: ["quality_report", "qa_sandbox"], risk: "low" }),
  Review: Object.freeze({ tools: ["inspect_source_package", "run_quality_checks"], writes: ["ReviewDecision"], risk: "medium" }),
});

export const ARTIFACT_TYPES = Object.freeze([
  "RequirementBrief",
  "SupervisorDecision",
  "SiteStrategy",
  "PagePlan",
  "DesignTokens",
  "ComponentPlan",
  "ContentModel",
  "CodePatch",
  "QualityReport",
  "ReviewDecision",
]);

export function assertAgentRole(role) {
  if (!AGENT_ROLES.includes(role)) throw new PolicyError(`Unknown agent role: ${role}`, "INVALID_INPUT");
  return ROLE_POLICIES[role];
}

export function assertRoleTool(role, tool) {
  const policy = assertAgentRole(role);
  if (!policy.tools.includes(tool)) {
    throw new PolicyError(`${role} cannot use ${tool}`, "POLICY_DENIED");
  }
  return true;
}

export function assertArtifactType(type) {
  if (!ARTIFACT_TYPES.includes(type)) throw new PolicyError(`Unsupported agent artifact: ${type}`, "SCHEMA_REJECTED");
  return type;
}

export function roleSystemPrompt(role) {
  const policy = assertAgentRole(role);
  return [
    `You are SitePilot's ${role} agent.`,
    "You are one bounded specialist inside a supervisor-controlled workflow.",
    "Return only the requested structured artifact or a structured stop decision.",
    "Never invent customer facts, credentials, source licenses, test results, or approval decisions.",
    `Allowed tools: ${policy.tools.length ? policy.tools.join(", ") : "none"}.`,
    `Writable outputs: ${policy.writes.join(", ")}.`,
    "Use evidence references and mark missing information as needs_input.",
  ].join(" ");
}

export function createArtifact({ type, role, runId, inputRefs = [], output, status = "complete", risk = "low" } = {}) {
  assertArtifactType(type);
  assertAgentRole(role);
  if (!runId || typeof runId !== "string") throw new PolicyError("Artifact runId is required", "INVALID_INPUT");
  if (output === undefined) throw new PolicyError("Artifact output is required", "INVALID_INPUT");
  if (!Array.isArray(inputRefs) || inputRefs.length > 50 || inputRefs.some((ref) => typeof ref !== "string" || ref.length > 200)) {
    throw new PolicyError("Artifact input references are invalid", "SCHEMA_REJECTED");
  }
  const freeze = (value) => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) freeze(child);
    return Object.freeze(value);
  };
  return freeze({
    type,
    role,
    runId,
    inputRefs: [...inputRefs],
    output: structuredClone(output),
    status,
    risk,
    createdAt: new Date().toISOString(),
  });
}

export function decisionSchema() {
  return {
    role: "",
    inputRefs: [],
    outputRefs: [],
    action: "",
    arguments: {},
    whyNow: "",
    expectedObservation: "",
    stopIf: [],
    risk: "low",
    permissions: [],
  };
}
