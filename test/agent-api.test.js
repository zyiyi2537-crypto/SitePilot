import test from "node:test";
import assert from "node:assert/strict";
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
});
