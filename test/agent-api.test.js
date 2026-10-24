import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { SitePilotStore } from "../src/core.js";
import { createServer } from "../src/server.js";
import { createPiTool } from "../src/agent-tools.js";
import { computePayloadRequestHash } from "../src/payload-adapter.js";

const apiToken = "a".repeat(32);
const reviewerToken = "b".repeat(32);
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

function request(server, method, url, token, body) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    req.method = method;
    req.url = url;
    req.headers = token ? { authorization: `Bearer ${token}` } : {};
    const res = {
      writeHead(status) { this.status = status; },
      end(value) { resolve({ status: this.status, body: JSON.parse(value) }); },
    };
    server.emit("request", req, res);
    req.on("error", reject);
  });
}

test("Studio can run the Pi Supervisor workflow and read its persisted state", async () => {
  const store = new SitePilotStore();
  const project = store.createProject({ goal: "创建中英文工业产品官网并收集询盘", industry: "industrial", locale: ["zh-CN", "en"] });
  const run = store.createRun(project.id);
  const strategy = {
    audience: "工业采购人员",
    businessGoal: "展示产品并获得询盘",
    primaryConversion: "提交询盘",
    pageHierarchy: ["home", "products", "contact"],
    blocks: ["Hero", "ProductGrid", "ContactForm"],
    locales: ["zh-CN", "en"],
    designDirection: "清晰、专业、突出技术参数",
    designTokens: {
      color: { primary: "#0b6e4f", surface: "#f4f8f5", text: "#14231d" },
      spacing: { unit: 4, section: 72 },
      typography: { body: "system-ui", heading: "system-ui" },
    },
    openQuestions: [],
    evidenceRefs: [],
    qaChecks: ["forms", "locale-links"],
    tradeoffs: [],
  };
  const faux = fauxProvider({ models: [{ id: "test-model" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("delegate_architect", { whyNow: "需要先形成官网策略", expectedObservation: "得到页面和区块计划", stopIf: ["需求目标冲突"], risk: "low" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("submit_site_strategy", strategy), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("request_customer_input", { questions: [{ field: "codeAtlasSource", question: "请选择仓库和固定 commit。", reason: "组件检索需要固定来源。" }], whyNow: "代码知识库来源未配置", expectedObservation: "得到允许访问的仓库和完整 commit", stopIf: ["仓库超出白名单"], risk: "low" }), { stopReason: "toolUse" }),
  ]);
  const server = createServer(
    store,
    { apiToken, reviewerToken, reviewerId: "reviewer" },
    undefined,
    undefined,
    null,
    null,
    null,
    null,
    undefined,
    null,
    null,
    (config) => ({ endpoint: config.baseUrl, modelVersion: config.model, apiMode: config.apiMode, testConnection: async () => ({}) }),
    () => ({ model: faux.getModel(), streamFn: (model, context, options) => models.streamSimple(model, context, options) }),
  );
  assert.equal((await request(server, "POST", `/runs/${run.id}/agent`, reviewerToken, {})).status, 401);
  const configured = await request(server, "POST", "/model/config", apiToken, { baseUrl: "https://model.example/v1", model: "test-model", apiMode: "chat_completions", apiKey: "test-secret" });
  assert.equal(configured.status, 200);
  const result = await request(server, "POST", `/runs/${run.id}/agent`, apiToken, {});
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "needs_input");
  assert.equal(result.body.artifacts[0].type, "SiteStrategy");
  assert.equal(run.strategy.strategy, "industrial-agentic");
  assert.equal(run.strategy.designTokens.color.primary, "#0b6e4f");
  run.pagePlan = {
    routes: [{
      page: "home",
      route: "/",
      components: [{ name: "Hero", registryId: "block_hero", source: { repository: "payload", commit: "a".repeat(40), path: "src/Hero.tsx" } }],
    }],
  };
  const design = await request(server, "POST", `/runs/${run.id}/design-drafts`, apiToken, {});
  assert.equal(design.status, 201);
  assert.equal(design.body.designTokens.color.primary, "#0b6e4f");
  const status = await request(server, "GET", `/runs/${run.id}/agent`, apiToken);
  assert.equal(status.body.agentState.status, "needs_input");
  assert.equal(status.body.artifacts.length, 1);
  store.event(run.id, "agent.decision", {
    agentRunId: `${run.id}:research:1`,
    role: "Research",
    action: "retrieve_codeatlas",
    whyNow: "确认组件能否复用",
    expectedObservation: "得到固定提交的来源证据",
    stopIf: ["提交版本不一致"],
    risk: "low",
    at: new Date().toISOString(),
  });
  const decisionStatus = await request(server, "GET", `/runs/${run.id}/agent`, apiToken);
  assert.equal(decisionStatus.body.decisions.length, 3);
  assert.equal(decisionStatus.body.decisions.at(-1).role, "Research");
  assert.ok(decisionStatus.body.decisions.every((decision) => decision.whyNow && decision.expectedObservation && Array.isArray(decision.stopIf)));
  const modelStatus = await request(server, "GET", "/model/status", apiToken);
  assert.equal(JSON.stringify(modelStatus.body).includes("test-secret"), false);
});

test("Pi Supervisor dispatches a bounded ContentCMS model after the frozen design", async () => {
  const store = new SitePilotStore();
  const project = store.createProject({ goal: "Build a concise product website", locale: ["en"] });
  const run = store.createRun(project.id);
  run.strategy = { pageHierarchy: ["home"], blocks: ["Hero"], locales: ["en"], strategy: "content-conversion" };
  run.research = { repository: "payload", commit: "a".repeat(40), componentPlan: { decisions: [] }, evidence: [] };
  run.pagePlan = { sourceManifestHash: "pageplan_hash", routes: [{ page: "home", route: "/", components: [{ name: "Hero", registryId: "hero", source: { repository: "payload", commit: "a".repeat(40), path: "Hero.tsx" } }] }] };
  const design = store.createDesignDraft(run.id);
  const candidate = store.createCandidate(run.id, { designDraftId: design.id, build: { passed: true }, codeArtifact: { designHash: design.designHash } });
  const evidence = new (await import("../src/evidence.js")).EvidenceStore();
  const sourceRecord = evidence.registerSource({ projectId: project.id, kind: "client", name: "facts.md", content: "Approved product facts" });
  const record = evidence.addRecord({ sourceId: sourceRecord.id, locator: "line:1", quote: "Approved product facts" });
  const claim = evidence.createClaim({ projectId: project.id, statement: "Approved product fact", evidenceIds: [record.id], status: "supported" });
  assert.equal(store.projects.get(project.id).goal, "Build a concise product website");
  const faux = fauxProvider({ models: [{ id: "test-model" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("delegate_content_cms", { whyNow: "设计和页面计划已冻结", expectedObservation: "得到绑定设计版本的内容模型", stopIf: ["Claim 不足"], risk: "medium" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("inspect_payload_schema", { collection: "pages" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("submit_content_model", { status: "proposed", contentByPage: { home: { title: "Home", heroTitle: "Approved product", description: "Approved description", claimRefs: [claim.id] } }, whyNow: "当前页面已有客户事实", expectedObservation: "内容模型绑定当前设计并可供 Payload 规划", stopIf: ["事实或 Claim 不完整"], risk: "medium" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("complete_plan", { summary: "ContentModel is proposed for review", whyNow: "内容模型已经结构化", expectedObservation: "客户审核后进入 Payload 规划", stopIf: ["客户未确认"], risk: "medium" }), { stopReason: "toolUse" }),
  ]);
  const server = createServer(
    store,
    { apiToken, reviewerToken, reviewerId: "reviewer" },
    evidence,
    undefined,
    null,
    null,
    null,
    null,
    undefined,
    null,
    null,
    (config) => ({ endpoint: config.baseUrl, modelVersion: config.model, apiMode: config.apiMode, testConnection: async () => ({}) }),
    () => ({ model: faux.getModel(), streamFn: (model, context, options) => models.streamSimple(model, context, options) }),
  );
  const configured = await request(server, "POST", "/model/config", apiToken, { baseUrl: "https://model.example/v1", model: "test-model", apiMode: "chat_completions", apiKey: "test-secret" });
  assert.equal(configured.status, 200);
  const result = await request(server, "POST", `/runs/${run.id}/agent`, apiToken, { phase: "content", candidateId: candidate.id });
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "content_review_required");
  assert.equal(result.body.contentModel.status, "proposed");
  assert.equal(result.body.contentModel.designDraftId, design.id);
  assert.deepEqual(result.body.contentModel.contentByPage.home.claimRefs, [claim.id]);
  assert.equal(result.body.artifacts.filter((artifact) => artifact.type === "ContentModel").length, 1);
  assert.equal(candidate.cmsSnapshot, null);
  assert.equal(candidate.contentModel.contentHash, result.body.contentModel.contentHash);

  let payloadWrites = 0;
  const payloadServer = createServer(store, { apiToken, reviewerToken, reviewerId: "reviewer" }, evidence, undefined, null, {
    createDraft: async (input) => {
      payloadWrites += 1;
      return {
        candidateId: input.candidateId,
        candidateHash: input.candidateHash,
        designDraftId: input.designDraftId,
        designHash: input.designHash,
        designMappings: input.designMappings,
        cmsSnapshotId: "cms_agent_1",
        idempotencyKey: input.idempotencyKey,
        requestHash: computePayloadRequestHash(input),
        status: "sandbox_draft",
      };
    },
  });
  const unapprovedWrite = await request(payloadServer, "POST", `/candidates/${candidate.id}/payload-draft`, apiToken, {
    expectedCmsSnapshot: "cms_0", idempotencyKey: "agent-content-1", contentByPage: result.body.contentModel.contentByPage, useAgentContent: false,
  });
  assert.equal(unapprovedWrite.status, 422);
  assert.equal(unapprovedWrite.body.code, "CONTENT_APPROVAL_REQUIRED");
  assert.equal(payloadWrites, 0);
  const wrongCredential = await request(payloadServer, "POST", `/candidates/${candidate.id}/content-approval`, apiToken, { approved: true, expectedContentHash: result.body.contentModel.contentHash });
  assert.equal(wrongCredential.status, 401);
  const approval = await request(payloadServer, "POST", `/candidates/${candidate.id}/content-approval`, reviewerToken, { approved: true, expectedContentHash: result.body.contentModel.contentHash });
  assert.equal(approval.status, 201);
  assert.equal(approval.body.status, "approved");
  const tamperedWrite = await request(payloadServer, "POST", `/candidates/${candidate.id}/payload-draft`, apiToken, {
    expectedCmsSnapshot: "cms_0", idempotencyKey: "agent-content-2", contentByPage: { home: { ...result.body.contentModel.contentByPage.home, heroTitle: "changed" } }, useAgentContent: false,
  });
  assert.equal(tamperedWrite.status, 409);
  assert.equal(tamperedWrite.body.code, "CONTENT_MODEL_CHANGED");
  const approvedWrite = await request(payloadServer, "POST", `/candidates/${candidate.id}/payload-draft`, apiToken, {
    expectedCmsSnapshot: "cms_0", idempotencyKey: "agent-content-3", contentByPage: result.body.contentModel.contentByPage, useAgentContent: true,
  });
  assert.equal(approvedWrite.status, 201);
  assert.equal(payloadWrites, 1);

  const untrustedCandidate = store.createCandidate(run.id, { designDraftId: design.id, build: { passed: true }, codeArtifact: { designHash: design.designHash } });
  const payloadDraftEventsBeforeBlockedRun = store.audit.filter((event) => event.runId === run.id && event.type === "payload.draft.created").length;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("delegate_content_cms", { whyNow: "需要校验候选内容", expectedObservation: "输出设计版本绑定的内容模型", stopIf: ["证据不足"], risk: "medium" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("inspect_payload_schema", { collection: "pages" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("submit_content_model", { status: "proposed", contentByPage: { home: { title: "Home", heroTitle: "Unsupported claim", claimRefs: ["claim_forged"] } }, whyNow: "尝试提交模型输出", expectedObservation: "服务器校验 Claim 归属", stopIf: ["引用无效"], risk: "medium" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("submit_content_model", { status: "needs_input", questions: [{ field: "productFacts", question: "请提供可验证的产品资料。", reason: "内容模型引用了不存在的 Claim。" }], whyNow: "页面事实没有有效 Claim", expectedObservation: "客户补充证据后再生成内容", stopIf: ["仍无客户证据"], risk: "medium" }), { stopReason: "toolUse" }),
  ]);
  const blocked = await request(server, "POST", `/runs/${run.id}/agent`, apiToken, { phase: "content", candidateId: untrustedCandidate.id, allowedClaimRefs: ["claim_forged"] });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.body.status, "needs_input");
  assert.equal(untrustedCandidate.contentModel.status, "needs_input");
  assert.equal(untrustedCandidate.cmsSnapshot, null);
  assert.equal(store.audit.filter((event) => event.runId === run.id && event.type === "payload.draft.created").length, payloadDraftEventsBeforeBlockedRun);
  assert.equal(blocked.body.artifacts.filter((artifact) => artifact.type === "ContentModel").length, 2);
});

test("Review phase requires QA and persists a candidate-bound independent decision", async () => {
  const store = new SitePilotStore();
  const project = store.createProject({ goal: "Review a generated website", locale: ["en"] });
  const run = store.createRun(project.id);
  run.strategy = { pageHierarchy: ["home"], blocks: ["Hero"], locales: ["en"] };
  run.pagePlan = { routes: [{ page: "home", route: "/", components: [{ name: "Hero", registryId: "hero", source: { repository: "payload", commit: "a".repeat(40), path: "Hero.tsx" } }] }] };
  const design = store.createDesignDraft(run.id);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sitepilot-review-api-"));
  const workspace = path.join(root, run.id, design.id);
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.writeFile(path.join(workspace, "src", "App.tsx"), "export default function App() {}\n");
  const candidate = store.createCandidate(run.id, { designDraftId: design.id, build: { passed: true }, codeArtifact: { workspace, files: ["src/App.tsx"], head: "local-uncommitted", designDraftId: design.id, designHash: design.designHash } });
  store.markQuality(candidate.id, { passed: true, reportHash: "qa_report_review_1", results: [{ check: "links", passed: true }] });
  const faux = fauxProvider({ models: [{ id: "test-model" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("delegate_review", { whyNow: "QA 已通过，需要独立审查", expectedObservation: "得到绑定候选版本的 ReviewDecision", stopIf: ["源码发生变化"], risk: "medium" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("inspect_source_package", { sourceId: `candidate:${candidate.id}`, paths: ["src/App.tsx"] }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("run_quality_checks", { candidateId: candidate.id, candidateHash: candidate.candidateHash }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("submit_review_decision", { whyNow: "源码和 QA 报告均已检查", expectedObservation: "没有阻断性问题，交给人工 Reviewer", stopIf: ["QA 报告 hash 不匹配"], risk: "low", status: "approved", candidateId: candidate.id, candidateHash: candidate.candidateHash, qualityReportHash: candidate.quality.reportHash, summary: "独立只读检查通过", findings: [] }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("complete_plan", { whyNow: "ReviewDecision 已写入候选", expectedObservation: "流程停在人工最终审核", stopIf: ["候选版本变化"], risk: "low", summary: "Review 完成" }), { stopReason: "toolUse" }),
  ]);
  const server = createServer(
    store,
    { apiToken, reviewerToken, reviewerId: "reviewer" },
    undefined,
    undefined,
    null,
    null,
    null,
    { worktreeRoot: root },
    undefined,
    null,
    null,
    (config) => ({ endpoint: config.baseUrl, modelVersion: config.model, apiMode: config.apiMode, testConnection: async () => ({}) }),
    () => ({ model: faux.getModel(), streamFn: (model, context, options) => models.streamSimple(model, context, options) }),
  );
  assert.equal((await request(server, "POST", "/model/config", apiToken, { baseUrl: "https://model.example/v1", model: "test-model", apiMode: "chat_completions", apiKey: "test-secret" })).status, 200);
  const result = await request(server, "POST", `/runs/${run.id}/agent`, apiToken, { phase: "review", candidateId: candidate.id });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.status, "review_approved");
  assert.equal(result.body.reviewDecision.candidateHash, candidate.candidateHash);
  assert.equal(result.body.reviewDecision.qualityReportHash, candidate.quality.reportHash);
  assert.equal(result.body.review_approved, true);
  assert.equal(candidate.independentReview.status, "approved");
  assert.equal(store.artifactsForRun(run.id).filter((artifact) => artifact.type === "ReviewDecision").length, 1);
  const repeated = await request(server, "POST", `/runs/${run.id}/agent`, apiToken, { phase: "review", candidateId: candidate.id });
  assert.equal(repeated.status, 409);
  assert.equal(repeated.body.code, "REVIEW_ALREADY_COMPLETED");
  const failedCandidate = store.createCandidate(run.id, { designDraftId: design.id, build: { passed: true }, codeArtifact: candidate.codeArtifact });
  store.markQuality(failedCandidate.id, { passed: false, reportHash: "qa_report_failed" });
  const blocked = await request(server, "POST", `/runs/${run.id}/agent`, apiToken, { phase: "review", candidateId: failedCandidate.id });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.code, "QUALITY_GATE_REQUIRED");
  await fs.rm(root, { recursive: true, force: true });
});

test("Review changes_requested creates bounded repair candidates and stops after three rounds", async (t) => {
  const worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sitepilot-repair-api-"));
  t.after(() => fs.rm(worktreeRoot, { recursive: true, force: true }));
  const store = new SitePilotStore();
  const project = store.createProject({ goal: "Repair a reviewed website", locale: ["en"] });
  const run = store.createRun(project.id);
  run.strategy = { pageHierarchy: ["home"], blocks: ["Hero"], locales: ["en"] };
  run.pagePlan = { routes: [{ page: "home", route: "/", components: [{ name: "Hero", registryId: "hero", source: { repository: "payload", commit: "a".repeat(40), path: "Hero.tsx" } }] }] };
  const design = store.createDesignDraft(run.id);
  const workspace = path.join(worktreeRoot, run.id, design.id);
  const sourcePath = "src/app/home.tsx";
  const manifestPath = "src/generated/sitepilot-manifest.json";
  const source = "export default function Page() { return <main data-sitepilot-page=\"home\">Needs repair</main>; }\n";
  const routes = [{ page: "home", route: "/", file: sourcePath }];
  const manifest = { routes, sourceManifestHash: hash(routes), design: { designHash: design.designHash } };
  await fs.mkdir(path.dirname(path.join(workspace, sourcePath)), { recursive: true });
  await fs.mkdir(path.dirname(path.join(workspace, manifestPath)), { recursive: true });
  await fs.writeFile(path.join(workspace, sourcePath), source);
  await fs.writeFile(path.join(workspace, manifestPath), `${JSON.stringify(manifest)}\n`);
  const candidate = store.createCandidate(run.id, {
    designDraftId: design.id,
    build: { passed: true },
    codeArtifact: { workspace, files: [sourcePath, manifestPath], head: "local-uncommitted", designDraftId: design.id, designHash: design.designHash },
  });
  store.markQuality(candidate.id, { passed: true, reportHash: "qa_repair_1", results: [{ check: "links", passed: true }] });
  const decision = {
    status: "changes_requested",
    candidateId: candidate.id,
    candidateHash: candidate.candidateHash,
    qualityReportHash: candidate.quality.reportHash,
    whyNow: "发现首页实现问题",
    expectedObservation: "修复后只生成新的候选版本",
    stopIf: ["候选源码发生变化"],
    risk: "medium",
    summary: "请修复首页文案标记",
    findings: [{ severity: "high", path: sourcePath, message: "页面需要修复", evidence: "Review source" }],
    questions: [],
  };
  candidate.independentReview = { ...decision, decisionHash: hash(decision) };
  run.reviewDecision = decision;
  run.reviewCycle = { repairRound: 0, round: 0, maxRounds: 3, parentCandidateId: candidate.id, parentCandidateHash: candidate.candidateHash, reviewDecisionHash: hash(decision), status: "awaiting_repair" };
  const l2Token = "c".repeat(32);
  const server = createServer(store, { apiToken, reviewerToken, l2Token, reviewerId: "reviewer" }, undefined, undefined, null, null, null, { worktreeRoot });
  const blockedDraft = await request(server, "POST", `/candidates/${candidate.id}/review`, reviewerToken, { approved: true });
  assert.equal(blockedDraft.status, 422);
  assert.equal(blockedDraft.body.code, "REVIEW_GATE_REQUIRED");
  const diff = `--- a/${sourcePath}\n+++ b/${sourcePath}\n@@ -1,1 +1,1 @@\n-${source.slice(0, -1)}\n+export default function Page() { return <main data-sitepilot-page=\"home\">Repaired</main>; }\n`;
  const patch = {
    whyNow: "Review 指出了首页实现问题",
    expectedObservation: "隔离子候选包含修复后的页面",
    stopIf: ["候选 hash 变化"],
    risk: "medium",
    status: "proposed",
    candidateId: candidate.id,
    candidateHash: candidate.candidateHash,
    expectedHead: hash([
      { path: manifestPath, size: Buffer.byteLength(`${JSON.stringify(manifest)}\n`), sha256: crypto.createHash("sha256").update(`${JSON.stringify(manifest)}\n`).digest("hex") },
      { path: sourcePath, size: Buffer.byteLength(source), sha256: crypto.createHash("sha256").update(source).digest("hex") },
    ].sort((left, right) => left.path.localeCompare(right.path))),
    reviewDecisionHash: hash(decision),
    files: [{ path: sourcePath, operation: "modify", summary: "修复首页标记", findingIndexes: [0], diff }],
    expectedTests: ["npm test"],
    risks: [],
  };
  const stalePatch = { ...patch, candidateHash: "f".repeat(64) };
  const staleProposal = await request(server, "POST", `/candidates/${candidate.id}/rework`, reviewerToken, { patch: stalePatch });
  assert.equal(staleProposal.status, 422);
  assert.equal(staleProposal.body.code, "STALE_REVISION");
  const proposal = await request(server, "POST", `/candidates/${candidate.id}/rework`, reviewerToken, { patch });
  assert.equal(proposal.status, 202, JSON.stringify(proposal.body));
  assert.equal(proposal.body.status, "repair_ready_for_execution");
  const unauthorized = await request(server, "POST", `/candidates/${candidate.id}/rework-execution`, reviewerToken, {});
  assert.equal(unauthorized.status, 401);
  const grant = await request(server, "POST", `/runs/${run.id}/grants`, reviewerToken, { tool: "apply_review_repair", candidateId: candidate.id, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(grant.status, 201, JSON.stringify(grant.body));
  const executed = await request(server, "POST", `/candidates/${candidate.id}/rework-execution`, l2Token, { grantId: grant.body.id });
  assert.equal(executed.status, 201, JSON.stringify(executed.body));
  const child = executed.body.candidate;
  assert.equal(child.parentId, candidate.id);
  assert.equal(child.quality, null);
  assert.equal(child.independentReview, undefined);
  assert.equal(child.contentModel, null);
  assert.equal(child.contentApproval, null);
  assert.equal(child.cmsSnapshot, null);
  assert.equal(run.contentModel, null);
  assert.equal(candidate.status, "superseded");
  assert.equal(run.reviewCycle.status, "awaiting_qa");
  assert.equal(run.reviewCycle.repairRound, 1);
  assert.equal(await fs.readFile(path.join(child.codeArtifact.workspace, sourcePath), "utf8"), "export default function Page() { return <main data-sitepilot-page=\"home\">Repaired</main>; }\n");

  run.reviewCycle = { ...run.reviewCycle, status: "awaiting_repair", repairRound: 3, round: 3, parentCandidateId: child.id, parentCandidateHash: child.candidateHash };
  child.independentReview = { ...decision, candidateId: child.id, candidateHash: child.candidateHash, qualityReportHash: "qa_repair_2", decisionHash: hash({ ...decision, candidateId: child.id, candidateHash: child.candidateHash, qualityReportHash: "qa_repair_2" }) };
  const limit = await request(server, "POST", `/candidates/${child.id}/rework`, reviewerToken, {});
  assert.equal(limit.status, 409);
  assert.equal(limit.body.code, "HUMAN_REVIEW_REQUIRED");
  assert.equal(run.reviewCycle.status, "human_required");
});

test("Repair phase delegates Review findings to read-only Coding", async (t) => {
  const worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sitepilot-repair-agent-api-"));
  t.after(() => fs.rm(worktreeRoot, { recursive: true, force: true }));
  const store = new SitePilotStore();
  const project = store.createProject({ goal: "Repair a reviewed website", locale: ["en"] });
  const run = store.createRun(project.id);
  run.strategy = { strategy: "content-conversion", pageHierarchy: ["home"], blocks: ["Hero"], locales: ["en"] };
  run.research = { repository: "approved/repo", commit: "a".repeat(40), componentPlan: { decisions: [] }, evidence: [] };
  run.pagePlan = { sourceManifestHash: "page-plan-hash", routes: [{ page: "home", route: "/", components: [{ name: "Hero", registryId: "hero", source: { repository: "approved/repo", commit: "a".repeat(40), path: "src/Hero.tsx" } }] }] };
  const design = store.createDesignDraft(run.id);
  const workspace = path.join(worktreeRoot, run.id, design.id);
  const sourcePath = "src/app/home.tsx";
  const sourceContent = "export default function Page() { return <main data-sitepilot-page=\"home\">Needs repair</main>; }\n";
  const manifestPath = "src/generated/sitepilot-manifest.json";
  const routes = [{ page: "home", route: "/", file: sourcePath }];
  const manifest = { routes, sourceManifestHash: hash(routes), design: { designHash: design.designHash } };
  await fs.mkdir(path.dirname(path.join(workspace, sourcePath)), { recursive: true });
  await fs.mkdir(path.dirname(path.join(workspace, manifestPath)), { recursive: true });
  await fs.writeFile(path.join(workspace, sourcePath), sourceContent);
  await fs.writeFile(path.join(workspace, manifestPath), `${JSON.stringify(manifest)}\n`);
  const sourceManifest = [
    { path: sourcePath, size: Buffer.byteLength(sourceContent), sha256: crypto.createHash("sha256").update(sourceContent).digest("hex") },
    { path: manifestPath, size: Buffer.byteLength(`${JSON.stringify(manifest)}\n`), sha256: crypto.createHash("sha256").update(`${JSON.stringify(manifest)}\n`).digest("hex") },
  ].sort((left, right) => left.path.localeCompare(right.path));
  const expectedHead = hash(sourceManifest);
  const candidate = store.createCandidate(run.id, {
    designDraftId: design.id,
    build: { passed: true },
    codeArtifact: { workspace, files: [sourcePath, manifestPath], head: "local-uncommitted", designDraftId: design.id, designHash: design.designHash },
  });
  store.markQuality(candidate.id, { passed: true, reportHash: "qa_repair_agent", results: [{ check: "links", passed: true }] });
  const decision = {
    status: "changes_requested",
    candidateId: candidate.id,
    candidateHash: candidate.candidateHash,
    qualityReportHash: candidate.quality.reportHash,
    whyNow: "Review 发现首页源码问题",
    expectedObservation: "修复补丁覆盖所有发现项",
    stopIf: ["源码 head 发生变化"],
    risk: "medium",
    summary: "修复首页标记",
    findings: [{ severity: "high", path: sourcePath, message: "首页标记需要修复", evidence: "Review source" }],
    questions: [],
  };
  const decisionHash = hash(decision);
  candidate.independentReview = { ...decision, decisionHash };
  run.reviewCycle = { repairRound: 0, round: 0, maxRounds: 3, parentCandidateId: candidate.id, parentCandidateHash: candidate.candidateHash, reviewDecisionHash: decisionHash, status: "awaiting_repair" };
  const faux = fauxProvider({ models: [{ id: "test-model" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("delegate_coding", { whyNow: "Review 已要求源码返修", expectedObservation: "得到绑定 finding 的补丁", stopIf: ["候选版本变化"], risk: "medium" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("inspect_source_package", { sourceId: `candidate:${candidate.id}`, paths: [sourcePath] }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("submit_code_patch_plan", {
      whyNow: "修复 Review 指出的首页问题",
      expectedObservation: "每个 finding 都有明确的源码修改",
      stopIf: ["ReviewDecision hash 变化"],
      risk: "medium",
      status: "proposed",
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      designDraftId: design.id,
      designHash: design.designHash,
      pagePlanHash: run.pagePlan.sourceManifestHash,
      contentHash: null,
      expectedHead,
      reviewDecisionHash: decisionHash,
      files: [{ path: sourcePath, operation: "modify", summary: "修复首页标记", sourceRefs: [], findingIndexes: [0], diff: `--- a/${sourcePath}\n+++ b/${sourcePath}\n@@ -1,1 +1,1 @@\n-${sourceContent.slice(0, -1)}\n+export default function Page() { return <main data-sitepilot-page=\"home\">Repaired</main>; }\n` }],
      expectedTests: ["npm test"],
      risks: [],
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("complete_plan", { whyNow: "补丁已结构化", expectedObservation: "L2 执行前由 Reviewer 再确认", stopIf: ["补丁 hash 变化"], risk: "medium", summary: "Repair CodePatch ready" }), { stopReason: "toolUse" }),
  ]);
  const server = createServer(
    store,
    { apiToken, reviewerToken, reviewerId: "reviewer" },
    undefined,
    undefined,
    null,
    null,
    null,
    { worktreeRoot },
    undefined,
    null,
    null,
    (config) => ({ endpoint: config.baseUrl, modelVersion: config.model, apiMode: config.apiMode, testConnection: async () => ({}) }),
    () => ({ model: faux.getModel(), streamFn: (model, context, options) => models.streamSimple(model, context, options) }),
  );
  assert.equal((await request(server, "POST", "/model/config", apiToken, { baseUrl: "https://model.example/v1", model: "test-model", apiMode: "chat_completions", apiKey: "test-secret" })).status, 200);
  const result = await request(server, "POST", `/runs/${run.id}/agent`, apiToken, { phase: "repair", candidateId: candidate.id });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.status, "repair_patch_ready", JSON.stringify(result.body));
  assert.equal(result.body.codePatch.reviewDecisionHash, decisionHash);
  assert.equal(result.body.codePatch.files[0].findingIndexes[0], 0);
  assert.equal(result.body.repairPatch.reviewDecisionHash, decisionHash);
  assert.equal(run.repairPatch.codePatchHash, result.body.repairPatch.codePatchHash);
  assert.equal(await fs.readFile(path.join(workspace, sourcePath), "utf8"), sourceContent);
});

test("ContentCMS drafting stays below the Payload write grant", () => {
  assert.throws(() => createPiTool({
    role: "ContentCMS",
    name: "create_payload_draft",
    runContext: { runId: "run_1", agentRunId: "run_1:contentcms:1", inputSnapshotId: "snapshot:run_1", grant: { level: "L0" } },
    handler: async () => ({ accepted: true }),
  }), /requires L1 permission/);
  assert.throws(() => createPiTool({
    role: "Research",
    name: "submit_content_model",
    runContext: { runId: "run_1", agentRunId: "run_1:research:1", inputSnapshotId: "snapshot:run_1", grant: { level: "L0" } },
    handler: async () => ({ accepted: true }),
  }), /cannot use submit_content_model/);
  assert.throws(() => createPiTool({
    role: "Coding",
    name: "apply_code_patch",
    runContext: { runId: "run_1", agentRunId: "run_1:coding:1", inputSnapshotId: "snapshot:run_1", grant: { level: "L0" } },
    handler: async () => ({ accepted: true }),
  }), /cannot use apply_code_patch/);
});

test("Coding proposes a read-only CodePatch bound to the approved candidate and design", async (t) => {
  const worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sitepilot-coding-api-"));
  t.after(() => fs.rm(worktreeRoot, { recursive: true, force: true }));
  const store = new SitePilotStore();
  const project = store.createProject({ goal: "Build a reviewed product website", locale: ["en"] });
  const run = store.createRun(project.id);
  run.strategy = { strategy: "content-conversion", pageHierarchy: ["home"], blocks: ["Hero"], locales: ["en"] };
  run.research = { repository: "approved/repo", commit: "a".repeat(40), componentPlan: { decisions: [] }, evidence: [] };
  run.pagePlan = {
    sourceManifestHash: "page-plan-hash",
    routes: [{ page: "home", route: "/", components: [{ name: "Hero", registryId: "hero", source: { repository: "approved/repo", commit: "a".repeat(40), path: "src/Hero.tsx" } }] }],
  };
  const design = store.createDesignDraft(run.id);
  const workspace = path.join(worktreeRoot, run.id, design.id);
  const sourcePath = "src/app/home.tsx";
  const sourceContent = "export default function Page() { return <main data-sitepilot-page=\"home\">Existing page</main>; }\n";
  const manifestPath = "src/generated/sitepilot-manifest.json";
  const manifestRoutes = [{ page: "home", route: "/", file: sourcePath }];
  const manifest = { routes: manifestRoutes, sourceManifestHash: hash(manifestRoutes), design: { designHash: design.designHash } };
  await fs.mkdir(path.dirname(path.join(workspace, sourcePath)), { recursive: true });
  await fs.mkdir(path.dirname(path.join(workspace, manifestPath)), { recursive: true });
  await fs.writeFile(path.join(workspace, sourcePath), sourceContent);
  await fs.writeFile(path.join(workspace, manifestPath), `${JSON.stringify(manifest)}\n`);
  const sourceManifest = [
    { path: sourcePath, size: Buffer.byteLength(sourceContent), sha256: crypto.createHash("sha256").update(sourceContent).digest("hex") },
    { path: manifestPath, size: Buffer.byteLength(`${JSON.stringify(manifest)}\n`), sha256: crypto.createHash("sha256").update(`${JSON.stringify(manifest)}\n`).digest("hex") },
  ].sort((left, right) => left.path.localeCompare(right.path));
  const expectedHead = hash(sourceManifest);
  const candidate = store.createCandidate(run.id, {
    designDraftId: design.id,
    build: { passed: true },
    codeArtifact: { workspace, files: [sourcePath, manifestPath], head: "local-uncommitted", designDraftId: design.id, designHash: design.designHash },
    sourceRefs: [{ evidenceId: "evidence_hero", repository: "approved/repo", commit: "a".repeat(40), path: "src/Hero.tsx" }],
  });
  const contentModel = {
    candidateId: candidate.id,
    candidateHash: candidate.candidateHash,
    designDraftId: design.id,
    designHash: design.designHash,
    pagePlanHash: run.pagePlan.sourceManifestHash,
    contentByPage: { home: { title: "Home", heroTitle: "Approved product", claimRefs: ["claim_1"] } },
    status: "proposed",
  };
  contentModel.contentHash = hash({
    candidateId: contentModel.candidateId,
    candidateHash: contentModel.candidateHash,
    designDraftId: contentModel.designDraftId,
    designHash: contentModel.designHash,
    pagePlanHash: contentModel.pagePlanHash,
    contentByPage: contentModel.contentByPage,
  });
  candidate.contentModel = contentModel;
  run.contentModel = contentModel;

  const faux = fauxProvider({ models: [{ id: "test-model" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("delegate_coding", { whyNow: "The customer approved page content", expectedObservation: "A bounded code plan", stopIf: ["The candidate source changed"], risk: "medium" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("inspect_source_package", { sourceId: `candidate:${candidate.id}`, paths: [sourcePath] }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("submit_code_patch_plan", {
      whyNow: "Attempt an out-of-scope file change",
      expectedObservation: "The server blocks path traversal",
      stopIf: ["The path is not in the candidate manifest"],
      risk: "high",
      status: "proposed",
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      designDraftId: design.id,
      designHash: design.designHash,
      pagePlanHash: run.pagePlan.sourceManifestHash,
      contentHash: contentModel.contentHash,
      expectedHead,
      files: [{ path: "../../.env", operation: "modify", summary: "Attempt forbidden edit", sourceRefs: ["evidence_hero"], diff: "invalid" }],
      expectedTests: ["npm test"],
      risks: [],
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("submit_code_patch_plan", {
      whyNow: "The current page needs component adaptation",
      expectedObservation: "Reviewer can inspect the exact intended file changes",
      stopIf: ["The candidate hash no longer matches"],
      risk: "medium",
      status: "proposed",
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      designDraftId: design.id,
      designHash: design.designHash,
      pagePlanHash: run.pagePlan.sourceManifestHash,
      contentHash: contentModel.contentHash,
      expectedHead,
      files: [{ path: sourcePath, operation: "modify", summary: "Adapt the hero layout to the approved direction", sourceRefs: ["evidence_hero"], diff: `--- a/${sourcePath}\n+++ b/${sourcePath}\n@@ -1,1 +1,1 @@\n-${sourceContent.slice(0, -1)}\n+export default function Page() { return <main data-sitepilot-page=\"home\">Updated page</main>; }\n` }],
      expectedTests: ["npm test"],
      risks: ["Visual regression must be checked in preview"],
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("complete_plan", { whyNow: "The code plan is structured", expectedObservation: "The reviewer sees the proposed change", stopIf: ["Reviewer rejects the plan"], risk: "medium", summary: "CodePatch is ready for review" }), { stopReason: "toolUse" }),
  ]);
  const server = createServer(
    store,
    { apiToken, reviewerToken, reviewerId: "reviewer" },
    undefined,
    undefined,
    null,
    null,
    null,
    { worktreeRoot },
    undefined,
    null,
    null,
    (config) => ({ endpoint: config.baseUrl, modelVersion: config.model, apiMode: config.apiMode, testConnection: async () => ({}) }),
    () => ({ model: faux.getModel(), streamFn: (model, context, options) => models.streamSimple(model, context, options) }),
  );
  assert.equal((await request(server, "POST", "/model/config", apiToken, { baseUrl: "https://model.example/v1", model: "test-model", apiMode: "chat_completions", apiKey: "test-secret" })).status, 200);
  assert.equal((await request(server, "POST", `/runs/${run.id}/agent`, apiToken, { phase: "coding", candidateId: candidate.id })).body.code, "CONTENT_APPROVAL_REQUIRED");

  candidate.contentApproval = {
    candidateId: candidate.id,
    candidateHash: candidate.candidateHash,
    designDraftId: design.id,
    designHash: design.designHash,
    contentHash: contentModel.contentHash,
    approvedBy: "reviewer",
    approvedAt: new Date().toISOString(),
  };
  const result = await request(server, "POST", `/runs/${run.id}/agent`, apiToken, { phase: "coding", candidateId: candidate.id });
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "code_review_required");
  assert.equal(result.body.codePatch.status, "proposed");
  assert.equal(result.body.codePatch.candidateHash, candidate.candidateHash);
  assert.equal(result.body.codePatch.designHash, design.designHash);
  assert.equal(result.body.codePatch.expectedHead, expectedHead);
  assert.equal(result.body.codePatch.files[0].path, sourcePath);
  assert.equal(result.body.codePatch.codePatchHash.length, 64);
  assert.equal(store.audit.some((event) => event.type === "agent.code_patch.rejected" && event.data?.code === "POLICY_DENIED"), true);
  assert.equal(result.body.artifacts.filter((artifact) => artifact.type === "CodePatch" && artifact.status === "proposed").length, 1);
  assert.equal(await fs.readFile(path.join(workspace, sourcePath), "utf8"), sourceContent);
  assert.equal(store.audit.some((event) => event.runId === run.id && event.type === "agent.started" && event.data?.role === "Coding"), true);

  const patchHash = result.body.codePatch.codePatchHash;
  const unauthorizedApproval = await request(server, "POST", `/candidates/${candidate.id}/code-patch-approval`, apiToken, { approved: true, expectedCodePatchHash: patchHash });
  assert.equal(unauthorizedApproval.status, 401);
  const wrongHashApproval = await request(server, "POST", `/candidates/${candidate.id}/code-patch-approval`, reviewerToken, { approved: true, expectedCodePatchHash: "f".repeat(64) });
  assert.equal(wrongHashApproval.status, 409);
  assert.equal(wrongHashApproval.body.code, "CODE_PATCH_CHANGED");
  const rejectedApproval = await request(server, "POST", `/candidates/${candidate.id}/code-patch-approval`, reviewerToken, { expectedCodePatchHash: patchHash });
  assert.equal(rejectedApproval.status, 422);
  assert.equal(rejectedApproval.body.code, "CODE_PATCH_REVIEW_NOT_APPROVED");
  const approval = await request(server, "POST", `/candidates/${candidate.id}/code-patch-approval`, reviewerToken, { approved: true, expectedCodePatchHash: patchHash });
  assert.equal(approval.status, 201);
  assert.equal(approval.body.status, "approved_for_execution_review");
  assert.equal(approval.body.codePatchHash, patchHash);
  assert.equal(approval.body.executionGranted, false);
  assert.equal(run.codePatchApproval.executionGranted, false);
  const repeatedApproval = await request(server, "POST", `/candidates/${candidate.id}/code-patch-approval`, reviewerToken, { approved: true, expectedCodePatchHash: patchHash });
  assert.equal(repeatedApproval.status, 200);
  assert.equal(repeatedApproval.body.codePatchHash, patchHash);
  assert.equal(store.audit.filter((event) => event.type === "code-patch.approved").length, 1);

  const l2Token = "c".repeat(32);
  const executionServer = createServer(
    store,
    { apiToken, reviewerToken, reviewerId: "reviewer", l2Token },
    undefined,
    undefined,
    null,
    null,
    null,
    { worktreeRoot },
  );
  const grant = await request(executionServer, "POST", `/runs/${run.id}/grants`, reviewerToken, { tool: "apply_code_patch", candidateId: candidate.id, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(grant.status, 201);
  const unauthorizedExecution = await request(executionServer, "POST", `/candidates/${candidate.id}/code-patch-execution`, apiToken, { grantId: grant.body.id });
  assert.equal(unauthorizedExecution.status, 401);
  const executed = await request(executionServer, "POST", `/candidates/${candidate.id}/code-patch-execution`, l2Token, { grantId: grant.body.id });
  assert.equal(executed.status, 201);
  assert.notEqual(executed.body.candidate.id, candidate.id);
  assert.equal(executed.body.candidate.parentId, candidate.id);
  assert.equal(executed.body.candidate.build.passed, true);
  assert.equal(executed.body.candidate.contentModel.contentHash.length, 64);
  assert.equal(executed.body.execution.patchHash, patchHash);
  assert.equal(candidate.status, "superseded");
  assert.equal(run.checkpoint, "content_review_required");
  assert.equal(await fs.readFile(path.join(workspace, sourcePath), "utf8"), sourceContent);
  assert.equal(await fs.readFile(path.join(executed.body.candidate.codeArtifact.workspace, sourcePath), "utf8"), "export default function Page() { return <main data-sitepilot-page=\"home\">Updated page</main>; }\n");
  assert.equal(store.audit.some((event) => event.type === "code-patch.executed"), true);
});
