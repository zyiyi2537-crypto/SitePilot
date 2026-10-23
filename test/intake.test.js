import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { createServer } from "../src/server.js";
import { SitePilotStore } from "../src/core.js";
import { createOpenAICompatibleIntakeAdapter, normalizeRequirementBrief } from "../src/intake.js";

const apiToken = "a".repeat(32);
const reviewerToken = "b".repeat(32);

function request(server, method, url, token, body) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    req.method = method;
    req.url = url;
    req.headers = token ? { authorization: "Bearer " + token } : {};
    const res = {
      writeHead(status) { this.status = status; },
      end(value) { resolve({ status: this.status, body: JSON.parse(value) }); },
    };
    server.emit("request", req, res);
    req.on("error", reject);
  });
}

function validBrief() {
  return {
    summary: "面向海外采购商的工业官网，提供中英文产品分类和询盘。",
    industry: "industrial",
    audience: { value: "海外采购商", quote: "面向海外采购商" },
    primaryConversion: { value: "询盘", quote: "询盘" },
    locales: [{ value: "zh-CN", quote: "中英文" }, { value: "en", quote: "中英文" }],
    brandConstraints: [],
    contentAvailable: [],
    requestedFeatures: [{ value: "产品分类", quote: "产品分类" }, { value: "询盘", quote: "询盘" }],
    recommendedPages: ["首页", "产品目录", "联系页面"],
    designSuggestions: ["突出产品分类入口"],
    assumptions: ["品牌颜色尚未确定"],
    openQuestions: [{ field: "brandConstraints", question: "是否有品牌规范？", reason: "确认视觉方向" }],
  };
}

test("RequirementBrief only promotes extracted facts with exact source quotes", () => {
  const requestText = "面向海外采购商做中英文工业设备官网，需要产品分类和询盘";
  const normalized = normalizeRequirementBrief(validBrief(), requestText);
  assert.equal(normalized.audience.value, "海外采购商");
  assert.equal(normalized.locales.length, 2);
  const repaired = normalizeRequirementBrief({ ...validBrief(), locales: [{ value: "zh-CN", quote: "Chinese and English" }, { value: "en", quote: "Chinese and English" }] }, requestText);
  assert.equal(repaired.locales[0].quote, "中英文");
  assert.throws(() => normalizeRequirementBrief({
    ...validBrief(),
    audience: { value: "工程师", quote: "工程师" },
  }, requestText), { code: "INTAKE_EVIDENCE_INVALID" });
  assert.throws(() => normalizeRequirementBrief({
    ...validBrief(),
    openQuestions: Array.from({ length: 4 }, () => ({ field: "locale", question: "语言？" })),
  }, requestText), { code: "INTAKE_INVALID" });
});

test("OpenAI-compatible intake adapter sends a structured request and validates provider output", async () => {
  let call;
  const adapter = createOpenAICompatibleIntakeAdapter({
    baseUrl: "https://model.example/v1",
    apiKey: "secret-for-test",
    model: "test-model",
    fetchImpl: async (url, init) => {
      call = { url, init };
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(validBrief()) } }] }),
      };
    },
  });
  const result = await adapter.analyze("面向海外采购商做中英文工业设备官网，需要产品分类和询盘");
  assert.equal(call.url, "https://model.example/v1/chat/completions");
  assert.equal(call.init.headers.authorization, "Bearer secret-for-test");
  assert.equal(result.industry, "industrial");
  assert.ok(call.init.body.includes("Return only a JSON object"));
});

test("Responses-compatible intake supports Pi/Codex protocol and connection tests", async () => {
  const calls = [];
  const adapter = createOpenAICompatibleIntakeAdapter({
    baseUrl: "https://model.example/v1",
    apiKey: "secret-for-test",
    model: "test-model",
    apiMode: "codex_responses",
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      const output_text = calls.length === 1 ? "SITEPILOT_MODEL_OK" : JSON.stringify(validBrief());
      return { ok: true, json: async () => ({ model: "test-model", output_text }) };
    },
  });
  assert.deepEqual(await adapter.testConnection(), { modelVersion: "test-model", apiMode: "codex_responses" });
  const result = await adapter.analyze("面向海外采购商做中英文工业设备官网，需要产品分类和询盘");
  assert.equal(result.industry, "industrial");
  assert.equal(calls[0].url, "https://model.example/v1/responses");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].body.text, undefined);
  assert.deepEqual(calls[1].body.text.format, { type: "json_object" });
  assert.equal(calls[1].body.messages, undefined);
});

