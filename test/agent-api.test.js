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
