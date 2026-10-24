import { createPiTool } from "./agent-tools.js";
import { createArtifact } from "./agent-roles.js";
import { PolicyError, SitePilotStore, normalizeDesignTokens, planStrategy } from "./core.js";
import { planComponents } from "./component-planner.js";
import { ToolRuntime } from "./tool-runtime.js";

function roleRunId(runId, role, count) {
  return `${runId}:${role.toLowerCase()}:${count}`;
}

function promptForArchitect(run) {
  return JSON.stringify({
    task: "Create a website strategy for this customer request.",
    output: "Call submit_site_strategy with audience, businessGoal, primaryConversion, pageHierarchy, blocks, locales, designDirection, optional bounded designTokens, openQuestions, evidenceRefs, qaChecks, and tradeoffs. Do not use plain text instead of the tool.",
    requirement: run.inputSnapshot,
  });
}

function promptForResearch(run, strategy, repository, expectedCommit) {
  return JSON.stringify({
    task: "Research reusable components and return a ComponentPlan.",
    output: "Use retrieve_codeatlas for important blocks, including whyNow, expectedObservation, stopIf, and risk; then call submit_component_plan with evidence IDs returned by the tool. Do not invent paths, licenses, or compatibility facts.",
    strategy,
    source: { repository, expectedCommit },
  });
}

function promptForContentCMS(run, strategy, research, context = {}) {
  return JSON.stringify({
    task: "Create a proposed ContentModel for the frozen website design.",
    output: "Inspect the Payload schema, then call submit_content_model. Use only supplied customer facts and project Claim references backed by active client evidence. Never invent product parameters, credentials, testimonials, SEO facts, or legal claims. Missing or unsupported facts must be returned with status needs_input and customer questions. Generated copy is always proposed, never approved.",
    requirement: run.inputSnapshot,
    strategy,
    componentPlan: research?.componentPlan || research,
    candidate: context.candidate ? { id: context.candidate.id, candidateHash: context.candidate.candidateHash, designDraftId: context.candidate.designDraftId } : null,
    designDraft: context.designDraft ? { id: context.designDraft.id, designHash: context.designDraft.designHash, pageTree: context.designDraft.pageTree } : null,
    customerFacts: context.customerFacts || [],
    approvedClaimRefs: context.allowedClaimRefs || [],
  });
}

function validateContentModel(contentByPage, { strategy, designDraft, pagePlan, allowedClaimRefs = [] } = {}) {
  if (!contentByPage || typeof contentByPage !== "object" || Array.isArray(contentByPage)) {
    throw new PolicyError("ContentModel must contain a page map", "SCHEMA_REJECTED");
  }
  const pages = Array.isArray(strategy?.pageHierarchy) ? strategy.pageHierarchy : [];
  if (pages.length < 1 || pages.length > 12) throw new PolicyError("ContentModel has no bounded SiteStrategy page hierarchy", "SCHEMA_REJECTED");
  const allowedPages = new Set(pages);
  const suppliedPages = Object.keys(contentByPage);
  const missing = pages.filter((page) => !contentByPage[page]);
  const unknown = suppliedPages.filter((page) => !allowedPages.has(page));
  if (unknown.length) throw new PolicyError(`ContentModel contains pages outside SiteStrategy: ${unknown.join(", ")}`, "SCHEMA_REJECTED");
  if (missing.length) throw new PolicyError(`ContentModel is missing approved content for: ${missing.join(", ")}`, "NEEDS_INPUT");
  const claimAllowlist = new Set(allowedClaimRefs);
  const designPages = designDraft?.pageTree?.map((page) => page.page) || [];
  if (!designDraft?.id || !/^[a-f0-9]{64}$/i.test(designDraft.designHash || "") || pages.length !== designPages.length || pages.some((page) => !designPages.includes(page))) {
    throw new PolicyError("ContentModel must bind to the current DesignDraft pages", "STALE_REVISION");
  }
  const plannedPages = pagePlan?.routes?.map((page) => page.page) || [];
  if (pages.length !== plannedPages.length || pages.some((page) => !plannedPages.includes(page))) {
    throw new PolicyError("ContentModel must bind to the current PagePlan", "STALE_REVISION");
  }
  const normalized = {};
  for (const page of pages) {
    const value = contentByPage[page];
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new PolicyError(`ContentModel page is invalid: ${page}`, "SCHEMA_REJECTED");
    const fields = ["title", "heroTitle", "description", "cta", "metaTitle", "metaDescription"];
    const allowedFields = new Set([...fields, "claimRefs"]);
    if (Object.keys(value).some((field) => !allowedFields.has(field))) throw new PolicyError(`ContentModel contains an unsupported field: ${page}`, "SCHEMA_REJECTED");
    const output = {};
    for (const field of fields) {
      if (value[field] !== undefined && (typeof value[field] !== "string" || value[field].length > 2000 || /<\/?[a-z][^>]*>|javascript:/i.test(value[field]))) {
        throw new PolicyError(`ContentModel field is invalid: ${page}.${field}`, "SCHEMA_REJECTED");
      }
      if (value[field] !== undefined) output[field] = value[field].trim();
    }
    if (!output.title || !output.heroTitle) throw new PolicyError(`ContentModel requires title and heroTitle: ${page}`, "NEEDS_INPUT");
    if (!Array.isArray(value.claimRefs) || value.claimRefs.length === 0) throw new PolicyError(`ContentModel requires Claim references: ${page}`, "NEEDS_INPUT");
    if (value.claimRefs.length > 10) throw new PolicyError(`ContentModel contains too many Claim references: ${page}`, "SCHEMA_REJECTED");
    const refs = [...new Set(value.claimRefs)];
    if (refs.some((ref) => typeof ref !== "string" || ref.length < 1 || ref.length > 200)) throw new PolicyError(`ContentModel Claim references are invalid: ${page}`, "SCHEMA_REJECTED");
    if (refs.some((ref) => !claimAllowlist.has(ref))) throw new PolicyError(`ContentModel references an unapproved Claim: ${page}`, "POLICY_DENIED");
    output.claimRefs = refs;
    normalized[page] = output;
  }
  return normalized;
}

