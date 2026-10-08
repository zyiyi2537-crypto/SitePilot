import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { SitePilotStore, WorktreePolicy, PolicyError, assertTool, planStrategy } from "../src/core.js";
import { CodeAtlasMcpAdapter, FixtureCodeAtlasTransport, JsonRpcMcpTransport } from "../src/codeatlas.js";
import { PinnedSourceFetcher } from "../src/source-fetcher.js";
import { SourcePackageInspector } from "../src/source-inspector.js";
import { ProjectWorktreeManager } from "../src/worktree.js";
import { BuildExecutor, DockerSandboxRunner, LockedDependencyInstaller } from "../src/build-executor.js";
import { PayloadHttpSandboxBackend, PayloadSandboxAdapter } from "../src/payload-adapter.js";
import { QualityAdapter } from "../src/quality-adapter.js";
import { JsonSitePilotStore } from "../src/persistence.js";
import { DeliveryOrchestrator } from "../src/orchestrator.js";
import { BlockRegistry } from "../src/registry.js";
import { JsonToolJournal, ToolRuntime } from "../src/tool-runtime.js";
import { EvidenceStore } from "../src/evidence.js";
import { buildIndustrialSlice } from "../src/vertical-slice.js";
import fsSync from "node:fs";
import { TemplateSnapshotVerifier } from "../src/template-verifier.js";
import { createPinnedSourceFetcher, PINNED_SOURCES } from "../src/pinned-sources.js";
import { planPayloadSchema } from "../src/payload-schema.js";

test("strategy changes by industry", () => {
  const industrial = planStrategy({ industry: "industrial", locale: ["zh-CN", "en"] });
  const saas = planStrategy({ industry: "saas", locale: ["en"] });
  assert.notEqual(industrial.strategy, saas.strategy);
  assert.ok(industrial.blocks.includes("ProductGrid"));
  assert.ok(saas.blocks.includes("Pricing"));
});

test("strategy asks for missing customer inputs", () => {
  const strategy = planStrategy({ industry: "general", locale: ["zh-CN"] });
  assert.equal(strategy.openQuestions.length, 3);
  assert.equal(strategy.openQuestions[0].field, "audience");
  const complete = planStrategy({
    industry: "saas",
    locale: ["en"],
    audience: "engineering teams",
    primaryConversion: "book a demo",
    brandConstraints: ["use existing logo"],
    contentAvailable: ["product docs"],
  });
  assert.deepEqual(complete.openQuestions, []);
  assert.equal(complete.primaryConversion, "book a demo");
});

test("candidate cannot become draft before quality and review", () => {
  const store = new SitePilotStore();
  const project = store.createProject({ goal: "test", industry: "general" });
  const run = store.createRun(project.id);
  const candidate = store.createCandidate(run.id, { codeArtifact: { head: "a" } });
  assert.throws(() => store.packageReview(candidate.id, { approvedByReviewer: "x" }), /quality gates/);
  store.markQuality(candidate.id, { passed: true });
  assert.throws(() => store.packageReview(candidate.id, {}), /Review decision/);
  const draft = store.packageReview(candidate.id, { approvedByReviewer: "reviewer" });
  assert.equal(draft.status, "ready_for_review");
});

test("worktree policy blocks escape and sensitive files", async () => {
  const policy = new WorktreePolicy(path.resolve("/tmp/sitepilot-test-worktree"));
  assert.throws(() => policy.validateRelative("../outside"), PolicyError);
  assert.throws(() => policy.validateRelative(".env"), PolicyError);
});

test("L2 tools fail closed without a grant", () => {
  assert.throws(() => assertTool("apply_code_patch", "L2"), /L2 grant/);
  assert.equal(assertTool("apply_code_patch", "L2", { level: "L2" }).level, "L2");
});

