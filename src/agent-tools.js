import { Type } from "@earendil-works/pi-ai";
import { assertRoleTool } from "./agent-roles.js";
import { assertTool, PolicyError } from "./core.js";

const textResult = (details, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(details) }],
  details,
  structuredContent: details,
  ...(isError ? { isError: true } : {}),
});

const descriptions = {
  retrieve_codeatlas: "Search only the server-approved CodeAtlas repository at its frozen full commit.",
  submit_site_strategy: "Submit a validated SiteStrategy artifact for this run.",
  submit_component_plan: "Submit component recommendations that cite evidence retrieved during this task.",
  submit_content_model: "Submit proposed page content with valid project Claim references; missing facts must stop the workflow.",
  submit_code_patch_plan: "Submit a candidate-bound, reviewable code change plan without writing files or running commands.",
  delegate_architect: "Ask the Architect child agent to create a strategy artifact.",
  delegate_research: "Ask the Research child agent to inspect the supplied repository and commit.",
  delegate_content_cms: "Ask the ContentCMS child agent to validate a bounded content model for the current design.",
  delegate_coding: "Ask the Coding child agent to submit a candidate-bound, read-only code patch plan.",
  request_customer_input: "Pause the run and return up to three questions that need customer input.",
  complete_plan: "Finish the current planning stage after required artifacts are available.",
  inspect_payload_schema: "Read the allowlisted Payload schema without changing CMS data.",
  create_payload_draft: "Create bounded draft-only content in the isolated Payload sandbox.",
  inspect_source_package: "Inspect a registered quarantined source package without executing it.",
  apply_code_patch: "Apply a reviewed patch only within the granted project worktree.",
  run_build_and_tests: "Run only pre-approved build and test commands in the isolated sandbox.",
  run_quality_checks: "Run read-only quality checks against the exact candidate revision.",
};
const SAFE_TOOL_NAMES = new Set([
  "retrieve_codeatlas",
  "inspect_payload_schema",
  "submit_site_strategy",
  "submit_component_plan",
  "submit_content_model",
  "submit_code_patch_plan",
  "inspect_source_package",
  "delegate_coding",
  "delegate_architect",
  "delegate_research",
  "request_customer_input",
  "complete_plan",
]);

const decisionFields = () => ({
  whyNow: Type.String({ minLength: 8, maxLength: 300 }),
  expectedObservation: Type.String({ minLength: 8, maxLength: 300 }),
  stopIf: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { maxItems: 5 }),
  risk: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
});

