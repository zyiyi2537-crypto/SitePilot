import test from "node:test";
import assert from "node:assert/strict";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { SitePilotAgentRuntime } from "../src/agent-runtime.js";
import { runCreationSupervisor } from "../src/agent-supervisor.js";
import { createPiTool } from "../src/agent-tools.js";
import { SitePilotStore, PolicyError } from "../src/core.js";
import { ToolRuntime } from "../src/tool-runtime.js";

const COMMIT = "a".repeat(40);

function fakeRuntime(store, responses) {
  const faux = fauxProvider({ models: [{ id: "test-model" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  return new SitePilotAgentRuntime({
    store,
    modelRuntime: {
      model: faux.getModel(),
      streamFn: (model, context, options) => models.streamSimple(model, context, options),
    },
  });
}

function projectRun(store) {
  const project = store.createProject({ goal: "做一个中英文工业设备官网，支持产品询盘", industry: "industrial", locale: ["zh-CN", "en"] });
  return store.createRun(project.id, { repositoryAllowlist: ["payload-template"] });
}

test("Pi Supervisor dynamically delegates Architect then Research and persists artifacts", async () => {
  const store = new SitePilotStore();
  const run = projectRun(store);
  const strategy = {
    audience: "采购经理",
    businessGoal: "获取技术询盘",
    primaryConversion: "询盘",
    pageHierarchy: ["home", "products", "contact"],
    blocks: ["Hero", "ProductGrid", "ContactForm"],
    locales: ["zh-CN", "en"],
    designDirection: "清晰、技术可信",
    openQuestions: [],
    evidenceRefs: [],
    qaChecks: ["form", "locale-links"],
    tradeoffs: [],
  };
  const componentPlan = {
    summary: "复用已固定来源的 Hero 组件",
    decisions: [{ component: "Hero", recommendation: "reuse", evidenceIds: ["evidence_hero"], reason: "许可证和版本已确认" }],
  };
  const runtime = fakeRuntime(store, [
    fauxAssistantMessage(fauxToolCall("delegate_architect", { whyNow: "需要先确定客户的官网策略", expectedObservation: "得到可交接的页面和组件计划", stopIf: ["客户目标冲突"], risk: "low" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("submit_site_strategy", strategy), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("delegate_research", { repository: "payload-template", expectedCommit: COMMIT, whyNow: "已得到策略，需要核对可复用组件", expectedObservation: "确认固定提交中哪些组件可用", stopIf: ["commit 证据不匹配"], risk: "low" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("retrieve_codeatlas", { query: "hero section component", repository: "payload-template", expectedCommit: COMMIT, topK: 1, whyNow: "Hero 是首页首屏核心区块", expectedObservation: "返回带固定提交和路径的组件证据", stopIf: ["返回版本不是固定 commit"], risk: "low" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("submit_component_plan", componentPlan), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("complete_plan", { summary: "策略与组件研究已完成", whyNow: "所需策略和组件证据均已生成", expectedObservation: "交付可进入设计草稿阶段", stopIf: ["artifact 版本不一致"], risk: "low" }), { stopReason: "toolUse" }),
  ]);
  const toolRuntime = new ToolRuntime({ store, handlers: {} });
  const result = await runCreationSupervisor({
    run,
    runtime,
    store,
    toolRuntime,
    repository: "payload-template",
    expectedCommit: COMMIT,
    codeAtlas: { search: async () => [{ repository: "payload-template", commit: COMMIT, path: "src/blocks/Hero.tsx", locator: { startLine: 1, endLine: 10 }, evidenceId: "evidence_hero" }] },
  });
  assert.equal(result.status, "ready_for_design");
  assert.equal(result.artifacts.length, 2);
  assert.deepEqual(result.artifacts.map((item) => item.type), ["SiteStrategy", "ComponentPlan"]);
  assert.equal(run.checkpoint, "agent_strategy_research_ready");
  assert.equal(run.agentState.decisions.length, 3);
  assert.ok(store.audit.some((event) => event.type === "agent.tool.requested"));
  assert.ok(store.audit.some((event) => event.type === "supervisor.completed"));
});

test("Pi Supervisor stops for CodeAtlas source input when no frozen source is supplied", async () => {
  const store = new SitePilotStore();
  const run = projectRun(store);
  const strategy = {
    audience: "海外采购商",
    businessGoal: "展示产品并收集询盘",
    primaryConversion: "询盘",
    pageHierarchy: ["home", "products", "contact"],
    blocks: ["Hero", "ProductGrid", "ContactForm"],
    locales: ["zh-CN", "en"],
    designDirection: "结构清晰、突出产品参数",
    openQuestions: [],
    evidenceRefs: [],
    qaChecks: ["form", "locale-links"],
    tradeoffs: [],
  };
  const runtime = fakeRuntime(store, [
    fauxAssistantMessage(fauxToolCall("delegate_architect", { whyNow: "需要形成可评审的策略草稿", expectedObservation: "得到页面层级和区块选择", stopIf: ["核心目标冲突"], risk: "low" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("submit_site_strategy", strategy), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("request_customer_input", { questions: [{ field: "codeAtlasSource", question: "请选择 CodeAtlas 仓库和固定 commit。", reason: "检索必须绑定固定来源。" }], whyNow: "缺少允许检索的代码来源", expectedObservation: "获得仓库 ID 和完整 commit", stopIf: ["仓库不在白名单中"], risk: "low" }), { stopReason: "toolUse" }),
  ]);
  const result = await runCreationSupervisor({ run, runtime, store, toolRuntime: new ToolRuntime({ store }), codeAtlas: null });
  assert.equal(result.status, "needs_input");
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].type, "SiteStrategy");
  assert.equal(run.checkpoint, "agent_needs_input");
  assert.equal(result.questions[0].field, "codeAtlasSource");
});

test("role tool policy rejects a tool outside the role allowlist", () => {
  const store = new SitePilotStore();
  assert.throws(() => createPiTool({
    role: "Architect",
    name: "retrieve_codeatlas",
    runContext: { runId: "run_1", agentRunId: "agent_1", inputSnapshotId: "snapshot_1", grant: { level: "L0" } },
    toolRuntime: new ToolRuntime({ store, handlers: {} }),
    handler: async () => ({}),
  }), (error) => error instanceof PolicyError && error.code === "POLICY_DENIED");
});
