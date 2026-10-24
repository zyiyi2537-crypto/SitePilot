import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const ROLES = ["Supervisor", "Architect", "Research", "ContentCMS", "Coding", "QA", "Review"];
export const TOOLS = new Map([
  ["delegate_architect", "L0"],
  ["delegate_research", "L0"],
  ["delegate_content_cms", "L0"],
  ["delegate_coding", "L0"],
  ["request_customer_input", "L0"],
  ["complete_plan", "L0"],
  ["submit_site_strategy", "L0"],
  ["submit_component_plan", "L0"],
  ["submit_content_model", "L0"],
  ["submit_code_patch_plan", "L0"],
  ["retrieve_codeatlas", "L0"],
  ["inspect_payload_schema", "L0"],
  ["create_project_worktree", "L2"],
  ["fetch_pinned_source", "L2"],
  ["inspect_source_package", "L0"],
  ["apply_code_patch", "L2"],
  ["run_build_and_tests", "L2"],
  ["create_payload_draft", "L1"],
  ["run_quality_checks", "L0"],
  ["package_review", "L1"]
]);

const id = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => structuredClone(value);
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
const SAFE_PROP = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const FORBIDDEN_PROP = /^(?:__proto__|prototype|constructor|dangerouslySetInnerHTML|html|script|javascript)$/i;
const DEFAULT_DESIGN_TOKENS = Object.freeze({
  color: Object.freeze({ primary: "#155eef", surface: "#ffffff", text: "#18212b" }),
  spacing: Object.freeze({ unit: 4, section: 64 }),
  typography: Object.freeze({ body: "system-ui", heading: "system-ui" }),
});

function assertBoundedJson(value, depth = 0) {
  if (depth > 5) throw new PolicyError("Design value is too deeply nested", "SCHEMA_REJECTED");
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "string" && (/<\/?[a-z][^>]*>/i.test(value) || /^javascript:/i.test(value))) {
      throw new PolicyError("Design values cannot contain executable markup", "SCHEMA_REJECTED");
    }
    if (typeof value === "string" && value.length > 2000) throw new PolicyError("Design text is too long", "SCHEMA_REJECTED");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw new PolicyError("Design array is too large", "SCHEMA_REJECTED");
    for (const item of value) assertBoundedJson(item, depth + 1);
    return;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length > 100) throw new PolicyError("Design object is too large", "SCHEMA_REJECTED");
    for (const key of keys) {
      if (!SAFE_PROP.test(key) || FORBIDDEN_PROP.test(key)) throw new PolicyError(`Invalid design property: ${key}`, "SCHEMA_REJECTED");
      assertBoundedJson(value[key], depth + 1);
    }
    return;
  }
  throw new PolicyError("Design value must be JSON data", "SCHEMA_REJECTED");
}

