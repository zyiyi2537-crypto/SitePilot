import path from "node:path";
import { SitePilotStore, WorktreePolicy, assertTool, planStrategy } from "./core.js";

const store = new SitePilotStore();
const project = store.createProject({
  goal: "创建中英双语工业设备官网，突出产品能力并获取技术咨询",
  industry: "industrial",
  locale: ["zh-CN", "en"],
  constraints: ["不得编造认证和技术参数", "仅使用公开开源代码和合成资料"]
});
const run = store.createRun(project.id, { repositoryAllowlist: ["startup-nextjs", "radix-primitives"] });
const architect = store.task(run.id, "Architect", "strategy", { goal: project.goal });
store.completeTask(architect.id, planStrategy(project));
run.strategy = architect.output;
run.checkpoint = "strategy_ready";
const research = store.task(run.id, "Research", "source_review", { repositories: run.inputSnapshot.repositoryAllowlist });
store.completeTask(research.id, { status: "candidate", sources: [{ repository: "startup-nextjs", commit: "e730b6a99c77b96c835f11347231faa4f4e9f767", license: "MIT", paths: ["src/components/Hero", "src/components/Pricing"] }] });
const worktree = assertTool("create_project_worktree", "L2", { level: "L2" });
const worktreeRoot = process.env.SITEPILOT_WORKTREE_ROOT || "/tmp/sitepilot-worktrees";
const workspace = path.resolve(worktreeRoot, run.id);
const policy = new WorktreePolicy(workspace);
await policy.applyPatch({
  "src/generated/site-strategy.json": JSON.stringify(run.strategy, null, 2),
  "src/generated/README.md": "# Generated sandbox\n\nThis candidate was created by the SitePilot V0 mock planner.\n"
});
const coding = store.task(run.id, "Coding", "code_patch", { tool: worktree.tool, workspace });
store.completeTask(coding.id, { status: "succeeded", files: ["src/generated/site-strategy.json", "src/generated/README.md"], baseCommit: run.inputSnapshot.templateBaseCommit });
const candidate = store.createCandidate(run.id, { codeArtifact: { workspace, files: coding.output.files, head: "local-uncommitted" }, sourceRefs: research.output.sources });
store.markQuality(candidate.id, { passed: true, checks: ["strategy-schema", "worktree-path-policy", "source-license"] });
const qa = store.task(run.id, "QA", "quality", { candidateId: candidate.id });
store.completeTask(qa.id, { passed: true, candidateHash: candidate.candidateHash });
const review = store.task(run.id, "Review", "package", { candidateId: candidate.id });
store.completeTask(review.id, { approvedByReviewer: "local-reviewer", notes: "V0 sandbox gates passed" });
const draft = store.packageReview(candidate.id, review.output);
run.status = "completed";
run.checkpoint = "draft_packaged";
console.log(JSON.stringify({ project, run: { id: run.id, status: run.status, checkpoint: run.checkpoint, strategy: run.strategy }, candidate, draft, auditEvents: run.events.length }, null, 2));
