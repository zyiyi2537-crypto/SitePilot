import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import fs from "node:fs/promises";

import { SitePilotStore } from "../src/core.js";
import { createServer } from "../src/server.js";
import { BuildExecutor, DockerSandboxRunner } from "../src/build-executor.js";
import { LocalPreviewServer } from "../src/preview-server.js";
import { validateGeneratedCandidate } from "../src/local-build.js";
import { FixtureCodeAtlasTransport, CodeAtlasMcpAdapter } from "../src/codeatlas.js";
import { BlockRegistry } from "../src/registry.js";

function request(server, method, url, token, body) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    req.method = method;
    req.url = url;
    req.headers = token ? { authorization: `Bearer ${token}` } : {};
    const res = {
      writeHead(status) { this.status = status; },
      end(text) { resolve({ status: this.status, body: JSON.parse(text) }); },
    };
    server.emit("request", req, res);
    req.on("error", reject);
  });
}

test("HTTP API rejects anonymous writes and exposes no quality decision route", async () => {
  const store = new SitePilotStore();
  const server = createServer(store, { apiToken: "a".repeat(32), reviewerToken: "b".repeat(32), reviewerId: "reviewer-1" });
  const anonymous = await request(server, "POST", "/projects", null, { goal: "test" });
  assert.equal(anonymous.status, 401);
  const quality = await request(server, "POST", "/candidates/fake/quality", "a".repeat(32), { passed: true });
  assert.equal(quality.status, 404);
  assert.equal(store.candidates.size, 0);
});

test("review requires separate credential and uses server-side reviewer identity", async () => {
  const store = new SitePilotStore();
  const project = store.createProject({ goal: "test" });
  const run = store.createRun(project.id);
  const candidate = store.createCandidate(run.id, {});
  store.markQuality(candidate.id, { passed: true });
  const server = createServer(store, { apiToken: "a".repeat(32), reviewerToken: "b".repeat(32), reviewerId: "reviewer-1" });
  const route = `/candidates/${candidate.id}/review`;
  assert.equal((await request(server, "POST", route, "a".repeat(32), { approved: true })).status, 401);
  assert.equal((await request(server, "POST", route, "b".repeat(32), { approved: false })).status, 422);
  const approved = await request(server, "POST", route, "b".repeat(32), { approved: true, approvedByReviewer: "attacker" });
  assert.equal(approved.status, 201);
  assert.equal(approved.body.review.approvedByReviewer, "reviewer-1");
});

test("component registry review requires reviewer credential and evidence", async () => {
  const store = new SitePilotStore();
  const token = "a".repeat(32);
  const reviewer = "b".repeat(32);
  const server = createServer(store, { apiToken: token, reviewerToken: reviewer, reviewerId: "reviewer-1" });
  const commit = "a".repeat(40);
  const created = await request(server, "POST", "/components", token, { name: "Hero", kind: "hero", repository: "payload", commit, path: "src/Hero.tsx", license: "MIT" });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal((await request(server, "POST", `/components/${id}/review`, token, { approved: true, licenseVerified: true, testsPassed: true })).status, 401);
  assert.equal((await request(server, "POST", `/components/${id}/review`, reviewer, { approved: true, licenseVerified: true, testsPassed: false })).status, 422);
  const approved = await request(server, "POST", `/components/${id}/review`, reviewer, { approved: true, licenseVerified: true, testsPassed: true, reviewerId: "attacker" });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.state, "approved");
  assert.equal(approved.body.review.reviewerId, "reviewer-1");
});

test("run research uses server-side CodeAtlas adapter and freezes requested commit", async () => {
  const store = new SitePilotStore();
  const token = "a".repeat(32);
  const commit = "c".repeat(40);
  const codeAtlas = new CodeAtlasMcpAdapter({ repositories: ["payload"], transport: new FixtureCodeAtlasTransport({
    search_code: () => [{ repository: "payload", commit, path: "src/Hero.tsx", license_reference: "MIT" }],
  }) });
  const server = createServer(store, { apiToken: token, reviewerToken: "b".repeat(32), reviewerId: "reviewer-1" }, undefined, undefined, codeAtlas);
  const project = store.createProject({ goal: "website", industry: "general", audience: "buyers", primaryConversion: "contact", brandConstraints: ["logo"], contentAvailable: ["copy"] });
  const run = store.createRun(project.id);
  run.strategy = { locales: ["en"], pageHierarchy: ["home"], blocks: ["Hero"] };
  const response = await request(server, "POST", `/runs/${run.id}/research`, token, { repository: "payload", expectedCommit: commit });
  assert.equal(response.status, 200);
  assert.equal(response.body.componentPlan.requiresReview, true);
  assert.equal(store.runs.get(run.id).checkpoint, "components_pending_review");
});