export function normalizeDesignTokens(value) {
  if (value === undefined || value === null) return clone(DEFAULT_DESIGN_TOKENS);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PolicyError("Design tokens must be an object", "SCHEMA_REJECTED");
  const groups = {
    color: new Set(["primary", "surface", "text"]),
    spacing: new Set(["unit", "section"]),
    typography: new Set(["body", "heading"]),
  };
  for (const [group, entries] of Object.entries(value)) {
    if (!groups[group] || !entries || typeof entries !== "object" || Array.isArray(entries)) throw new PolicyError("Unknown or invalid design token group", "SCHEMA_REJECTED");
    for (const [key, token] of Object.entries(entries)) {
      if (!groups[group].has(key)) throw new PolicyError(`Unsupported design token: ${group}.${key}`, "SCHEMA_REJECTED");
      if (group === "color" && (typeof token !== "string" || !/^#[0-9a-f]{6}$/i.test(token))) throw new PolicyError(`Invalid color token: ${key}`, "SCHEMA_REJECTED");
      if (group === "spacing" && (typeof token !== "number" || !Number.isFinite(token) || token < (key === "unit" ? 1 : 16) || token > (key === "unit" ? 32 : 240))) throw new PolicyError(`Invalid spacing token: ${key}`, "SCHEMA_REJECTED");
      if (group === "typography" && (typeof token !== "string" || !/^[A-Za-z0-9 ,"'_-]{1,120}$/.test(token))) throw new PolicyError(`Invalid typography token: ${key}`, "SCHEMA_REJECTED");
    }
  }
  const merged = {
    color: { ...DEFAULT_DESIGN_TOKENS.color, ...(value.color || {}) },
    spacing: { ...DEFAULT_DESIGN_TOKENS.spacing, ...(value.spacing || {}) },
    typography: { ...DEFAULT_DESIGN_TOKENS.typography, ...(value.typography || {}) },
  };
  assertBoundedJson(merged);
  return deepFreeze(merged);
}

function normalizePageTree(pageTree = []) {
  if (!Array.isArray(pageTree) || !pageTree.length || pageTree.length > 25) throw new PolicyError("Design draft requires between one and twenty-five pages", "INVALID_INPUT");
  const pages = pageTree.map((page) => {
    if (!page || typeof page !== "object" || typeof page.page !== "string" || page.page.length > 64 || typeof page.route !== "string" || page.route.length > 256 || !page.route.startsWith("/")) throw new PolicyError("Invalid design route", "SCHEMA_REJECTED");
    if (!Array.isArray(page.components) || !page.components.length || page.components.length > 40) throw new PolicyError(`Design route has an invalid component count: ${page.page}`, "SCHEMA_REJECTED");
    const components = page.components.map((component, index) => {
      if (!component || typeof component.registryId !== "string" || typeof component.name !== "string") throw new PolicyError("Design component must reference a registry block", "SCHEMA_REJECTED");
      const props = component.props && typeof component.props === "object" && !Array.isArray(component.props) ? clone(component.props) : {};
      assertBoundedJson(props);
      return {
        instanceId: component.instanceId || `${page.page}:${component.registryId}:${index}`,
        registryId: component.registryId,
        name: component.name,
        source: component.source ? clone(component.source) : null,
        propsSchema: component.propsSchema ? clone(component.propsSchema) : {},
        props,
      };
    });
    return { page: page.page, route: page.route, components };
  });
  if (new Set(pages.map((page) => page.page)).size !== pages.length) throw new PolicyError("Design draft contains duplicate pages", "SCHEMA_REJECTED");
  return pages;
}

function designHash({ pageTree, designTokens, blockRegistryVersion, openQuestions, inputSnapshotHash }) {
  return hash({ pageTree, designTokens, blockRegistryVersion, openQuestions, inputSnapshotHash });
}

export class PolicyError extends Error {
  constructor(message, code = "POLICY_DENIED") {
    super(message);
    this.code = code;
  }
}

export class SitePilotStore {
  constructor() {
    this.projects = new Map();
    this.runs = new Map();
    this.tasks = new Map();
    this.designs = new Map();
    this.canvasPatches = new Map();
    this.candidates = new Map();
    this.drafts = new Map();
    this.artifacts = new Map();
    this.audit = [];
  }

  createProject(input) {
    if (!input?.goal?.trim()) throw new PolicyError("Project goal is required", "INVALID_INPUT");
    const locale = Array.isArray(input.locale) && input.locale.length ? input.locale : ["zh-CN", "en"];
    const project = {
      id: id("project"),
      workspaceId: input.workspaceId || "local-workspace",
      goal: input.goal.trim(),
      industry: input.industry || "general",
      locale,
      audience: typeof input.audience === "string" ? input.audience.trim() : "",
      primaryConversion: typeof input.primaryConversion === "string" ? input.primaryConversion.trim() : "",
      brandConstraints: Array.isArray(input.brandConstraints) ? input.brandConstraints : [],
      contentAvailable: Array.isArray(input.contentAvailable) ? input.contentAvailable : [],
      initialRequest: typeof input.initialRequest === "string" ? input.initialRequest.trim() : "",
      requirementBrief: input.requirementBrief ? clone(input.requirementBrief) : null,
      localeProvided: input.localeProvided === true,
      constraints: input.constraints || [],
      status: "draft",
      createdAt: new Date().toISOString()
    };
    this.projects.set(project.id, project);
    return project;
  }

  createRun(projectId, inputSnapshot = {}) {
    const project = this.projects.get(projectId);
    if (!project) throw new PolicyError("Project not found", "RESOURCE_NOT_FOUND");
    const snapshot = Object.freeze({
      goal: project.goal,
      industry: project.industry,
      locale: inputSnapshot.locale || project.locale,
      audience: inputSnapshot.audience ?? project.audience,
      primaryConversion: inputSnapshot.primaryConversion ?? project.primaryConversion,
      brandConstraints: inputSnapshot.brandConstraints ?? project.brandConstraints,
      contentAvailable: inputSnapshot.contentAvailable ?? project.contentAvailable,
      initialRequest: project.initialRequest || project.goal,
      requirementBrief: project.requirementBrief || null,
      localeProvided: inputSnapshot.localeProvided ?? project.localeProvided,
      constraints: project.constraints,
      templateBaseCommit: inputSnapshot.templateBaseCommit || "payload-website-template:31ba7ee8271998ad7aa8963111764cbacf37b157",
      blockRegistryVersion: inputSnapshot.blockRegistryVersion || "registry-v0",
      repositoryAllowlist: inputSnapshot.repositoryAllowlist || [],
      modelVersion: inputSnapshot.modelVersion || "mock-planner-v0",
      createdAt: new Date().toISOString()
    });
    const run = {
      id: id("run"), projectId, status: "running", checkpoint: "created",
      inputSnapshot: snapshot, strategy: null, tasks: [], artifactIds: [], candidateIds: [],
      events: []
    };
    this.runs.set(run.id, run);
    this.event(run.id, "run.created", { snapshotHash: hash(snapshot) });
    return run;
  }

  reviseRun(runId, answers = {}) {
    const previous = this.runs.get(runId);
    if (!previous) throw new PolicyError("Run not found", "RESOURCE_NOT_FOUND");
    if (previous.candidateIds.length) throw new PolicyError("A run with candidates cannot be revised", "POLICY_DENIED");
    const allowed = ["audience", "primaryConversion", "brandConstraints", "contentAvailable", "locale"];
    const inputSnapshot = Object.fromEntries(
      allowed.map((key) => [key, answers[key] ?? previous.inputSnapshot[key]]),
    );
    const next = this.createRun(previous.projectId, {
      ...inputSnapshot,
      localeProvided: inputSnapshot.locale ? true : previous.inputSnapshot.localeProvided,
      templateBaseCommit: previous.inputSnapshot.templateBaseCommit,
      blockRegistryVersion: previous.inputSnapshot.blockRegistryVersion,
      repositoryAllowlist: previous.inputSnapshot.repositoryAllowlist,
      modelVersion: previous.inputSnapshot.modelVersion,
    });
    next.revisedFromRunId = previous.id;
    previous.status = "superseded";
    previous.supersededByRunId = next.id;
    this.event(next.id, "run.revised", { revisedFromRunId: previous.id });
    return next;
  }

  createDesignDraft(runId, input = {}) {
    const run = this.runs.get(runId);
    if (!run) throw new PolicyError("Run not found", "RESOURCE_NOT_FOUND");
    if (run.status === "superseded") throw new PolicyError("Cannot design a superseded run", "POLICY_DENIED");
    const pageTree = normalizePageTree(input.pageTree || run.pagePlan?.routes);
    if (run.pagePlan) {
      const expected = new Map(run.pagePlan.routes.map((route) => [route.page, route]));
      if (pageTree.length !== expected.size) throw new PolicyError("Design draft must include every planned route", "SCHEMA_REJECTED");
      for (const page of pageTree) {
        const sourcePage = expected.get(page.page);
        if (!sourcePage || sourcePage.route !== page.route) throw new PolicyError("Design draft route is outside the page plan", "SCHEMA_REJECTED");
        const allowed = new Map(sourcePage.components.map((component) => [component.registryId, component]));
        if (page.components.length !== allowed.size) throw new PolicyError("Design draft must retain every planned component", "SCHEMA_REJECTED");
        for (const component of page.components) {
          const source = allowed.get(component.registryId);
          if (!source || source.name !== component.name || component.source && JSON.stringify(component.source) !== JSON.stringify(source.source)) {
            throw new PolicyError("Design draft component is outside the approved page plan", "SCHEMA_REJECTED");
          }
        }
      }
    }
    if (input.parentId) {
      const parent = this.designs.get(input.parentId);
      if (!parent || parent.runId !== runId) throw new PolicyError("Parent design draft does not belong to run", "POLICY_DENIED");
    }
    const designTokens = normalizeDesignTokens(input.designTokens ?? run.strategy?.designTokens);
    const openQuestions = Array.isArray(input.openQuestions) ? input.openQuestions.slice(0, 3).map((item) => ({
      field: String(item.field || "design"), question: String(item.question || "待确认设计细节"),
    })) : [];
    const inputSnapshotHash = hash(run.inputSnapshot);
    const blockRegistryVersion = run.inputSnapshot.blockRegistryVersion;
    const draft = deepFreeze({
      id: id("design"), runId, parentId: input.parentId || null,
      goalRevisionId: run.revisedFromRunId || run.id,
      inputSnapshotHash, pageTree, designTokens, blockRegistryVersion,
      openQuestions, status: "draft", designHash: designHash({ pageTree, designTokens, blockRegistryVersion, openQuestions, inputSnapshotHash }),
      createdAt: new Date().toISOString(), feedback: input.feedback ? String(input.feedback).slice(0, 2000) : null,
    });
    this.designs.set(draft.id, draft);
    run.designDraftIds = [...(run.designDraftIds || []), draft.id];
    run.designDraftId = draft.id;
    run.checkpoint = "design_draft_ready";
    this.event(runId, "design-draft.created", { designDraftId: draft.id, designHash: draft.designHash, parentId: draft.parentId });
    return draft;
  }

  applyDesignPatch(designDraftId, input = {}) {
    const previous = this.designs.get(designDraftId);
    if (!previous) throw new PolicyError("Design draft not found", "RESOURCE_NOT_FOUND");
    const run = this.runs.get(previous.runId);
    if (!run || run.designDraftId !== previous.id) throw new PolicyError("Design draft is no longer current", "STALE_REVISION");
    if (input.expectedDesignHash !== previous.designHash) throw new PolicyError("Design draft hash does not match", "STALE_REVISION");
    if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > 20) throw new PolicyError("One to twenty design operations are required", "INVALID_INPUT");
    const pageTree = clone(previous.pageTree);
    const affectedRoutes = new Set();
    for (const operation of input.operations) {
      if (!operation || typeof operation !== "object" || typeof operation.op !== "string") throw new PolicyError("Invalid design operation", "SCHEMA_REJECTED");
      const page = pageTree.find((item) => item.page === operation.page);
      if (!page) throw new PolicyError("Design operation references an unknown page", "SCHEMA_REJECTED");
      const component = page.components.find((item) => item.instanceId === operation.componentId);
      if (!component) throw new PolicyError("Design operation references an unknown component", "SCHEMA_REJECTED");
      affectedRoutes.add(page.route);
      if (operation.op === "set_props") {
        if (!operation.props || typeof operation.props !== "object" || Array.isArray(operation.props)) throw new PolicyError("set_props requires an object", "SCHEMA_REJECTED");
        assertBoundedJson(operation.props);
        component.props = { ...component.props, ...clone(operation.props) };
      } else if (operation.op === "replace_props") {
        if (!operation.props || typeof operation.props !== "object" || Array.isArray(operation.props)) throw new PolicyError("replace_props requires an object", "SCHEMA_REJECTED");
        assertBoundedJson(operation.props);
        component.props = clone(operation.props);
      } else if (operation.op === "move") {
        const toIndex = Number(operation.toIndex);
        const fromIndex = page.components.indexOf(component);
        if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= page.components.length) throw new PolicyError("Invalid component position", "SCHEMA_REJECTED");
        page.components.splice(fromIndex, 1); page.components.splice(toIndex, 0, component);
      } else {
        throw new PolicyError(`Unsupported design operation: ${operation.op}`, "SCHEMA_REJECTED");
      }
    }
    const next = this.createDesignDraft(previous.runId, {
      parentId: previous.id, pageTree, designTokens: previous.designTokens,
      blockRegistryVersion: previous.blockRegistryVersion, openQuestions: previous.openQuestions, feedback: input.feedback,
    });
    const patch = deepFreeze({
      id: id("canvas_patch"), designDraftId, nextDesignDraftId: next.id, expectedDesignHash: previous.designHash,
      operations: clone(input.operations), actor: input.actor || "operator", affectedRoutes: [...affectedRoutes], createdAt: new Date().toISOString(),
    });
    this.canvasPatches.set(patch.id, patch);
    this.event(previous.runId, "design-draft.patched", { designDraftId, nextDesignDraftId: next.id, canvasPatchId: patch.id, affectedRoutes: patch.affectedRoutes });
    return { draft: next, patch };
  }

  task(runId, role, kind, input) {
    if (!ROLES.includes(role)) throw new PolicyError(`Unknown role: ${role}`, "INVALID_INPUT");
    const run = this.runs.get(runId);
    if (!run) throw new PolicyError("Run not found", "RESOURCE_NOT_FOUND");
    const task = { id: id("task"), runId, role, kind, status: "queued", input, output: null };
    this.tasks.set(task.id, task);
    run.tasks.push(task.id);
    return task;
  }

  recordArtifact(runId, artifact) {
    const run = this.runs.get(runId);
    if (!run) throw new PolicyError("Run not found", "RESOURCE_NOT_FOUND");
    if (!artifact || typeof artifact.type !== "string" || typeof artifact.role !== "string" || artifact.runId !== runId) {
      throw new PolicyError("Invalid agent artifact", "SCHEMA_REJECTED");
    }
    const artifactId = id("artifact");
    const stored = Object.freeze({ artifactId, ...clone(artifact) });
    this.artifacts.set(artifactId, stored);
    run.artifactIds = [...(run.artifactIds || []), artifactId];
    this.event(runId, "agent.artifact.persisted", { artifactId, type: stored.type, role: stored.role });
    return stored;
  }

  artifactsForRun(runId) {
    const run = this.runs.get(runId);
    if (!run) throw new PolicyError("Run not found", "RESOURCE_NOT_FOUND");
    return (run.artifactIds || []).map((artifactId) => this.artifacts.get(artifactId)).filter(Boolean);
  }

  completeTask(taskId, output) {
    const task = this.tasks.get(taskId);
    if (!task) throw new PolicyError("Task not found", "RESOURCE_NOT_FOUND");
    task.status = "succeeded";
    task.output = Object.freeze(output);
    this.event(task.runId, "task.completed", { taskId, role: task.role, kind: task.kind });
    return task;
  }

  createCandidate(runId, input) {
    const run = this.runs.get(runId);
    if (!run) throw new PolicyError("Run not found", "RESOURCE_NOT_FOUND");
    if (input.parentId) {
      const parent = this.candidates.get(input.parentId);
      if (!parent || parent.runId !== runId) throw new PolicyError("Candidate parent does not belong to run", "POLICY_DENIED");
    }
    if (input.designDraftId) {
      const design = this.designs.get(input.designDraftId);
      if (!design || design.runId !== runId) throw new PolicyError("Candidate design draft does not belong to run", "POLICY_DENIED");
    }
    const designDraftId = input.designDraftId || run.designDraftId || null;
    const design = designDraftId ? this.designs.get(designDraftId) : null;
    const codeArtifact = input.codeArtifact ? deepFreeze(clone(input.codeArtifact)) : null;
    const cmsSnapshot = input.cmsSnapshot ? deepFreeze(clone(input.cmsSnapshot)) : null;
    const build = input.build ? deepFreeze(clone(input.build)) : null;
    const sourceRefs = deepFreeze(clone(input.sourceRefs || []));
    const parentId = input.parentId || null;
    const boundDesignHash = design?.designHash || codeArtifact?.designHash || null;
    const candidateHash = hash({ parentId, designDraftId, designHash: boundDesignHash, codeArtifact, build, cmsSnapshot, sourceRefs });
    const candidate = {
      id: id("candidate"), runId, status: "candidate", parentId,
      designDraftId,
      codeArtifact, cmsSnapshot, build,
      sourceRefs, quality: null, review: null,
      candidateHash,
      revision: Object.freeze({
        parentCandidateId: parentId,
        codeArtifact,
        designDraftId,
        designHash: boundDesignHash,
        cmsSnapshotId: cmsSnapshot?.cmsSnapshotId || null,
        buildHash: build ? hash(build) : null,
      }),
      createdAt: new Date().toISOString()
    };
    this.candidates.set(candidate.id, candidate);
    run.candidateIds.push(candidate.id);
    this.event(runId, "candidate.created", { candidateId: candidate.id, candidateHash: candidate.candidateHash });
    return candidate;
  }

  createPayloadCandidate(parentId, cmsSnapshot) {
    const parent = this.candidates.get(parentId);
    if (!parent) throw new PolicyError("Candidate not found", "RESOURCE_NOT_FOUND");
    if (!cmsSnapshot || typeof cmsSnapshot !== "object" || typeof cmsSnapshot.cmsSnapshotId !== "string") {
      throw new PolicyError("A valid CMS snapshot receipt is required", "CMS_INVALID_RECEIPT");
    }
    if (cmsSnapshot.candidateId !== parent.id) {
      throw new PolicyError("CMS snapshot is bound to another candidate", "STALE_REVISION");
    }
    if (cmsSnapshot.candidateHash !== parent.candidateHash) {
      throw new PolicyError("CMS snapshot is bound to another candidate hash", "STALE_REVISION");
    }
    const revision = this.createCandidate(parent.runId, {
      parentId: parent.id,
      designDraftId: parent.designDraftId,
      codeArtifact: parent.codeArtifact,
      build: parent.build,
      cmsSnapshot,
      sourceRefs: parent.sourceRefs,
    });
    parent.status = "superseded";
    this.event(parent.runId, "candidate.cms-revision.created", {
      parentCandidateId: parent.id,
      candidateId: revision.id,
      cmsSnapshotId: cmsSnapshot.cmsSnapshotId,
    });
    return revision;
  }

  markQuality(candidateId, quality) {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) throw new PolicyError("Candidate not found", "RESOURCE_NOT_FOUND");
    if (quality.candidateHash && quality.candidateHash !== candidate.candidateHash) throw new PolicyError("Quality result belongs to a stale candidate revision", "STALE_REVISION");
    candidate.quality = Object.freeze({ ...quality, candidateHash: candidate.candidateHash });
    candidate.status = quality.passed ? "quality_passed" : "quality_failed";
    return candidate;
  }

  packageReview(candidateId, review) {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) throw new PolicyError("Candidate not found", "RESOURCE_NOT_FOUND");
    if (!candidate.quality?.passed) throw new PolicyError("Candidate has not passed quality gates", "SCHEMA_REJECTED");
    if (!review?.approvedByReviewer) throw new PolicyError("Review decision is required", "POLICY_DENIED");
    candidate.review = Object.freeze(review);
    candidate.status = "ready_for_review";
    const draft = Object.freeze({
      id: id("draft"), candidateId, candidateHash: candidate.candidateHash,
      codeArtifact: candidate.codeArtifact, cmsSnapshot: candidate.cmsSnapshot,
      quality: candidate.quality, review: candidate.review, status: "ready_for_review",
      createdAt: new Date().toISOString()
    });
    this.drafts.set(draft.id, draft);
    this.event(candidate.runId, "draft.packaged", { draftId: draft.id, candidateId });
    return draft;
  }

  event(runId, type, data) {
    const event = { id: id("event"), runId, type, data, at: new Date().toISOString() };
    this.audit.push(event);
    this.runs.get(runId)?.events.push(event);
  }
}

export class WorktreePolicy {
  constructor(root) {
    if (!root || !path.isAbsolute(root)) throw new PolicyError("Worktree root must be an absolute configured path", "POLICY_DENIED");
    this.root = path.resolve(root);
  }

  validateRelative(file) {
    if (!file || path.isAbsolute(file)) throw new PolicyError("Absolute paths are not allowed", "POLICY_DENIED");
    const resolved = path.resolve(this.root, file);
    if (resolved !== this.root && !resolved.startsWith(`${this.root}${path.sep}`)) {
      throw new PolicyError("Path escapes project worktree", "POLICY_DENIED");
    }
    if (/(^|[\\/])(?:\.env|\.git|id_rsa|credentials)/i.test(file)) {
      throw new PolicyError("Sensitive worktree path is not writable", "POLICY_DENIED");
    }
    return resolved;
  }

  async applyPatch(files) {
    for (const [file, content] of Object.entries(files || {})) {
      const target = this.validateRelative(file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf8");
    }
    return { files: Object.keys(files || {}), root: this.root };
  }
}

export function planStrategy(project) {
  const openQuestions = [];
  if (!project.audience?.trim()) openQuestions.push({ field: "audience", question: "主要面向哪类客户或决策人？" });
  if (!project.primaryConversion?.trim()) openQuestions.push({ field: "primaryConversion", question: "官网最希望访客完成什么动作？" });
  if (!project.brandConstraints?.length) openQuestions.push({ field: "brandConstraints", question: "是否有必须遵守的品牌色、字体或禁用元素？" });
  if (!project.contentAvailable?.length) openQuestions.push({ field: "contentAvailable", question: "目前已有产品资料、案例、资质或图片素材吗？" });
  const common = {
    locales: project.locale,
    primaryConversion: project.primaryConversion || "contact",
    openQuestions: openQuestions.slice(0, 3),
  };
  if (project.industry === "industrial") {
    return { ...common, strategy: "industrial-leadgen", pageHierarchy: ["home", "products", "product-detail", "cases", "contact"], blocks: ["Hero", "ProductGrid", "TechnicalProof", "ContactForm"], qa: ["locale-links", "product-fields", "form"] };
  }
  if (project.industry === "saas") {
    return { ...common, strategy: "saas-trial", pageHierarchy: ["home", "features", "pricing", "docs", "contact"], blocks: ["Hero", "FeatureGrid", "Pricing", "FAQ", "ContactForm"], qa: ["pricing-evidence", "locale-links", "form"] };
  }
  return { ...common, strategy: "content-conversion", pageHierarchy: ["home", "about", "content", "contact"], blocks: ["Hero", "ContentGrid", "CTA", "ContactForm"], qa: ["links", "seo", "form"] };
}

export function assertTool(tool, level, grant = {}) {
  const expected = TOOLS.get(tool);
  if (!expected) throw new PolicyError(`Tool is not registered: ${tool}`, "POLICY_DENIED");
  const rank = { L0: 0, L1: 1, L2: 2 };
  if (!(level in rank) || rank[level] < rank[expected]) throw new PolicyError(`${tool} requires ${expected} permission`, "POLICY_DENIED");
  if (expected === "L2" && grant.level !== "L2") throw new PolicyError(`${tool} requires an L2 grant`, "POLICY_DENIED");
  return { tool, level: expected };
}
