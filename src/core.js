import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const ROLES = ["Architect", "Research", "Coding", "QA", "Review"];
export const TOOLS = new Map([
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
    this.candidates = new Map();
    this.drafts = new Map();
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
      locale: project.locale,
      audience: inputSnapshot.audience ?? project.audience,
      primaryConversion: inputSnapshot.primaryConversion ?? project.primaryConversion,
      brandConstraints: inputSnapshot.brandConstraints ?? project.brandConstraints,
      contentAvailable: inputSnapshot.contentAvailable ?? project.contentAvailable,
      constraints: project.constraints,
      templateBaseCommit: inputSnapshot.templateBaseCommit || "payload-website-template:31ba7ee8271998ad7aa8963111764cbacf37b157",
      blockRegistryVersion: inputSnapshot.blockRegistryVersion || "registry-v0",
      repositoryAllowlist: inputSnapshot.repositoryAllowlist || [],
      modelVersion: inputSnapshot.modelVersion || "mock-planner-v0",
      createdAt: new Date().toISOString()
    });
    const run = {
      id: id("run"), projectId, status: "running", checkpoint: "created",
      inputSnapshot: snapshot, strategy: null, tasks: [], candidateIds: [],
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
    const allowed = ["audience", "primaryConversion", "brandConstraints", "contentAvailable"];
    const inputSnapshot = Object.fromEntries(
      allowed.map((key) => [key, answers[key] ?? previous.inputSnapshot[key]]),
    );
    const next = this.createRun(previous.projectId, {
      ...inputSnapshot,
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

  task(runId, role, kind, input) {
    if (!ROLES.includes(role)) throw new PolicyError(`Unknown role: ${role}`, "INVALID_INPUT");
    const run = this.runs.get(runId);
    if (!run) throw new PolicyError("Run not found", "RESOURCE_NOT_FOUND");
    const task = { id: id("task"), runId, role, kind, status: "queued", input, output: null };
    this.tasks.set(task.id, task);
    run.tasks.push(task.id);
    return task;
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
    const candidate = {
      id: id("candidate"), runId, status: "candidate", parentId: input.parentId || null,
      codeArtifact: input.codeArtifact || null, cmsSnapshot: input.cmsSnapshot || null,
      sourceRefs: input.sourceRefs || [], quality: null, review: null,
      candidateHash: hash(input), createdAt: new Date().toISOString()
    };
    this.candidates.set(candidate.id, candidate);
    run.candidateIds.push(candidate.id);
    this.event(runId, "candidate.created", { candidateId: candidate.id, candidateHash: candidate.candidateHash });
    return candidate;
  }

  markQuality(candidateId, quality) {
    const candidate = this.candidates.get(candidateId);
    if (!candidate) throw new PolicyError("Candidate not found", "RESOURCE_NOT_FOUND");
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
  if (expected === "L2" && grant.level !== "L2") throw new PolicyError(`${tool} requires an L2 grant`, "POLICY_DENIED");
  return { tool, level: expected };
}