function delegationTool({ name, role, runContext, toolRuntime, handler }) {
  return createPiTool({ role, name, runContext, toolRuntime, handler });
}

export async function runCreationSupervisor({ run, runtime, store, registry, codeAtlas, toolRuntime, repository, expectedCommit, grant = { level: "L0" }, maxDelegations = 4, contentCms = null } = {}) {
  if (!run?.id || !runtime || !store) throw new PolicyError("Supervisor requires a run, runtime and store", "CONFIG_REQUIRED");
  if (!(store instanceof SitePilotStore) && typeof store.recordArtifact !== "function") throw new PolicyError("Supervisor store does not support artifacts", "CONFIG_REQUIRED");
  toolRuntime = toolRuntime || createAgentToolRuntime(store);
  const canResearch = Boolean(codeAtlas && typeof codeAtlas.search === "function" && repository && /^[a-f0-9]{40}$/i.test(expectedCommit || ""));
  const contentOnly = contentCms?.contentOnly === true;
  if (contentOnly && (!run.strategy || !run.research)) throw new PolicyError("ContentCMS requires the completed strategy and research stage", "PRECONDITION_REQUIRED");
  const state = { strategy: contentOnly ? run.strategy : null, research: contentOnly ? run.research : null, content: null, questions: null, decision: null, decisions: contentOnly ? [...(run.agentState?.decisions || [])] : [], delegations: 0, evidence: [] };
  const inputSnapshotId = run.inputSnapshotId || `snapshot:${run.id}`;
  const baseContext = { runId: run.id, inputSnapshotId, grant, requestedScope: { repository: repository || null, expectedCommit: expectedCommit || null } };
  const priorSupervisorRuns = contentOnly ? (store.audit || []).filter((event) => event.runId === run.id && event.type === "agent.started" && event.data?.role === "Supervisor").length : 0;
  const supervisorAgentRunId = roleRunId(run.id, "Supervisor", priorSupervisorRuns + 1);
  const recordDecision = (action, input, outputRefs = []) => {
    if (typeof input.whyNow !== "string" || input.whyNow.length < 8 || typeof input.expectedObservation !== "string" || input.expectedObservation.length < 8 || !["low", "medium", "high"].includes(input.risk) || !Array.isArray(input.stopIf)) {
      throw new PolicyError("Supervisor action requires a structured decision record", "SCHEMA_REJECTED");
    }
    const decision = { role: "Supervisor", action, whyNow: input.whyNow, expectedObservation: input.expectedObservation, stopIf: input.stopIf, risk: input.risk, outputRefs, createdAt: new Date().toISOString() };
    state.decisions.push(decision);
    store.event(run.id, "agent.decision", decision);
    return decision;
  };

  const delegateArchitect = delegationTool({
    name: "delegate_architect",
    role: "Supervisor",
    runContext: { ...baseContext, agentRunId: supervisorAgentRunId },
    toolRuntime,
    handler: async (input) => {
      if (++state.delegations > maxDelegations) throw new PolicyError("Supervisor delegation budget exhausted", "BUDGET_EXHAUSTED");
      let submittedStrategy = null;
      const result = await runtime.runRole({
        role: "Architect",
        runId: run.id,
        agentRunId: roleRunId(run.id, "Architect", state.delegations),
        inputSnapshotId,
        prompt: promptForArchitect(run),
        grant: { level: "L0" },
        artifactType: "SiteStrategy",
        tools: [createPiTool({
          role: "Architect",
          name: "submit_site_strategy",
          runContext: { ...baseContext, agentRunId: roleRunId(run.id, "Architect", state.delegations) },
          toolRuntime,
          handler: (params) => {
            submittedStrategy = params;
            return { accepted: true, strategy: params, terminate: true };
          },
        })],
      });
      state.strategy = result.artifact?.output || submittedStrategy || result.output;
      if (!state.strategy) throw new PolicyError("Architect did not submit a SiteStrategy artifact", "AGENT_OUTPUT_MISSING");
      const allowedPages = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
      const locales = new Set(["zh-CN", "en", "en-US", "ja", "de", "fr"]);
      if (state.strategy.pageHierarchy.some((page) => !allowedPages.test(page)) || state.strategy.locales.some((locale) => !locales.has(locale))) {
        throw new PolicyError("Architect strategy contains an unsupported page or locale", "SCHEMA_REJECTED");
      }
      if (new Set(state.strategy.pageHierarchy).size !== state.strategy.pageHierarchy.length || new Set(state.strategy.blocks).size !== state.strategy.blocks.length) {
        throw new PolicyError("Architect strategy contains duplicate page or block identifiers", "SCHEMA_REJECTED");
      }
      const questionFields = new Set(["audience", "primaryConversion", "brandConstraints", "contentAvailable", "locale"]);
      if (state.strategy.openQuestions.some((question) => !questionFields.has(question.field))) throw new PolicyError("Architect asked for an unsupported customer field", "SCHEMA_REJECTED");
      const baseline = run.strategy || planStrategy(store.projects.get(run.projectId));
      run.strategy = {
        ...baseline,
        strategy: `${store.projects.get(run.projectId)?.industry || "general"}-agentic`,
        audience: state.strategy.audience,
        businessGoal: state.strategy.businessGoal,
        primaryConversion: state.strategy.primaryConversion,
        pageHierarchy: state.strategy.pageHierarchy,
        blocks: state.strategy.blocks,
        locales: state.strategy.locales,
        designDirection: state.strategy.designDirection,
        ...(state.strategy.designTokens ? { designTokens: normalizeDesignTokens(state.strategy.designTokens) } : {}),
        openQuestions: state.strategy.openQuestions,
        evidenceRefs: state.strategy.evidenceRefs,
        qa: state.strategy.qaChecks,
        tradeoffs: state.strategy.tradeoffs,
      };
      if (!result.artifact) store.recordArtifact(run.id, createArtifact({ type: "SiteStrategy", role: "Architect", runId: run.id, inputRefs: [inputSnapshotId], output: run.strategy }));
      recordDecision("delegate_architect", input, run.artifactIds || []);
      store.event(run.id, "agent.delegation.completed", { role: "Architect", status: "succeeded" });
      return { status: "strategy_ready", strategy: state.strategy };
    },
  });

  const delegateResearch = canResearch ? delegationTool({
    name: "delegate_research",
    role: "Supervisor",
    runContext: { ...baseContext, agentRunId: supervisorAgentRunId },
    toolRuntime,
    handler: async (input) => {
      if (++state.delegations > maxDelegations) throw new PolicyError("Supervisor delegation budget exhausted", "BUDGET_EXHAUSTED");
      const sourceRepository = input.repository;
      const sourceCommit = input.expectedCommit;
      recordDecision("delegate_research", input, run.artifactIds || []);
      if (sourceRepository !== repository || sourceCommit?.toLowerCase() !== expectedCommit?.toLowerCase()) throw new PolicyError("Research scope differs from the server-frozen repository and commit", "POLICY_DENIED");
      if (!state.strategy) throw new PolicyError("Architect strategy is required before Research", "PRECONDITION_REQUIRED");
      const researchContext = { ...baseContext, agentRunId: roleRunId(run.id, "Research", state.delegations), requestedScope: { repository: sourceRepository, expectedCommit: sourceCommit } };
      const searchTool = createPiTool({
        role: "Research",
        name: "retrieve_codeatlas",
        runContext: researchContext,
        toolRuntime,
        handler: async (params) => {
          const results = await codeAtlas.search({ query: params.query, topK: params.topK || 5, repository: sourceRepository, expectedCommit: sourceCommit });
          state.evidence.push(...results);
          return results;
        },
      });
      let submittedPlan = null;
      const submitTool = createPiTool({
        role: "Research",
        name: "submit_component_plan",
        runContext: researchContext,
        toolRuntime,
        handler: (params) => {
          const blockNames = state.strategy.blocks;
          if (params.decisions.some((decision) => !blockNames.includes(decision.component))) throw new PolicyError("ComponentPlan references a component outside SiteStrategy", "SCHEMA_REJECTED");
          const knownEvidence = new Set(state.evidence.map((item) => item.evidenceId));
          if (params.decisions.some((decision) => decision.evidenceIds.some((id) => !knownEvidence.has(id)))) throw new PolicyError("ComponentPlan references evidence not returned by CodeAtlas", "INVALID_EVIDENCE");
          if (params.decisions.some((decision) => !["reuse", "adapt", "fallback", "missing"].includes(decision.recommendation))) throw new PolicyError("ComponentPlan contains an unsupported recommendation", "SCHEMA_REJECTED");
          submittedPlan = params;
          return { accepted: true, componentPlan: params, terminate: true };
        },
      });
      const result = await runtime.runRole({
        role: "Research",
        runId: run.id,
        agentRunId: researchContext.agentRunId,
        inputSnapshotId,
        prompt: promptForResearch(run, state.strategy, sourceRepository, sourceCommit),
        grant: { level: "L0" },
        artifactType: "ComponentPlan",
        tools: [searchTool, submitTool],
      });
      if (!submittedPlan && !result.artifact) throw new PolicyError("Research did not submit a ComponentPlan artifact", "AGENT_OUTPUT_MISSING");
      const componentPlan = planComponents({ strategy: state.strategy, evidence: state.evidence, registry, projectId: run.projectId });
      state.research = {
        ...(submittedPlan || result.artifact?.output || {}),
        repository: sourceRepository,
        commit: sourceCommit.toLowerCase(),
        evidence: state.evidence,
        componentPlan,
      };
      run.research = state.research;
      if (!result.artifact) store.recordArtifact(run.id, createArtifact({ type: "ComponentPlan", role: "Research", runId: run.id, inputRefs: [inputSnapshotId, "SiteStrategy"], output: state.research }));
      store.event(run.id, "agent.delegation.completed", { role: "Research", status: "succeeded", evidenceCount: state.evidence.length });
      return { status: "research_ready", research: state.research, repository: sourceRepository, expectedCommit: sourceCommit };
    },
  }) : null;

  const requestInput = delegationTool({
    name: "request_customer_input",
    role: "Supervisor",
    runContext: { ...baseContext, agentRunId: supervisorAgentRunId },
    toolRuntime,
    handler: async (input) => {
      const allowedFields = new Set(["audience", "primaryConversion", "brandConstraints", "contentAvailable", "locale", "codeAtlasSource", "productFacts", "brandName", "productProof", "seoDetails"]);
      if (input.questions.some((question) => !allowedFields.has(question.field))) throw new PolicyError("Supervisor requested an unsupported customer field", "SCHEMA_REJECTED");
      state.questions = input.questions;
      recordDecision("request_customer_input", input, run.artifactIds || []);
      return { status: "needs_input", questions: state.questions, terminate: true };
    },
  });

  const delegateContentCMS = contentCms ? delegationTool({
    name: "delegate_content_cms",
    role: "Supervisor",
    runContext: { ...baseContext, agentRunId: supervisorAgentRunId },
    toolRuntime,
    handler: async (input) => {
      if (++state.delegations > maxDelegations) throw new PolicyError("Supervisor delegation budget exhausted", "BUDGET_EXHAUSTED");
      if (!state.strategy || !state.research) throw new PolicyError("Architect and Research are required before ContentCMS", "PRECONDITION_REQUIRED");
      if (!contentCms.designDraft || !contentCms.pagePlan || contentCms.candidateId !== contentCms.candidate?.id || contentCms.candidateHash !== contentCms.candidate?.candidateHash) throw new PolicyError("ContentCMS requires the current candidate, DesignDraft and PagePlan", "PRECONDITION_REQUIRED");
      recordDecision("delegate_content_cms", input, run.artifactIds || []);
      const priorContentRuns = (store.audit || []).filter((event) => event.runId === run.id && event.type === "agent.started" && event.data?.role === "ContentCMS").length;
      const childRunId = roleRunId(run.id, "ContentCMS", priorContentRuns + 1);
      let submitted = null;
      const childContext = { ...baseContext, agentRunId: childRunId };
      const inspectSchema = createPiTool({
        role: "ContentCMS",
        name: "inspect_payload_schema",
        runContext: { ...childContext, grant: { level: "L0" } },
        toolRuntime,
        handler: ({ collection }) => {
          if (collection !== "pages") throw new PolicyError("ContentCMS may inspect only the approved pages collection", "POLICY_DENIED");
          return { collection, schema: contentCms.payloadSchema || { collection: "pages", status: "sandbox_only", required: ["title", "hero", "claimRefs"] } };
        },
      });
      const submitModel = createPiTool({
        role: "ContentCMS",
        name: "submit_content_model",
        runContext: { ...childContext, grant: { level: "L0" } },
        toolRuntime,
        handler: (params) => {
          const { contentByPage, status, questions } = params || {};
          if (status === "needs_input") {
            if (!Array.isArray(questions) || questions.length < 1 || questions.length > 3) throw new PolicyError("ContentCMS needs_input requires one to three customer questions", "SCHEMA_REJECTED");
            const allowedFields = new Set(["audience", "primaryConversion", "brandConstraints", "contentAvailable", "locale", "codeAtlasSource", "productFacts", "brandName", "productProof", "seoDetails"]);
            if (questions.some((item) => !item || !allowedFields.has(item.field) || typeof item.question !== "string" || item.question.length > 240)) throw new PolicyError("ContentCMS returned an unsupported customer question", "SCHEMA_REJECTED");
            submitted = { status: "needs_input", questions, candidateId: contentCms.candidateId, candidateHash: contentCms.candidateHash, designDraftId: contentCms.designDraft.id, designHash: contentCms.designDraft.designHash, pagePlanHash: contentCms.pagePlan.sourceManifestHash || null };
            return { accepted: true, contentModel: submitted, terminate: true };
          }
          const normalized = validateContentModel(contentByPage, { strategy: state.strategy, designDraft: contentCms.designDraft, pagePlan: contentCms.pagePlan, allowedClaimRefs: contentCms.allowedClaimRefs });
          submitted = { contentByPage: normalized, candidateId: contentCms.candidateId, candidateHash: contentCms.candidateHash, designDraftId: contentCms.designDraft.id, designHash: contentCms.designDraft.designHash, pagePlanHash: contentCms.pagePlan.sourceManifestHash || null, status: "proposed" };
          return { accepted: true, contentModel: submitted, terminate: true };
        },
      });
      const result = await runtime.runRole({
        role: "ContentCMS",
        runId: run.id,
        agentRunId: childRunId,
        inputSnapshotId,
        prompt: promptForContentCMS(run, state.strategy, state.research, contentCms),
        grant: { level: "L0" },
        artifactType: "ContentModel",
        persistArtifact: false,
        tools: [inspectSchema, submitModel],
      });
      const model = submitted || result.artifact?.output;
      if (!model) throw new PolicyError("ContentCMS did not submit a ContentModel", "AGENT_OUTPUT_MISSING");
      if (model.status === "needs_input") {
        state.questions = model.questions;
        run.contentModel = model;
        const artifact = createArtifact({ type: "ContentModel", role: "ContentCMS", runId: run.id, inputRefs: [inputSnapshotId, "SiteStrategy", "ComponentPlan", contentCms.candidateId, contentCms.designDraft.id], output: model, status: "needs_input", risk: "medium" });
        store.recordArtifact(run.id, artifact);
        store.event(run.id, "agent.delegation.completed", { role: "ContentCMS", status: "needs_input", designDraftId: contentCms.designDraft.id });
        return { status: "needs_input", questions: state.questions, terminate: true };
      }
      const normalized = validateContentModel(model.contentByPage, { strategy: state.strategy, designDraft: contentCms.designDraft, pagePlan: contentCms.pagePlan, allowedClaimRefs: contentCms.allowedClaimRefs });
      state.content = { ...model, contentByPage: normalized, status: "proposed" };
      run.contentModel = state.content;
      store.recordArtifact(run.id, createArtifact({ type: "ContentModel", role: "ContentCMS", runId: run.id, inputRefs: [inputSnapshotId, "SiteStrategy", "ComponentPlan", contentCms.candidateId, contentCms.designDraft.id], output: state.content, status: "complete", risk: "medium" }));
      store.event(run.id, "agent.delegation.completed", { role: "ContentCMS", status: "succeeded", designDraftId: contentCms.designDraft.id });
      return { status: "content_proposed", contentModel: state.content };
    },
  }) : null;

  const completePlan = delegationTool({
    name: "complete_plan",
    role: "Supervisor",
    runContext: { ...baseContext, agentRunId: supervisorAgentRunId },
    toolRuntime,
    handler: async (input) => {
      if (!state.strategy) throw new PolicyError("Supervisor cannot complete before Architect produces SiteStrategy", "PRECONDITION_REQUIRED");
      if (!state.research) throw new PolicyError("Supervisor cannot complete before Research produces ComponentPlan", "PRECONDITION_REQUIRED");
      if (contentCms && !state.content) throw new PolicyError("Supervisor cannot complete before ContentCMS produces ContentModel", "PRECONDITION_REQUIRED");
      recordDecision("complete_plan", input, run.artifactIds || []);
      state.decision = { status: "complete", summary: input.summary };
      return { ...state.decision, terminate: true };
    },
  });

  const supervisorTools = contentOnly
    ? [...(delegateContentCMS ? [delegateContentCMS] : []), requestInput, completePlan]
    : [delegateArchitect, ...(delegateResearch ? [delegateResearch] : []), ...(delegateContentCMS ? [delegateContentCMS] : []), requestInput, completePlan];
  const result = await runtime.runRole({
    role: "Supervisor",
    runId: run.id,
    agentRunId: supervisorAgentRunId,
    inputSnapshotId,
    grant,
    persistArtifact: false,
    prompt: JSON.stringify({
      task: contentOnly ? "Coordinate the ContentCMS draft stage for the current candidate." : "Coordinate the first SitePilot creation slice.",
      goal: run.inputSnapshot.goal,
      currentArtifacts: [],
      availableDelegations: supervisorTools.map((tool) => tool.name),
      rules: [
        ...(contentOnly ? ["Do not rerun Architect or Research; their frozen artifacts are already available.", "Delegate ContentCMS for this candidate, or request customer input if evidence is insufficient."] : ["Delegate Architect before Research.", "Research can only use the repository and full commit supplied by the server.", "If a strategy exists, delegate research when the tool is available.", "If Research is unavailable, ask for a CodeAtlas repository ID and full commit before completing."]),
        "Ask the customer when a missing fact blocks a reliable strategy or content model.",
        ...(contentCms ? ["ContentCMS may submit only a validated proposed ContentModel; it must stop for missing customer facts or Claim references."] : []),
        "Do not claim completion until required artifacts are present.",
      ],
      defaults: { repository, expectedCommit },
    }),
    tools: supervisorTools,
  });
  const decision = result.output || state.decision || {};
  const questions = state.questions || (!contentOnly && !canResearch ? [{ field: "codeAtlasSource", question: "请选择授权的 CodeAtlas 仓库并提供固定的 40 位 commit SHA。", reason: "Research 必须绑定允许列表中的固定代码版本。" }] : []);
  const status = questions.length ? "needs_input" : state.content ? "content_review_required" : contentOnly ? "content_incomplete" : state.strategy && state.research ? (contentCms ? "ready_for_content" : "ready_for_design") : "needs_input";
  run.agentState = {
    status,
    questions: state.questions || decision.questions || questions,
    decisions: state.decisions,
    artifactIds: (run.artifactIds || []).slice(),
    lastDecision: decision,
  };
  run.checkpoint = status === "needs_input" ? "agent_needs_input" : state.content ? "content_review_required" : contentOnly ? "content_agent_incomplete" : "agent_strategy_research_ready";
  store.event(run.id, "supervisor.completed", { status, artifactCount: run.artifactIds?.length || 0, delegations: state.delegations });
  store.persist?.();
  return { status, decision, strategy: state.strategy, research: state.research, contentModel: state.content, questions: run.agentState.questions, artifacts: store.artifactsForRun(run.id) };
}

export function createAgentToolRuntime(store, journal = null) {
  return new ToolRuntime({ store, handlers: {}, journal });
}