test("Studio model config is authenticated, in-memory, and never returns the API key", async () => {
  const factoryCalls = [];
  const modelFactory = (config) => {
    factoryCalls.push(config);
    return {
      modelVersion: config.model,
      endpoint: config.baseUrl,
      apiMode: config.apiMode,
      testConnection: async () => ({ modelVersion: config.model }),
      analyze: async () => validBrief(),
    };
  };
  const store = new SitePilotStore();
  const server = createServer(store, { apiToken, reviewerToken, reviewerId: "reviewer-1" }, undefined, undefined, null, null, null, null, undefined, null, null, modelFactory);
  const statusBefore = await request(server, "GET", "/model/status", apiToken);
  assert.equal(statusBefore.status, 200);
  assert.equal(statusBefore.body.configured, false);
  assert.equal((await request(server, "GET", "/model/status", "wrong")).status, 401);

  const config = { baseUrl: "https://model.example/v1", model: "test-model", apiMode: "codex_responses", apiKey: "test-key-that-must-not-leak" };
  const tested = await request(server, "POST", "/model/test", apiToken, config);
  assert.equal(tested.status, 200);
  assert.equal(tested.body.ok, true);
  assert.equal(JSON.stringify(tested.body).includes(config.apiKey), false);
  const applied = await request(server, "POST", "/model/config", apiToken, config);
  assert.equal(applied.body.persisted, false);
  assert.equal(JSON.stringify(applied.body).includes(config.apiKey), false);
  const statusAfter = await request(server, "GET", "/model/status", apiToken);
  assert.deepEqual(statusAfter.body, { configured: true, model: config.model, baseUrl: config.baseUrl, apiMode: config.apiMode, keyConfigured: true, source: "studio-memory" });

  const preview = await request(server, "POST", "/intake/preview", apiToken, { requestText: "面向海外采购商做中英文工业设备官网，需要产品分类和询盘" });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(factoryCalls.at(-1).apiKey, config.apiKey);
  const cleared = await request(server, "POST", "/model/config", apiToken, { clear: true });
  assert.equal(cleared.body.configured, false);
  assert.equal((await request(server, "GET", "/model/status", apiToken)).body.configured, false);
});

test("intake preview creates no project until explicit confirmation", async () => {
  const store = new SitePilotStore();
  const intake = { modelVersion: "test-model", analyze: async () => validBrief() };
  const server = createServer(
    store,
    { apiToken, reviewerToken, reviewerId: "reviewer-1" },
    undefined,
    undefined,
    null,
    null,
    null,
    null,
    undefined,
    null,
    intake,
  );

  const preview = await request(server, "POST", "/intake/preview", apiToken, {
    requestText: "面向海外采购商做中英文工业设备官网，需要产品分类和询盘",
  });
  assert.equal(preview.status, 200);
  assert.equal(store.projects.size, 0);

  const confirmed = await request(server, "POST", "/intake/confirm", apiToken, {
    intakeId: preview.body.intakeId,
    supplemental: { brandConstraints: ["蓝色品牌色"] },
  });
  assert.equal(confirmed.status, 201);
  assert.equal(store.projects.size, 1);
  assert.equal(confirmed.body.project.goal, "面向海外采购商做中英文工业设备官网，需要产品分类和询盘");
  assert.equal(confirmed.body.project.requirementBrief.summary, validBrief().summary);
  assert.equal(confirmed.body.run.inputSnapshot.modelVersion, "test-model");
  assert.equal(confirmed.body.run.strategy.strategy, "industrial-leadgen");
  assert.equal(confirmed.body.run.strategy.openQuestions.some((item) => item.field === "brandConstraints"), false);

  const replay = await request(server, "POST", "/intake/confirm", apiToken, { intakeId: preview.body.intakeId });
  assert.equal(replay.status, 404);
  assert.equal(store.projects.size, 1);
});

test("intake fails closed without model configuration and requires API authorization", async () => {
  const store = new SitePilotStore();
  const server = createServer(store, { apiToken, reviewerToken, reviewerId: "reviewer-1" });
  assert.equal((await request(server, "POST", "/intake/preview", apiToken, { requestText: "Build a site" })).status, 503);
  assert.equal((await request(server, "POST", "/intake/preview", "wrong", { requestText: "Build a site" })).status, 401);
  assert.equal(store.projects.size, 0);
});