test("CodeAtlas adapter normalizes pinned evidence and rejects stale revisions", async () => {
  const commit = "a".repeat(40);
  const adapter = new CodeAtlasMcpAdapter({
    repositories: ["startup-nextjs"],
    licenseReferences: { "startup-nextjs": "MIT: upstream LICENSE" },
    transport: new FixtureCodeAtlasTransport({
      search_code: () => [{ repo: "startup-nextjs", commit, path: "components/Hero.tsx", start_line: 4, end_line: 18 }],
      get_file: ({ repository, path, commit: requested }) => ({ repo: repository, commit: requested, path, start_line: 4, end_line: 18, content: "4: export function Hero() {}" }),
    }),
  });
  const [evidence] = await adapter.search({ query: "hero", repository: "startup-nextjs", expectedCommit: commit });
  assert.deepEqual(evidence.locator, { startLine: 4, endLine: 18 });
  assert.equal(evidence.licenseReference, "MIT: upstream LICENSE");
  await assert.rejects(() => adapter.search({ query: "hero", repository: "startup-nextjs", expectedCommit: "b".repeat(40) }), /frozen source commit/);
  await assert.rejects(() => adapter.search({ query: "hero", repository: "private", expectedCommit: commit }), /outside the allowlist/);
});

test("CodeAtlas adapter requires full commit SHA", async () => {
  const adapter = new CodeAtlasMcpAdapter({
    repositories: ["repo"],
    transport: new FixtureCodeAtlasTransport({ search_code: () => [] }),
  });
  await assert.rejects(() => adapter.search({ query: "x", repository: "repo", expectedCommit: "main" }), /full 40-character commit SHA/);
});

test("CodeAtlas adapter rejects an empty repository allowlist", async () => {
  const adapter = new CodeAtlasMcpAdapter({ transport: new FixtureCodeAtlasTransport({ search_code: () => [] }) });
  await assert.rejects(() => adapter.search({ query: "hero", repository: "unlisted", expectedCommit: "a".repeat(40) }), /outside the allowlist/);
});

test("CodeAtlas MCP transport handles event-first SSE and session header", async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(options);
    const payload = JSON.parse(options.body);
    const result = payload.method === "initialize"
      ? { protocolVersion: "2025-03-26" }
      : payload.method === "tools/call" ? { structuredContent: { result: [] }, content: [{ type: "text", text: "[]" }] } : undefined;
    return {
      ok: true,
      headers: { get: (name) => name === "content-type" ? "text/event-stream" : name === "mcp-session-id" ? "session-1" : null },
      text: async () => result === undefined ? "" : `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: payload.id, result })}\n\n`,
    };
  };
  const transport = new JsonRpcMcpTransport({ url: "https://example.com/mcp", token: "test", fetchImpl });
  assert.deepEqual(await transport.callTool("list_repositories", {}), []);
  assert.equal(calls[1].headers["mcp-session-id"], "session-1");
  assert.equal(calls[2].headers["mcp-session-id"], "session-1");
});

test("pinned source fetcher fails closed before any Git action", async () => {
  let calls = 0;
  const fetcher = new PinnedSourceFetcher({
    repositories: { payload: { url: "https://github.com/payloadcms/payload.git", commit: "a".repeat(40), includePaths: ["templates/website"] } },
    runner: async () => { calls += 1; return ""; },
  });
  await assert.rejects(() => fetcher.fetch({ repositoryId: "unknown", commitSha: "a".repeat(40), sourceEvidenceId: "evidence_1", grant: { level: "L2" } }), /not in the server-side source allowlist/);
  await assert.rejects(() => fetcher.fetch({ repositoryId: "payload", commitSha: "main", sourceEvidenceId: "evidence_1", grant: { level: "L2" } }), /full 40-character commit SHA/);
  await assert.rejects(() => fetcher.fetch({ repositoryId: "payload", commitSha: "a".repeat(40), sourceEvidenceId: "evidence_1" }), /requires an L2 grant/);
  await assert.rejects(() => fetcher.fetch({ repositoryId: "payload", commitSha: "a".repeat(40), sourceEvidenceId: "evidence_1", includePaths: ["packages"], grant: { level: "L2" } }), /differ from the server-locked source scope/);
  assert.equal(calls, 0);
});