const schemas = {
  retrieve_codeatlas: Type.Object({
    ...decisionFields(),
    query: Type.String({ minLength: 1, maxLength: 500 }),
    repository: Type.String({ minLength: 1, maxLength: 200 }),
    expectedCommit: Type.String({ minLength: 40, maxLength: 40 }),
    topK: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  }),
  submit_site_strategy: Type.Object({
    audience: Type.String({ minLength: 1, maxLength: 300 }),
    businessGoal: Type.String({ minLength: 1, maxLength: 500 }),
    primaryConversion: Type.String({ minLength: 1, maxLength: 200 }),
    pageHierarchy: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { minItems: 1, maxItems: 12 }),
    blocks: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { minItems: 1, maxItems: 20 }),
    locales: Type.Array(Type.String({ minLength: 2, maxLength: 16 }), { minItems: 1, maxItems: 8 }),
    designDirection: Type.String({ minLength: 1, maxLength: 600 }),
    designTokens: Type.Optional(Type.Object({
      color: Type.Optional(Type.Object({
        primary: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
        surface: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
        text: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
      })),
      spacing: Type.Optional(Type.Object({
        unit: Type.Optional(Type.Number({ minimum: 1, maximum: 32 })),
        section: Type.Optional(Type.Number({ minimum: 1, maximum: 240 })),
      })),
      typography: Type.Optional(Type.Object({
        body: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
        heading: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
      })),
    })),
    openQuestions: Type.Array(Type.Object({
      field: Type.String({ minLength: 1, maxLength: 64 }),
      question: Type.String({ minLength: 1, maxLength: 240 }),
      reason: Type.Optional(Type.String({ maxLength: 300 })),
    }), { maxItems: 3 }),
    evidenceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 30 }),
    qaChecks: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { minItems: 1, maxItems: 12 }),
    tradeoffs: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 8 }),
  }),
  submit_component_plan: Type.Object({
    summary: Type.String({ minLength: 1, maxLength: 1000 }),
    decisions: Type.Array(Type.Object({
      component: Type.String({ minLength: 1, maxLength: 64 }),
      recommendation: Type.String({ minLength: 1, maxLength: 32 }),
      evidenceIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 10 }),
      reason: Type.String({ minLength: 1, maxLength: 500 }),
    }), { maxItems: 20 }),
  }),
  delegate_architect: Type.Object(decisionFields()),
  delegate_research: Type.Object({
    ...decisionFields(),
    repository: Type.String({ minLength: 1, maxLength: 200 }),
    expectedCommit: Type.String({ minLength: 40, maxLength: 40 }),
  }),
  delegate_content_cms: Type.Object(decisionFields()),
  delegate_coding: Type.Object(decisionFields()),
  request_customer_input: Type.Object({
    ...decisionFields(),
    questions: Type.Array(Type.Object({
      field: Type.String({ minLength: 1, maxLength: 64 }),
      question: Type.String({ minLength: 1, maxLength: 240 }),
      reason: Type.Optional(Type.String({ maxLength: 300 })),
    }), { minItems: 1, maxItems: 3 }),
  }),
  submit_content_model: Type.Object({
    ...decisionFields(),
    status: Type.Union([Type.Literal("proposed"), Type.Literal("needs_input")]),
    contentByPage: Type.Optional(Type.Unknown()),
    questions: Type.Optional(Type.Array(Type.Object({
      field: Type.String({ minLength: 1, maxLength: 64 }),
      question: Type.String({ minLength: 1, maxLength: 240 }),
      reason: Type.Optional(Type.String({ maxLength: 300 })),
    }), { maxItems: 3 })),
  }),
  submit_code_patch_plan: Type.Object({
    ...decisionFields(),
    status: Type.Union([Type.Literal("proposed"), Type.Literal("needs_input")]),
    candidateId: Type.String({ minLength: 1, maxLength: 200 }),
    candidateHash: Type.String({ minLength: 64, maxLength: 64 }),
    designDraftId: Type.String({ minLength: 1, maxLength: 200 }),
    designHash: Type.String({ minLength: 64, maxLength: 64 }),
    pagePlanHash: Type.String({ minLength: 1, maxLength: 200 }),
    contentHash: Type.String({ minLength: 64, maxLength: 64 }),
    expectedHead: Type.String({ minLength: 1, maxLength: 200 }),
    files: Type.Optional(Type.Array(Type.Object({
      path: Type.String({ minLength: 1, maxLength: 240 }),
      operation: Type.Union([Type.Literal("modify"), Type.Literal("create"), Type.Literal("delete")]),
      summary: Type.String({ minLength: 1, maxLength: 500 }),
      sourceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 10 }),
    }), { minItems: 1, maxItems: 20 })),
    expectedTests: Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { minItems: 1, maxItems: 12 }),
    risks: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 8 }),
    questions: Type.Optional(Type.Array(Type.Object({
      field: Type.String({ minLength: 1, maxLength: 64 }),
      question: Type.String({ minLength: 1, maxLength: 240 }),
      reason: Type.Optional(Type.String({ maxLength: 300 })),
    }), { maxItems: 3 })),
  }),
  complete_plan: Type.Object({
    ...decisionFields(),
    summary: Type.String({ minLength: 1, maxLength: 1000 }),
  }),
  inspect_payload_schema: Type.Object({
    collection: Type.String({ minLength: 1, maxLength: 64 }),
  }),
  create_payload_draft: Type.Object({
    operations: Type.Array(Type.Unknown(), { maxItems: 30 }),
    idempotencyKey: Type.String({ minLength: 8, maxLength: 200 }),
  }),
  inspect_source_package: Type.Object({
    sourceId: Type.String({ minLength: 1, maxLength: 200 }),
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { minItems: 1, maxItems: 5 })),
  }),
  apply_code_patch: Type.Object({
    files: Type.Array(Type.Unknown(), { maxItems: 20 }),
  }),
  run_build_and_tests: Type.Object({}),
  run_quality_checks: Type.Object({
    candidateId: Type.String({ minLength: 1, maxLength: 200 }),
    candidateHash: Type.String({ minLength: 1, maxLength: 200 }),
  }),
};

export function createPiTool({ role, name, runContext, toolRuntime, handler } = {}) {
  assertRoleTool(role, name);
  assertTool(name, runContext?.grant?.level || "L0", runContext?.grant || {});
  if (!runContext?.runId || !runContext?.agentRunId || !runContext?.inputSnapshotId) {
    throw new PolicyError("Agent tool context is incomplete", "INVALID_INPUT");
  }
  if (typeof handler !== "function" && !toolRuntime) throw new PolicyError("Agent tool handler is required", "CONFIG_REQUIRED");
  const schema = schemas[name];
  if (!schema) throw new PolicyError(`No schema registered for ${name}`, "CONFIG_REQUIRED");
  return {
    name,
    label: `SitePilot ${name}`,
    description: descriptions[name],
    parameters: schema,
    replay: SAFE_TOOL_NAMES.has(name) ? "safe" : "never",
    executionMode: "sequential",
    async execute(toolCallId, params) {
      if (handler && toolRuntime) toolRuntime.handlers.set(name, handler);
      const execute = toolRuntime ? ((input) => toolRuntime.execute({
        tool: name,
        runId: runContext.runId,
        agentRunId: runContext.agentRunId,
        inputSnapshotId: runContext.inputSnapshotId,
        idempotencyKey: `${runContext.agentRunId}:${name}:${toolCallId}`,
        requestedScope: runContext.requestedScope || {},
        input,
        replay: SAFE_TOOL_NAMES.has(name) ? "safe" : "unsafe",
      })) : handler;
      try {
        const result = await execute(params);
        return { ...textResult(result?.output ?? result), ...(result?.terminate === true || result?.output?.terminate === true ? { terminate: true } : {}) };
      } catch (error) {
        return textResult({ code: error.code || "TOOL_FAILED", message: error.message || "Tool failed" }, true);
      }
    },
  };
}

export function createRoleTools({ role, tools = {}, runContext, toolRuntime } = {}) {
  return Object.entries(tools).map(([name, handler]) => createPiTool({ role, name, runContext, toolRuntime, handler }));
}
