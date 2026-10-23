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