test("source inspector records license, lockfile, scripts, and asset risks", async () => {
  const root = "/tmp/sitepilot-inspector-test";
  const snapshot = path.join(root, "source_fixture");
  const fs = await import("node:fs/promises");
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(snapshot, { recursive: true });
  await fs.writeFile(path.join(snapshot, "LICENSE.md"), "MIT\n");
  await fs.writeFile(path.join(snapshot, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  await fs.writeFile(path.join(snapshot, "package.json"), JSON.stringify({ dependencies: { next: "16.0.0" }, scripts: { build: "next build" } }));
  await fs.writeFile(path.join(snapshot, "hero.svg"), "<svg />\n");
  const result = await new SourcePackageInspector({ quarantineRoot: root }).inspect({ quarantineSnapshotId: "source_fixture" });
  assert.equal(result.licenseConclusion, "identified");
  assert.deepEqual(result.lockFiles, ["pnpm-lock.yaml"]);
  assert.deepEqual(result.assets, ["hero.svg"]);
  assert.ok(result.risks.includes("assets_require_file_level_attribution"));
  assert.equal(result.allowedToAdapt, true);
  await fs.rm(root, { recursive: true, force: true });
});

test("worktree manager rejects unregistered snapshots and non-L2 creation", async () => {
  const commit = "c".repeat(40);
  let calls = 0;
  const manager = new ProjectWorktreeManager({
    root: "/tmp/sitepilot-worktrees-test",
    snapshots: { [commit]: "/tmp/sitepilot-quarantine/source_payload" },
    runner: async () => { calls += 1; return { stdout: "" }; },
  });
  await assert.rejects(() => manager.create({ projectId: "p", runId: "r", templateCommit: commit }), /requires an L2 grant/);
  await assert.rejects(() => manager.create({ projectId: "p", runId: "r", templateCommit: "d".repeat(40), grant: { level: "L2" } }), /not registered/);
  assert.equal(calls, 0);
});

test("worktree manager sparse-checks out only registered Payload paths", async () => {
  const commit = "f".repeat(40);
  const calls = [];
  const manager = new ProjectWorktreeManager({
    root: "/tmp/sitepilot-sparse-worktrees",
    snapshots: { [commit]: { path: "/tmp/sitepilot-quarantine/source_payload", includePaths: ["templates/website", "LICENSE.md"], projectPath: "templates/website" } },
    runner: async (_command, args) => { calls.push(args); return { stdout: "" }; },
  });
  const result = await manager.create({ projectId: "project_1", runId: "run_1", templateCommit: commit, grant: { level: "L2" } });
  assert.match(result.pathRef, /templates[\\/]website$/);
  assert.equal(result.baseCommit, commit);
  assert.ok(calls.some((args) => args.includes("--no-checkout")));
  assert.ok(calls.some((args) => args.includes("sparse-checkout") && args.includes("templates/website")));
});

test("dependency and build adapters fail closed on unapproved execution", async () => {
  const commit = "e".repeat(40);
  const fs = await import("node:fs/promises");
  await fs.mkdir("/tmp/sitepilot-build-test/p/r/w", { recursive: true });
  await fs.writeFile("/tmp/sitepilot-build-test/p/r/w/pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  const dockerCalls = [];
  const sandbox = new DockerSandboxRunner({ image: `node@sha256:${"a".repeat(64)}`, runner: async (_command, args) => { dockerCalls.push(args); return { stdout: "ok", stderr: "" }; } });
  const installer = new LockedDependencyInstaller({ worktreeRoot: "/tmp/sitepilot-build-test", sandbox, approvedWorkspaceFilters: ["website..."] });
  await assert.rejects(() => installer.install({ worktreePath: "p/r/w", packageManager: "pnpm", lockHash: { file: "pnpm-lock.yaml" } }), /requires an L2 grant/);
  await assert.rejects(() => installer.install({ worktreePath: "p/r/w", packageManager: "pnpm", lockHash: { file: "pnpm-lock.yaml" }, workspaceFilter: "everything", grant: { level: "L2" } }), /not approved/);
  await installer.install({ worktreePath: "p/r/w", packageManager: "pnpm", lockHash: { file: "pnpm-lock.yaml" }, workspaceFilter: "website...", grant: { level: "L2" } });
  assert.ok(dockerCalls[0].some((arg, index) => arg === "--filter" && dockerCalls[0][index + 1] === "website..."));
  assert.throws(() => new BuildExecutor({ worktreeRoot: "/tmp/sitepilot-build-test" }), /Docker sandbox runner/);
  const executor = new BuildExecutor({ worktreeRoot: "/tmp/sitepilot-build-test", approvedScripts: { test: { command: "pnpm", args: ["test"] } }, sandbox });
  await assert.rejects(() => executor.run({ candidateId: "candidate_1", worktreePath: "p/r/w", commit, approvedScriptIds: ["shell"], grant: { level: "L2" } }), /not approved/);
  const result = await executor.run({ candidateId: "candidate_1", worktreePath: "p/r/w", commit, approvedScriptIds: ["test"], grant: { level: "L2" } });
  assert.equal(result.passed, true);
  assert.equal(result.commit, commit);
  assert.ok(dockerCalls[0].includes("none"));
  assert.ok(dockerCalls[0].includes("--read-only"));
});

test("quality checks fail closed when a check has no result", async () => {
  const adapter = new QualityAdapter({ preview: { inspect: async () => ({ checks: {} }) } });
  const report = await adapter.run({ candidateId: "candidate_1", candidateHash: "hash_1", qaPreviewId: "qa_1" });
  assert.equal(report.passed, false);
  assert.ok(report.results.every((result) => result.passed === false));
});

test("Payload sandbox drafts are bounded and idempotent", async () => {
  let calls = 0;
  const adapter = new PayloadSandboxAdapter({
    backend: { apply: async () => { calls += 1; return { snapshotId: "cms_snapshot_1", recordRefs: ["page_home"], diff: ["pages/home"] }; } },
  });
  const input = { candidateId: "candidate_1", expectedCmsSnapshot: "cms_snapshot_0", idempotencyKey: "idem_1", pageOperations: [{ type: "upsert_page", collection: "pages", locale: "zh-CN", data: { slug: "home", title: "首页" } }] };
  const first = await adapter.createDraft(input);
  const second = await adapter.createDraft(input);
  assert.deepEqual(first, second);
  assert.equal(calls, 1);
  assert.equal(first.createsDraftVersion, false);
  await assert.rejects(() => adapter.createDraft({ ...input, idempotencyKey: "idem_2", environment: "production" }), /sandbox environment/);
  await assert.rejects(() => adapter.createDraft({ ...input, idempotencyKey: "idem_3", pageOperations: [{ type: "upsert_page", collection: "pages", data: { apiToken: "secret" } }] }), /Secrets/);
});

test("Payload schema planner creates only strategy-approved draft models", () => {
  const schema = planPayloadSchema({
    projectId: "project_1",
    locales: ["zh-CN", "en"],
    strategy: {
      pageHierarchy: ["home", "products", "cases", "contact"],
      blocks: ["Hero", "ProductGrid", "CaseGrid", "ContactForm"],
      locales: ["zh-CN", "en"],
    },
  });
  assert.deepEqual(schema.collections.map((item) => item.name), ["pages", "products", "cases", "forms"]);
  assert.equal(schema.rules.draftOnly, true);
  assert.equal(schema.rules.publishAllowed, false);
  assert.ok(schema.collections.find((item) => item.name === "pages").fields.some((item) => item.name === "seo"));
  assert.throws(() => planPayloadSchema({ strategy: { locales: ["xx"] } }), /unsupported locale/);
});

test("Payload HTTP backend writes only draft records to an HTTPS sandbox", async () => {
  const requests = [];
  const backend = new PayloadHttpSandboxBackend({
    baseUrl: "https://payload-sandbox.example.test",
    token: "sandbox-token",
    fetchImpl: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ doc: { id: "page_1" } }) }; },
  });
  const result = await backend.apply({ candidateId: "candidate_1", expectedCmsSnapshot: "cms_0", requestHash: "hash_1", operations: [{ type: "upsert_page", collection: "pages", locale: "en", data: { slug: "home", title: "Home" } }] });
  assert.equal(result.recordRefs[0].id, "page_1");
  assert.equal(requests[0].options.method, "POST");
  assert.match(requests[0].options.body, /"_status":"draft"/);
  assert.throws(() => new PayloadHttpSandboxBackend({ baseUrl: "http://insecure.test", token: "x" }), /HTTPS/);
  assert.throws(() => new PayloadHttpSandboxBackend({ baseUrl: "https://127.0.0.1", token: "x" }), /private or reserved/);
});

