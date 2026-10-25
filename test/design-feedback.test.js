import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { SitePilotStore } from "../src/core.js";
import { createServer } from "../src/server.js";
import { parseDesignFeedback } from "../src/design-feedback.js";

const apiToken = "d".repeat(32);
const reviewerToken = "r".repeat(32);

function request(server, method, url, body, token = apiToken) {
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

function fixture() {
  const store = new SitePilotStore();
  const project = store.createProject({ goal: "建立产品官网", industry: "industrial", locale: ["zh-CN"] });
  const run = store.createRun(project.id);
  run.pagePlan = { routes: [{
    page: "home",
    route: "/",
    components: [{ name: "Hero", registryId: "hero", source: { repository: "fixture", commit: "a".repeat(40), path: "src/Hero.tsx" } }],
  }] };
  const design = store.createDesignDraft(run.id);
  return { store, run, design };
}

test("natural-language design feedback maps only supported copy and token changes", () => {
  const { design } = fixture();
  const page = design.pageTree[0];
  const component = page.components[0];
  const parsed = parseDesignFeedback({
    feedback: "主标题改为“精密设备，稳定交付”，主色改为 #0b6e4f",
    page,
    component,
    designDraft: design,
  });
  assert.deepEqual(parsed.operations, [
    { op: "set_props", page: "home", componentId: component.instanceId, props: { title: "精密设备，稳定交付" } },
    { op: "set_tokens", tokens: { color: { primary: "#0b6e4f" } } },
  ]);
});

test("natural-language design feedback rejects unsupported and viewport-specific changes", () => {
  const { design } = fixture();
  const page = design.pageTree[0];
  const component = page.components[0];
  assert.throws(() => parseDesignFeedback({ feedback: "把页面做得更有科技感", page, component, designDraft: design }), { code: "FEEDBACK_NOT_ACTIONABLE" });
  assert.throws(() => parseDesignFeedback({ feedback: "手机端留白少一点", page, component, designDraft: design }), { code: "FEEDBACK_NOT_ACTIONABLE" });
  assert.throws(() => parseDesignFeedback({ feedback: "x".repeat(2001), page, component, designDraft: design }), { code: "FEEDBACK_TOO_LONG" });
});

test("Studio feedback API creates a versioned CanvasPatch and rejects stale or unsupported feedback", async () => {
  const { store, run, design } = fixture();
  const server = createServer(store, { apiToken, reviewerToken, reviewerId: "reviewer" });
  const base = `/design-drafts/${design.id}/feedback`;
  const created = await request(server, "POST", base, {
    expectedDesignHash: design.designHash,
    page: "home",
    componentId: design.pageTree[0].components[0].instanceId,
    feedback: "主标题改为“可靠运行，稳定生产”",
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.draft.parentId, design.id);
  assert.equal(created.body.draft.pageTree[0].components[0].props.title, "可靠运行，稳定生产");
  assert.equal(created.body.patch.actor, "customer");
  assert.deepEqual(run.designDraftId, created.body.draft.id);

  const stale = await request(server, "POST", base, {
    expectedDesignHash: design.designHash,
    page: "home",
    componentId: design.pageTree[0].components[0].instanceId,
    feedback: "主标题改为“旧版本”",
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "STALE_REVISION");

  const unsupported = await request(server, "POST", `/design-drafts/${created.body.draft.id}/feedback`, {
    expectedDesignHash: created.body.draft.designHash,
    page: "home",
    componentId: created.body.draft.pageTree[0].components[0].instanceId,
    feedback: "把页面做得更有科技感",
  });
  assert.equal(unsupported.status, 422);
  assert.equal(unsupported.body.code, "FEEDBACK_NOT_ACTIONABLE");
});

test("design token patch changes the child hash and validates token groups", () => {
  const { store, design } = fixture();
  const result = store.applyDesignPatch(design.id, {
    expectedDesignHash: design.designHash,
    operations: [{ op: "set_tokens", tokens: { color: { primary: "#0b6e4f" }, spacing: { section: 80 } } }],
  });
  assert.equal(result.draft.designTokens.color.primary, "#0b6e4f");
  assert.equal(result.draft.designTokens.spacing.section, 80);
  assert.notEqual(result.draft.designHash, design.designHash);
  assert.throws(() => store.applyDesignPatch(result.draft.id, {
    expectedDesignHash: result.draft.designHash,
    operations: [{ op: "set_tokens", tokens: { typography: { heading: "unsafe" } } }],
  }), { code: "SCHEMA_REJECTED" });
});