test("page plan endpoint only returns plans after registry approval", async () => {
  const store = new SitePilotStore();
  const token = "a".repeat(32);
  const registry = new BlockRegistry();
  const server = createServer(store, { apiToken: token, reviewerToken: "b".repeat(32), reviewerId: "reviewer-1" }, undefined, registry);
  const project = store.createProject({ goal: "website", audience: "buyers", primaryConversion: "contact", brandConstraints: ["logo"], contentAvailable: ["copy"] });
  const run = store.createRun(project.id);
  run.strategy = { locales: ["en"], pageHierarchy: ["home"], blocks: ["Hero"] };
  assert.equal((await request(server, "POST", `/runs/${run.id}/page-plan`, token, {})).status, 400);
  const block = registry.register({ name: "Hero", kind: "hero", repository: "payload", commit: "a".repeat(40), path: "src/Hero.tsx", license: "MIT", supportedLocales: ["en"] });
  registry.transition(block.id, "approved", { reviewerId: "reviewer", licenseVerified: true, testsPassed: true });
  const planned = await request(server, "POST", `/runs/${run.id}/page-plan`, token, {});
  assert.equal(planned.status, 200);
  assert.equal(planned.body.writesAllowed, false);
});

test("Payload API only creates sandbox drafts after quality gates", async () => {
  const store = new SitePilotStore();
  const token = "a".repeat(32);
  const calls = [];
  const payload = { createDraft: async (input) => { calls.push(input); return { candidateId: input.candidateId, cmsSnapshotId: "payload_1", status: "sandbox_draft" }; } };
  const server = createServer(store, { apiToken: token, reviewerToken: "b".repeat(32), reviewerId: "reviewer-1" }, undefined, undefined, null, payload);
  const project = store.createProject({ goal: "website" });
  const run = store.createRun(project.id);
  const candidate = store.createCandidate(run.id, {});
  assert.equal((await request(server, "POST", `/candidates/${candidate.id}/payload-draft`, token, { expectedCmsSnapshot: "cms_0", idempotencyKey: "k", pageOperations: [] })).status, 422);
  store.markQuality(candidate.id, { passed: true });
  const result = await request(server, "POST", `/candidates/${candidate.id}/payload-draft`, token, { expectedCmsSnapshot: "cms_0", idempotencyKey: "k", pageOperations: [] });
  assert.equal(result.status, 201);
  assert.equal(calls[0].environment, "sandbox");
});

test("evidence API records sources, citations and claims under the project", async () => {
  const store = new SitePilotStore();
  const project = store.createProject({ goal: "evidence" });
  const token = "a".repeat(32);
  const server = createServer(store, { apiToken: token, reviewerToken: "b".repeat(32), reviewerId: "reviewer-1" });
  const source = await request(server, "POST", `/projects/${project.id}/sources`, token, { kind: "client", name: "facts.md", content: "Founded in 2020", version: "1" });
  assert.equal(source.status, 201);
  const record = await request(server, "POST", `/sources/${source.body.id}/records`, token, { locator: "line:1", quote: "Founded in 2020" });
  assert.equal(record.status, 201);
  const claim = await request(server, "POST", `/projects/${project.id}/claims`, token, { statement: "The company was founded in 2020", evidenceIds: [record.body.id] });
  assert.equal(claim.status, 201);
  assert.equal(claim.body.status, "proposed");
});

test("run creation returns a bounded Payload schema plan", async () => {
  const store = new SitePilotStore();
  const project = store.createProject({ goal: "industrial website", industry: "industrial" });
  const token = "a".repeat(32);
  const server = createServer(store, { apiToken: token, reviewerToken: "b".repeat(32), reviewerId: "reviewer-1" });
  const response = await request(server, "POST", `/projects/${project.id}/runs`, token, {});
  assert.equal(response.status, 201);
  assert.equal(response.body.payloadSchema.rules.publishAllowed, false);
  assert.ok(response.body.payloadSchema.collections.some((item) => item.name === "products"));
});