test("quality checks bind to candidate hash and never promote delivery preview", async () => {
  const adapter = new QualityAdapter({
    preview: { inspect: async () => ({ checks: { links: { passed: true, details: "ok" }, locale: { passed: false, details: "missing en" }, responsive: { passed: true }, form: { passed: true }, seo: { passed: true } } }) },
  });
  const report = await adapter.run({ candidateId: "candidate_1", candidateHash: "hash_1", qaPreviewId: "qa_1" });
  assert.equal(report.passed, false);
  assert.equal(report.deliveryPreviewMoved, false);
  assert.equal(report.candidateHash, "hash_1");
});

test("JSON store recovers projects and runs", () => {
  const file = "/tmp/sitepilot-state-test/state.json";
  const first = new JsonSitePilotStore(file);
  const project = first.createProject({ goal: "persist me" });
  const run = first.createRun(project.id);
  const second = new JsonSitePilotStore(file);
  assert.equal(second.projects.get(project.id).goal, "persist me");
  assert.equal(second.runs.get(run.id).projectId, project.id);
});

test("delivery orchestrator stops failed QA before review", async () => {
  const store = new SitePilotStore();
  const project = store.createProject({ goal: "orchestrate" });
  const run = store.createRun(project.id);
  const orchestrator = new DeliveryOrchestrator({
    store,
    buildExecutor: { run: async () => ({ passed: true }) },
    payloadAdapter: { createDraft: async () => ({ cmsSnapshotId: "cms_1" }) },
    qualityAdapter: { run: async () => ({ passed: false, reportHash: "qa_1" }) },
  });
  const result = await orchestrator.runCandidate({ runId: run.id, codeArtifact: { headCommit: "f".repeat(40) }, cmsSnapshot: "cms_0", build: {}, payload: {}, quality: {} });
  assert.equal(result.status, "quality_failed");
  assert.throws(() => orchestrator.packageApproved(result.candidate.id, { approvedByReviewer: "reviewer" }), /quality gates/);
});

test("block registry requires review evidence before approval", () => {
  const registry = new BlockRegistry();
  const block = registry.register({ name: "Hero", kind: "hero", repository: "repo", commit: "a".repeat(40), path: "src/Hero.tsx", license: "MIT" });
  assert.throws(() => registry.transition(block.id, "approved", { reviewerId: "r" }), /license and test evidence/);
  registry.transition(block.id, "approved", { reviewerId: "r", licenseVerified: true, testsPassed: true });
  assert.equal(registry.select({ kind: "hero" }).length, 1);
  assert.match(registry.manifest().hash, /^[0-9a-f]{64}$/);
});

test("tool runtime is idempotent and records failed execution", async () => {
  let calls = 0;
  const runtime = new ToolRuntime({ store: new SitePilotStore(), handlers: { probe: async () => { calls += 1; return { ok: true }; } } });
  const args = { tool: "probe", runId: "run_1", agentRunId: "agent_1", inputSnapshotId: "snap_1", idempotencyKey: "idem_1", input: { q: "x" } };
  const first = await runtime.execute(args);
  const second = await runtime.execute(args);
  assert.equal(first.id, second.id);
  assert.equal(calls, 1);
  await assert.rejects(() => runtime.execute({ ...args, idempotencyKey: "idem_2", tool: "missing" }), /not registered/);
});