test("strategy answers return a new run instead of mutating history", async () => {
  const store = new SitePilotStore();
  const project = store.createProject({ goal: "website" });
  const first = store.createRun(project.id);
  const token = "a".repeat(32);
  const server = createServer(store, { apiToken: token, reviewerToken: "b".repeat(32), reviewerId: "reviewer-1" });
  const response = await request(server, "POST", `/runs/${first.id}/answers`, token, {
    audience: "buyers", primaryConversion: "contact sales", brandConstraints: ["logo"], contentAvailable: ["catalog"],
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.revisedFromRunId, first.id);
  assert.equal(response.body.strategy.openQuestions.length, 0);
  assert.equal(store.runs.get(first.id).status, "superseded");
});

test("Docker sandbox command has enforced network, filesystem and user isolation", async () => {
  let invocation;
  const sandbox = new DockerSandboxRunner({
    image: `node@sha256:${"a".repeat(64)}`,
    runner: async (command, args) => { invocation = { command, args }; return { stdout: "ok" }; },
  });
  await sandbox.run("node", ["--version"], { cwd: "/tmp/sitepilot-worktree-fixture", timeout: 1000, maxBuffer: 1024 });
  assert.equal(invocation.command, "docker");
  assert.deepEqual(invocation.args.slice(0, 6), ["run", "--rm", "--network", "none", "--read-only", "--cap-drop"]);
  assert.ok(invocation.args.includes("--user"));
  assert.ok(invocation.args.includes("no-new-privileges"));
  assert.ok(invocation.args.includes("--pids-limit"));
  assert.ok(invocation.args.includes("--memory"));
});

test("API refuses configuration with weak or shared credentials", async () => {
  const server = createServer(new SitePilotStore(), { apiToken: "short", reviewerToken: "short", reviewerId: "reviewer-1" });
  assert.equal((await request(server, "POST", "/projects", "short", { goal: "x" })).status, 503);
});

test("local preview is localhost-only and read-only", () => {
  const plan = { routes: [{ page: "home", route: "/", components: [{ name: "Hero", source: { repository: "payload", commit: "a".repeat(40), path: "src/Hero.tsx" } }] }] };
  const preview = new LocalPreviewServer({ plan });
  assert.equal(preview.host, "127.0.0.1");
  assert.equal(preview.plan.routes[0].components[0].source.commit.length, 40);
  assert.throws(() => new LocalPreviewServer({ plan, host: "0.0.0.0" }), /localhost/);
});

test("local build gate validates generated manifest and page files", async () => {
  const root = "/tmp/sitepilot-local-build-gate";
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(`${root}/src/generated`, { recursive: true });
  await fs.mkdir(`${root}/src/app/(site)/home`, { recursive: true });
  const routes = [{ page: "home", route: "/", file: "src/app/(site)/home/page.tsx", components: [] }];
  const crypto = await import("node:crypto");
  const sourceManifestHash = crypto.createHash("sha256").update(JSON.stringify(routes)).digest("hex");
  await fs.writeFile(`${root}/src/generated/sitepilot-manifest.json`, JSON.stringify({ routes, sourceManifestHash }));
  await fs.writeFile(`${root}/src/app/(site)/home/page.tsx`, '<main data-sitepilot-page="home" />');
  const result = await validateGeneratedCandidate({ worktreeRoot: root });
  assert.equal(result.passed, true);
  assert.equal(result.routeCount, 1);
  await fs.rm(root, { recursive: true, force: true });
});

test("build refuses worktree symlink escaping its configured root", async () => {
  const root = await fs.mkdtemp("/tmp/sitepilot-sandbox-root-");
  const outside = await fs.mkdtemp("/tmp/sitepilot-sandbox-outside-");
  await fs.symlink(outside, `${root}/linked`);
  let called = false;
  const sandbox = new DockerSandboxRunner({ image: `node@sha256:${"a".repeat(64)}`, runner: async () => { called = true; return { stdout: "" }; } });
  const executor = new BuildExecutor({ worktreeRoot: root, approvedScripts: { check: { command: "node", args: ["--check", "app.js"] } }, sandbox });
  await assert.rejects(() => executor.run({ candidateId: "candidate_1", worktreePath: "linked", commit: "a".repeat(40), approvedScriptIds: ["check"], grant: { level: "L2" } }), /outside configured root/);
  assert.equal(called, false);
});