test("tool journal commits intent before execution and marks unfinished work interrupted", async () => {
  const file = "/tmp/sitepilot-tool-journal/run.json";
  const journal = new JsonToolJournal(file);
  const runtime = new ToolRuntime({ store: new SitePilotStore(), journal, handlers: { probe: async () => ({ ok: true }) } });
  const result = await runtime.execute({ tool: "probe", runId: "run_2", agentRunId: "agent_2", inputSnapshotId: "snap_2", idempotencyKey: "idem_2", input: {}, replay: "unsafe" });
  assert.equal(result.status, "succeeded");
  const persisted = new JsonToolJournal(file);
  assert.equal(persisted.all()[0].replay, "unsafe");
  const interruptedFile = "/tmp/sitepilot-tool-journal/interrupted.json";
  const interrupted = new JsonToolJournal(interruptedFile);
  const interruptedRequest = { tool: "cms", runId: "run_3", agentRunId: "agent_3", inputSnapshotId: "snap_3", requestedScope: {}, input: {} };
  const interruptedHash = crypto.createHash("sha256").update(JSON.stringify(interruptedRequest)).digest("hex");
  interrupted.write({ id: "toolrun_old", tool: "cms", runId: "run_3", agentRunId: "agent_3", inputSnapshotId: "snap_3", idempotencyKey: "idem_3", requestHash: interruptedHash, policyVersion: "policy-v1", replay: "unsafe", status: "intent_committed" });
  const recovered = new JsonToolJournal(interruptedFile);
  assert.equal(recovered.all()[0].status, "interrupted");
  const recoveringRuntime = new ToolRuntime({ store: new SitePilotStore(), journal: recovered, handlers: { cms: async () => ({ ok: true }) } });
  await assert.rejects(() => recoveringRuntime.execute({ tool: "cms", runId: "run_3", agentRunId: "agent_3", inputSnapshotId: "snap_3", idempotencyKey: "idem_3", input: {} }), /interrupted/);
});

test("interrupted tool recovery requires review and only allows safe replay", async () => {
  const file = "/tmp/sitepilot-tool-journal/recovery.json";
  const journal = new JsonToolJournal(file);
  const request = { tool: "probe", runId: "run_4", agentRunId: "agent_old", inputSnapshotId: "snap_4", requestedScope: {}, input: { q: "x" } };
  const requestHash = crypto.createHash("sha256").update(JSON.stringify(request)).digest("hex");
  journal.write({ id: "toolrun_safe", ...request, idempotencyKey: "idem_old", requestHash, policyVersion: "policy-v1", replay: "safe", status: "running" });
  const runtime = new ToolRuntime({ store: new SitePilotStore(), journal: new JsonToolJournal(file), handlers: { probe: async (input) => ({ ...input, ok: true }) } });
  const recovered = await runtime.resumeInterrupted({ idempotencyKey: "idem_old", newIdempotencyKey: "idem_new", newAgentRunId: "agent_new", reviewedBy: "reviewer-1", input: { q: "x" } });
  assert.equal(recovered.status, "succeeded");
  assert.equal(recovered.recovery.reviewedBy, "reviewer-1");
  const unsafeFile = "/tmp/sitepilot-tool-journal/recovery-unsafe.json";
  const unsafeJournal = new JsonToolJournal(unsafeFile);
  unsafeJournal.write({ id: "toolrun_unsafe", ...request, idempotencyKey: "idem_unsafe", requestHash, policyVersion: "policy-v1", replay: "unsafe", status: "running" });
  const unsafeRuntime = new ToolRuntime({ store: new SitePilotStore(), journal: new JsonToolJournal(unsafeFile), handlers: { probe: async () => ({ ok: true }) } });
  await assert.rejects(() => unsafeRuntime.resumeInterrupted({ idempotencyKey: "idem_unsafe", newIdempotencyKey: "idem_new_unsafe", newAgentRunId: "agent_new", reviewedBy: "reviewer-1", input: { q: "x" } }), /Unsafe interrupted/);
});

test("evidence source replacement expires records and invalidates claims", () => {
  const evidence = new EvidenceStore();
  const first = evidence.registerSource({ projectId: "project_1", kind: "client", name: "products.md", content: "Pressure: 10 bar", version: "1" });
  const record = evidence.addRecord({ sourceId: first.id, locator: "line:1", quote: "Pressure: 10 bar", allowedClaims: ["product.pressure"] });
  const claim = evidence.createClaim({ projectId: "project_1", statement: "Product pressure is 10 bar", evidenceIds: [record.id] });
  evidence.registerSource({ projectId: "project_1", kind: "client", name: "products.md", content: "Pressure: 12 bar", version: "2" });
  assert.equal(evidence.records.get(record.id).status, "expired");
  assert.equal(evidence.invalidateExpiredClaims(), 1);
  assert.equal(evidence.claims.get(claim.id).status, "needs_reconfirmation");
  assert.throws(() => evidence.createClaim({ projectId: "project_1", statement: "old claim", evidenceIds: [record.id] }), /expired/);
});

test("industrial vertical slice produces strategy, claims and reviewable blocks", () => {
  const result = buildIndustrialSlice({ projectId: "project_industrial" });
  assert.equal(result.strategy.primaryConversion, "technical-consultation");
  assert.deepEqual(result.strategy.locales, ["zh-CN", "en"]);
  assert.ok(result.strategy.openQuestions.length > 0);
  assert.equal(result.claim.status, "proposed");
  assert.equal(result.blocks.length, 3);
  assert.equal(result.registryManifest.blocks.length, 3);
});

test("Payload source lock is fixed and cannot follow a branch", () => {
  const lock = JSON.parse(fsSync.readFileSync(new URL("../sources/payload-website.lock.json", import.meta.url), "utf8"));
  assert.match(lock.commit, /^[0-9a-f]{40}$/);
  assert.equal(lock.path, "templates/website");
  assert.equal(lock.fetchPolicy.followBranches, false);
  assert.equal(lock.verification, "verified-scoped-source");
  assert.ok(lock.includePaths.includes("packages"));
  assert.ok(lock.includePaths.includes("pnpm-lock.yaml"));
  assert.match(lock.templateManifestHash, /^[0-9a-f]{64}$/);
  assert.match(lock.sourceTreeManifestHash, /^[0-9a-f]{64}$/);
});

test("pinned Payload fetcher enforces source-lock paths and full revision", async () => {
  let calls = 0;
  const source = PINNED_SOURCES.payloadWebsite;
  const fetcher = createPinnedSourceFetcher({ quarantineRoot: "/tmp/sitepilot-pinned-source-test", runner: async () => { calls += 1; return ""; } });
  await assert.rejects(() => fetcher.fetch({ repositoryId: source.repositoryId, commitSha: source.commit, sourceEvidenceId: "evidence_1", includePaths: ["packages"], grant: { level: "L2" } }), /server-locked source scope/);
  await assert.rejects(() => fetcher.fetch({ repositoryId: source.repositoryId, commitSha: "a".repeat(40), sourceEvidenceId: "evidence_1", grant: { level: "L2" } }), /not the allowlisted repository revision/);
  assert.equal(calls, 0);
});

test("template verifier requires the locked files and computes a manifest", async () => {
  const fs = await import("node:fs/promises");
  const root = "/tmp/sitepilot-template-verifier";
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(root, "templates/website/src"), { recursive: true });
  await fs.writeFile(path.join(root, "templates/website/package.json"), JSON.stringify({ license: "MIT" }));
  await fs.writeFile(path.join(root, "templates/website/README.md"), "template");
  const lock = { sourceId: "payload", commit: "a".repeat(40), path: "templates/website", expectedLicense: "MIT", requiredFiles: ["templates/website/package.json", "templates/website/README.md", "templates/website/src"] };
  const verified = await new TemplateSnapshotVerifier({ lock, root }).verify();
  assert.equal(verified.verified, true);
  assert.match(verified.manifestHash, /^[0-9a-f]{64}$/);
  await fs.rm(root, { recursive: true, force: true });
});
