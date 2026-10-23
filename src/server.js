import http from "node:http";
import crypto from "node:crypto";
import { SitePilotStore, PolicyError, planStrategy } from "./core.js";
import { JsonSitePilotStore, SqliteSitePilotStore } from "./persistence.js";
import { EvidenceStore, JsonEvidenceStore, SqliteEvidenceStore } from "./evidence.js";
import { planPayloadSchema } from "./payload-schema.js";
import { BlockRegistry, JsonBlockRegistry, SqliteBlockRegistry } from "./registry.js";
import { researchComponents } from "./research-agent.js";
import { composePagePlan } from "./page-composer.js";
import { createCodeAtlasAdapterFromEnvironment } from "./codeatlas.js";
import { PayloadHttpSandboxBackend, PayloadSandboxAdapter } from "./payload-adapter.js";
import { WorktreePolicy } from "./core.js";
import { materializePagePlan } from "./code-generator.js";
import { validateGeneratedCandidate } from "./local-build.js";
import path from "node:path";
import fs from "node:fs/promises";
import { GrantStore, SqliteGrantStore } from "./grants.js";
import { QualityAdapter } from "./quality-adapter.js";
import { PlaywrightPreviewAdapter } from "./playwright-preview.js";
import { PayloadBuildPipeline } from "./payload-build.js";
import { PINNED_SOURCES } from "./pinned-sources.js";
import { LocalPreviewServer, loadPreviewManifest } from "./preview-server.js";
import { createPayloadDraftPlan } from "./payload-template.js";

export function createServer(store = new SitePilotStore(), auth = {}, evidence = new EvidenceStore(), registry = new BlockRegistry(), codeAtlas = null, payload = null, quality = null, generation = null, grants = new GrantStore(), payloadBuild = null) {
  const generatingRuns = new Set();
  const previewSessions = new Map();
  const previewTtlMs = 15 * 60 * 1000;
  const apiToken = auth.apiToken ?? process.env.SITEPILOT_API_TOKEN ?? "";
  const reviewerToken = auth.reviewerToken ?? process.env.SITEPILOT_REVIEW_TOKEN ?? "";
  const l2Token = auth.l2Token ?? process.env.SITEPILOT_L2_TOKEN ?? "";
  const reviewerId = auth.reviewerId ?? process.env.SITEPILOT_REVIEWER_ID ?? "";
  const validToken = (provided, expected) => {
    if (typeof provided !== "string" || !provided.startsWith("Bearer ")) return false;
    const actual = Buffer.from(provided.slice(7));
    const wanted = Buffer.from(expected);
    return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
  };
  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  const readJson = async (req) => {
    let text = "";
    for await (const chunk of req) {
      text += chunk;
      if (text.length > 1024 * 1024) throw new Error("request too large");
    }
    return text ? JSON.parse(text) : {};
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && ["/studio", "/studio.css", "/studio.js"].includes(url.pathname)) {
        const file = { "/studio": "studio.html", "/studio.css": "studio.css", "/studio.js": "studio.js" }[url.pathname];
        const type = file.endsWith("html") ? "text/html" : file.endsWith("css") ? "text/css" : "text/javascript";
        const content = await fs.readFile(new URL(`./${file}`, import.meta.url));
        res.writeHead(200, { "content-type": `${type}; charset=utf-8`, "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        return res.end(content);
      }
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { status: "ok", service: "sitepilot" });
      if (apiToken.length < 32 || reviewerToken.length < 32 || !reviewerId || apiToken === reviewerToken) return send(res, 503, { code: "AUTH_NOT_CONFIGURED", message: "Distinct 32-character API and reviewer credentials are required" });
      const authorization = req.headers.authorization || "";
      const reviewMatch = url.pathname.match(/^\/candidates\/([^/]+)\/review$/);
      const blockReviewMatch = url.pathname.match(/^\/components\/([^/]+)\/review$/);
      const generateMatch = url.pathname.match(/^\/runs\/([^/]+)\/generate$/);
      const grantMatch = url.pathname.match(/^\/runs\/([^/]+)\/grants$/);
      const grantRevokeMatch = url.pathname.match(/^\/grants\/([^/]+)\/revoke$/);
      const payloadPrepareMatch = url.pathname.match(/^\/runs\/([^/]+)\/payload-prepare$/);
      const payloadBuildMatch = url.pathname.match(/^\/runs\/([^/]+)\/payload-build$/);
      const candidatePreviewMatch = url.pathname.match(/^\/candidates\/([^/]+)\/preview$/);
      const payloadPlanMatch = url.pathname.match(/^\/candidates\/([^/]+)\/payload-plan$/);
      const previewMatch = url.pathname.match(/^\/previews\/([^/]+)$/);
      if (generateMatch && (l2Token.length < 32 || l2Token === apiToken || l2Token === reviewerToken)) return send(res, 503, { code: "L2_NOT_CONFIGURED" });
      if ((payloadPrepareMatch || payloadBuildMatch) && (l2Token.length < 32 || l2Token === apiToken || l2Token === reviewerToken)) return send(res, 503, { code: "L2_NOT_CONFIGURED" });
      const requiredToken = req.method === "POST" && (reviewMatch || blockReviewMatch || grantMatch || grantRevokeMatch) ? reviewerToken : req.method === "POST" && (generateMatch || payloadPrepareMatch || payloadBuildMatch) ? l2Token : apiToken;
      if (!validToken(authorization, requiredToken)) return send(res, 401, { code: "UNAUTHORIZED", message: "Valid SitePilot credential required" });
      if (req.method === "GET" && url.pathname === "/projects") return send(res, 200, { projects: [...store.projects.values()] });
      const projectRunsMatch = url.pathname.match(/^\/projects\/([^/]+)\/runs$/);
      if (req.method === "GET" && projectRunsMatch) return send(res, 200, { runs: [...store.runs.values()].filter((run) => run.projectId === projectRunsMatch[1]) });
      if (req.method === "GET" && url.pathname === "/candidates") return send(res, 200, { candidates: [...store.candidates.values()] });
      if (req.method === "POST" && candidatePreviewMatch) {
        if (!generation?.worktreeRoot) return send(res, 503, { code: "GENERATION_NOT_CONFIGURED" });
        const candidate = store.candidates.get(candidatePreviewMatch[1]);
        if (!candidate) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        if (!candidate.build?.passed) return send(res, 422, { code: "BUILD_GATE_REQUIRED" });
        const workspace = candidate.codeArtifact?.workspace;
        const run = store.runs.get(candidate.runId);
        const expectedWorkspace = run ? path.resolve(generation.worktreeRoot, run.id) : null;
        if (!workspace || !expectedWorkspace || path.resolve(workspace) !== expectedWorkspace) throw new PolicyError("Preview workspace is outside the server-owned run directory", "POLICY_DENIED");
        const active = [...previewSessions.values()].find((session) => session.candidateId === candidate.id && session.expiresAt > Date.now());
        if (active) return send(res, 200, active.public);
        const manifest = await loadPreviewManifest(expectedWorkspace);
        const expectedDesignHash = candidate.codeArtifact?.designHash || null;
        if (expectedDesignHash && manifest.design?.designHash !== expectedDesignHash) throw new PolicyError("Preview manifest design hash does not match candidate", "STALE_REVISION");
        await validateGeneratedCandidate({ worktreeRoot: expectedWorkspace, expectedDesignHash: expectedDesignHash || undefined });
        const preview = new LocalPreviewServer({ plan: manifest });
        const address = await preview.listen();
        const sessionId = `preview_${crypto.randomUUID().replaceAll("-", "")}`;
        const expiresAt = Date.now() + previewTtlMs;
        const publicSession = Object.freeze({ sessionId, candidateId: candidate.id, candidateHash: candidate.candidateHash, designDraftId: candidate.designDraftId || null, designHash: manifest.design?.designHash || null, baseUrl: `http://${address.host}:${address.port}/`, expiresAt: new Date(expiresAt).toISOString(), localOnly: true, writesAllowed: false });
        const timer = setTimeout(() => { const session = previewSessions.get(sessionId); previewSessions.delete(sessionId); session?.preview.close().catch(() => {}); }, previewTtlMs);
        timer.unref?.();
        previewSessions.set(sessionId, { sessionId, candidateId: candidate.id, expiresAt, preview, public: publicSession, timer });
        store.event(candidate.runId, "candidate.preview.created", { candidateId: candidate.id, sessionId, expiresAt: publicSession.expiresAt });
        return send(res, 201, publicSession);
      }
      if (req.method === "DELETE" && previewMatch) {
        const session = previewSessions.get(previewMatch[1]);
        if (!session) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        previewSessions.delete(session.sessionId);
        clearTimeout(session.timer);
        await session.preview.close();
        return send(res, 200, { sessionId: session.sessionId, closed: true });
      }
      if (req.method === "POST" && payloadPlanMatch) {
        const candidate = store.candidates.get(payloadPlanMatch[1]);
        if (!candidate) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        const run = store.runs.get(candidate.runId);
        if (!run?.strategy) return send(res, 422, { code: "STRATEGY_REQUIRED" });
        const design = candidate.designDraftId ? store.designs.get(candidate.designDraftId) : null;
        if (candidate.designDraftId && !design) return send(res, 422, { code: "DESIGN_DRAFT_REQUIRED" });
        const input = await readJson(req);
        const plan = createPayloadDraftPlan({
          strategy: run.strategy,
          projectId: run.projectId,
          locales: input.locales || run.inputSnapshot.locale,
          contentByPage: input.contentByPage,
        });
        return send(res, 200, { ...plan, candidateId: candidate.id, designDraftId: design?.id || null, designHash: design?.designHash || null, writesAllowed: false });
      }
      const sourceMatch = url.pathname.match(/^\/projects\/([^/]+)\/sources$/);
      if (req.method === "POST" && sourceMatch) {
        const source = evidence.registerSource({ ...(await readJson(req)), projectId: sourceMatch[1] });
        return send(res, 201, source);
      }
      const evidenceMatch = url.pathname.match(/^\/sources\/([^/]+)\/records$/);
      if (req.method === "POST" && evidenceMatch) return send(res, 201, evidence.addRecord({ ...(await readJson(req)), sourceId: evidenceMatch[1] }));
      const claimMatch = url.pathname.match(/^\/projects\/([^/]+)\/claims$/);
      if (req.method === "POST" && claimMatch) return send(res, 201, evidence.createClaim({ ...(await readJson(req)), projectId: claimMatch[1] }));
      if (req.method === "GET" && url.pathname === "/components") return send(res, 200, { registry: registry.manifest() });
      if (req.method === "POST" && url.pathname === "/components") {
        const input = await readJson(req);
        return send(res, 201, registry.register({ ...input, state: "candidate", review: undefined }));
      }
      if (req.method === "POST" && blockReviewMatch) {
        const decision = await readJson(req);
        if (decision.approved !== true) return send(res, 422, { code: "REVIEW_NOT_APPROVED" });
        return send(res, 200, registry.transition(blockReviewMatch[1], "approved", {
          reviewerId,
          licenseVerified: decision.licenseVerified === true,
          testsPassed: decision.testsPassed === true,
          notes: decision.notes || "",
        }));
      }
      if (req.method === "POST" && url.pathname === "/projects") {
        const project = store.createProject(await readJson(req));
        return send(res, 201, project);
      }
      const runMatch = url.pathname.match(/^\/projects\/([^/]+)\/runs$/);
      if (req.method === "POST" && runMatch) {
        const run = store.createRun(runMatch[1], await readJson(req));
        const project = store.projects.get(run.projectId);
        const strategy = planStrategy(project);
        run.strategy = strategy;
        run.payloadSchema = planPayloadSchema({
          projectId: project.id,
          strategy,
          locales: project.locale,
        });
        run.checkpoint = "strategy_ready";
        store.event(run.id, "strategy.created", { strategy: strategy.strategy });
        return send(res, 201, run);
      }
      if (req.method === "POST" && grantMatch) {
        const run = store.runs.get(grantMatch[1]);
        if (!run) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        const input = await readJson(req);
        const tool = input.tool || "generate_candidate";
        let resource;
        let planHash;
        if (tool === "generate_candidate") {
          if (!generation?.worktreeRoot) return send(res, 503, { code: "GENERATION_NOT_CONFIGURED" });
          if (!run.pagePlan) return send(res, 422, { code: "PAGE_PLAN_REQUIRED" });
          resource = path.resolve(generation.worktreeRoot, run.id);
          planHash = run.pagePlan.sourceManifestHash;
        } else if (tool === "prepare_payload_template") {
          if (!payloadBuild) return send(res, 503, { code: "PAYLOAD_BUILD_NOT_CONFIGURED" });
          if (run.payloadWorktree) return send(res, 409, { code: "WORKTREE_ALREADY_EXISTS" });
          resource = path.resolve(payloadBuild.worktreeRoot, run.projectId, run.id);
          planHash = PINNED_SOURCES.payloadWebsite.commit;
        } else if (tool === "build_payload_template") {
          if (!payloadBuild || !run.payloadWorktree) return send(res, 422, { code: "PAYLOAD_WORKTREE_REQUIRED" });
          resource = path.resolve(payloadBuild.worktreeRoot, run.payloadWorktree.repositoryPathRef);
          planHash = PINNED_SOURCES.payloadWebsite.commit;
        } else return send(res, 422, { code: "TOOL_NOT_APPROVED" });
        const grant = grants.issue({ projectId: run.projectId, runId: run.id, tool, resource, planHash, expiresAt: input.expiresAt, issuedBy: reviewerId });
        store.event(run.id, "grant.issued", { grantId: grant.id, tool: grant.tool, resource: grant.resource });
        return send(res, 201, grant);
      }
      if (req.method === "POST" && grantRevokeMatch) {
        const grant = grants.revoke(grantRevokeMatch[1]);
        store.event(grant.runId, "grant.revoked", { grantId: grant.id });
        return send(res, 200, grant);
      }
      if (req.method === "POST" && payloadPrepareMatch) {
        if (!payloadBuild) return send(res, 503, { code: "PAYLOAD_BUILD_NOT_CONFIGURED" });
        const run = store.runs.get(payloadPrepareMatch[1]);
        if (!run) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        if (run.status === "superseded" || run.payloadWorktree) return send(res, 409, { code: "WORKTREE_ALREADY_EXISTS" });
        const input = await readJson(req);
        grants.consume(input.grantId, { projectId: run.projectId, runId: run.id, tool: "prepare_payload_template", resource: path.resolve(payloadBuild.worktreeRoot, run.projectId, run.id), planHash: PINNED_SOURCES.payloadWebsite.commit });
        const prepared = await payloadBuild.prepare({ projectId: run.projectId, runId: run.id, grant: { level: "L2" } });
        run.payloadWorktree = prepared;
        store.event(run.id, "payload.worktree.prepared", { worktreeId: prepared.worktreeId, templateCommit: prepared.baseCommit });
        return send(res, 201, prepared);
      }
      if (req.method === "POST" && payloadBuildMatch) {
        if (!payloadBuild) return send(res, 503, { code: "PAYLOAD_BUILD_NOT_CONFIGURED" });
        const run = store.runs.get(payloadBuildMatch[1]);
        if (!run) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        if (!run.payloadWorktree) return send(res, 422, { code: "PAYLOAD_WORKTREE_REQUIRED" });
        const input = await readJson(req);
        grants.consume(input.grantId, { projectId: run.projectId, runId: run.id, tool: "build_payload_template", resource: path.resolve(payloadBuild.worktreeRoot, run.payloadWorktree.repositoryPathRef), planHash: PINNED_SOURCES.payloadWebsite.commit });
        const report = await payloadBuild.build({ candidateId: `template_${run.id}`, worktree: run.payloadWorktree, grant: { level: "L2" } });
        run.payloadTemplateBuild = report;
        store.event(run.id, "payload.template.built", { reportHash: report.build?.reportHash, templateCommit: report.sourceCommit });
        return send(res, 200, report);
      }
      const answersMatch = url.pathname.match(/^\/runs\/([^/]+)\/answers$/);
      if (req.method === "POST" && answersMatch) {
        const run = store.runs.get(answersMatch[1]);
        if (!run) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        const revised = store.reviseRun(run.id, await readJson(req));
        const project = store.projects.get(revised.projectId);
        revised.strategy = planStrategy({
          ...project,
          ...revised.inputSnapshot,
        });
        revised.payloadSchema = planPayloadSchema({
          projectId: project.id,
          strategy: revised.strategy,
          locales: revised.inputSnapshot.locale,
        });
        revised.checkpoint = "strategy_ready";
        store.persist?.();
        return send(res, 201, revised);
      }
      const designDraftMatch = url.pathname.match(/^\/runs\/([^/]+)\/design-drafts$/);
      if (req.method === "POST" && designDraftMatch) {
        const run = store.runs.get(designDraftMatch[1]);
        if (!run) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        if (!run.pagePlan) return send(res, 422, { code: "PAGE_PLAN_REQUIRED" });
        const draft = store.createDesignDraft(run.id, await readJson(req));
        store.persist?.();
        return send(res, 201, draft);
      }
      const runDesignsMatch = url.pathname.match(/^\/runs\/([^/]+)\/design-drafts$/);
      if (req.method === "GET" && runDesignsMatch) {
        const run = store.runs.get(runDesignsMatch[1]);
        if (!run) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        return send(res, 200, { designs: (run.designDraftIds || []).map((id) => store.designs.get(id)).filter(Boolean) });
      }
      const designPatchMatch = url.pathname.match(/^\/design-drafts\/([^/]+)\/patches$/);
      if (req.method === "POST" && designPatchMatch) {
        const design = store.designs.get(designPatchMatch[1]);
        if (!design) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        const input = await readJson(req);
        const result = store.applyDesignPatch(design.id, { ...input, actor: input.actor || "api-operator" });
        store.persist?.();
        return send(res, 201, result);
      }
      const designPatchesMatch = url.pathname.match(/^\/design-drafts\/([^/]+)\/patches$/);
      if (req.method === "GET" && designPatchesMatch) {
        if (!store.designs.has(designPatchesMatch[1])) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        return send(res, 200, { patches: [...store.canvasPatches.values()].filter((patch) => patch.designDraftId === designPatchesMatch[1]) });
      }
      const researchMatch = url.pathname.match(/^\/runs\/([^/]+)\/research$/);
      if (req.method === "POST" && researchMatch) {
        if (!codeAtlas || typeof codeAtlas.search !== "function") return send(res, 503, { code: "CODEATLAS_NOT_CONFIGURED" });
        const run = store.runs.get(researchMatch[1]);
        if (!run) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        const input = await readJson(req);
        if (typeof input.repository !== "string" || typeof input.expectedCommit !== "string") return send(res, 422, { code: "INVALID_INPUT", message: "repository and expectedCommit are required" });
        const result = await researchComponents({ strategy: run.strategy, adapter: codeAtlas, registry, projectId: run.projectId, repository: input.repository, expectedCommit: input.expectedCommit, topK: input.topK });
        run.research = result;
        run.checkpoint = result.componentPlan.requiresReview ? "components_pending_review" : "components_approved";
        store.event(run.id, "research.completed", { repository: result.repository, commit: result.commit, evidenceCount: result.evidence.length, requiresReview: result.componentPlan.requiresReview });
        return send(res, 200, result);
      }
      const planMatch = url.pathname.match(/^\/runs\/([^/]+)\/page-plan$/);
      if (req.method === "POST" && planMatch) {
        const run = store.runs.get(planMatch[1]);
        if (!run) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        const plan = composePagePlan({ strategy: run.strategy, registry, projectId: run.projectId, runId: run.id });
        run.pagePlan = plan;
        run.checkpoint = "page_plan_ready";
        store.event(run.id, "page-plan.created", { sourceManifestHash: plan.sourceManifestHash, routeCount: plan.routes.length });
        return send(res, 200, plan);
      }
      if (req.method === "POST" && generateMatch) {
        if (!generation?.worktreeRoot || !codeAtlas || typeof codeAtlas.getCompleteFile !== "function") return send(res, 503, { code: "GENERATION_NOT_CONFIGURED" });
        const run = store.runs.get(generateMatch[1]);
        if (!run) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        if (run.status === "superseded") return send(res, 409, { code: "RUN_SUPERSEDED" });
        if (!run.pagePlan) return send(res, 422, { code: "PAGE_PLAN_REQUIRED" });
        const designDraft = run.designDraftId ? store.designs.get(run.designDraftId) : null;
        if (!designDraft) return send(res, 422, { code: "DESIGN_DRAFT_REQUIRED" });
        if (run.candidateIds.length || generatingRuns.has(run.id)) return send(res, 409, { code: "CANDIDATE_ALREADY_EXISTS" });
        for (const route of run.pagePlan.routes) for (const component of route.components) {
          const approved = registry.blocks.get(component.registryId);
          if (!approved || approved.state !== "approved" || approved.repository !== component.source.repository || approved.commit !== component.source.commit || approved.path !== component.source.path) return send(res, 422, { code: "COMPONENTS_NOT_APPROVED" });
        }
        const root = path.resolve(generation.worktreeRoot, run.id);
        const input = await readJson(req);
        grants.consume(input.grantId, { projectId: run.projectId, runId: run.id, tool: "generate_candidate", resource: root, planHash: run.pagePlan.sourceManifestHash });
        store.event(run.id, "grant.consumed", { grantId: input.grantId });
        generatingRuns.add(run.id);
        try {
        const worktree = new WorktreePolicy(root);
        const generated = await materializePagePlan({
          plan: run.pagePlan,
          designDraft,
          worktree,
          grant: { level: "L2" },
          sourceResolver: (source) => codeAtlas.getCompleteFile({ ...source, expectedCommit: source.commit }),
        });
        const build = await validateGeneratedCandidate({ worktreeRoot: root, expectedDesignHash: designDraft.designHash });
        const candidate = store.createCandidate(run.id, { designDraftId: designDraft.id, codeArtifact: { workspace: root, files: generated.files, head: "local-uncommitted", designDraftId: designDraft.id, designHash: designDraft.designHash }, sourceRefs: run.research?.evidence || [] });
        candidate.build = build;
        run.checkpoint = "candidate_ready";
        store.persist?.();
        return send(res, 201, { candidate, generated, build });
        } finally { generatingRuns.delete(run.id); }
      }
      const candidateRunMatch = url.pathname.match(/^\/runs\/([^/]+)\/candidates$/);
      if (req.method === "POST" && candidateRunMatch) {
        const run = store.runs.get(candidateRunMatch[1]);
        if (!run) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        const candidate = store.createCandidate(run.id, await readJson(req));
        run.checkpoint = "candidate_ready";
        store.persist?.();
        return send(res, 201, candidate);
      }
      const payloadMatch = url.pathname.match(/^\/candidates\/([^/]+)\/payload-draft$/);
      if (req.method === "POST" && payloadMatch) {
        if (!payload || typeof payload.createDraft !== "function") return send(res, 503, { code: "PAYLOAD_NOT_CONFIGURED" });
        const candidate = store.candidates.get(payloadMatch[1]);
        if (!candidate) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        if (!candidate.quality?.passed) return send(res, 422, { code: "QUALITY_GATE_REQUIRED" });
        const input = await readJson(req);
        const design = candidate.designDraftId ? store.designs.get(candidate.designDraftId) : null;
        if (candidate.designDraftId && !design) return send(res, 422, { code: "DESIGN_DRAFT_REQUIRED" });
        const receipt = await payload.createDraft({
          ...input,
          candidateId: candidate.id,
          designDraftId: design?.id || null,
          designHash: design?.designHash || null,
          environment: "sandbox",
        });
        if (design && (receipt?.designDraftId !== design.id || receipt?.designHash !== design.designHash)) {
          throw new PolicyError("Payload snapshot did not preserve the bound design revision", "STALE_REVISION");
        }
        candidate.cmsSnapshot = receipt;
        store.event(candidate.runId, "payload.draft.created", { candidateId: candidate.id, cmsSnapshotId: receipt.cmsSnapshotId });
        return send(res, 201, receipt);
      }
      const qaMatch = url.pathname.match(/^\/candidates\/([^/]+)\/qa$/);
      if (req.method === "POST" && qaMatch) {
        if (!quality || typeof quality.run !== "function") return send(res, 503, { code: "QA_NOT_CONFIGURED" });
        const candidate = store.candidates.get(qaMatch[1]);
        if (!candidate) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        const report = await quality.run({ ...(await readJson(req)), candidateId: candidate.id, candidateHash: candidate.candidateHash });
        store.markQuality(candidate.id, { passed: report.passed, reportHash: report.reportHash, checks: report.results });
        return send(res, 200, report);
      }
      if (req.method === "POST" && reviewMatch) {
        const candidate = store.candidates.get(reviewMatch[1]);
        if (!candidate) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        const decision = await readJson(req);
        if (decision.approved !== true) return send(res, 422, { code: "REVIEW_NOT_APPROVED" });
        const draft = store.packageReview(candidate.id, { approvedByReviewer: reviewerId, notes: decision.notes || "" });
        const run = store.runs.get(candidate.runId);
        if (run) run.checkpoint = "draft_ready_for_review";
        store.persist?.();
        return send(res, 201, draft);
      }
      const statusMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
      if (req.method === "GET" && statusMatch) {
        const run = store.runs.get(statusMatch[1]);
        return run ? send(res, 200, run) : send(res, 404, { code: "RESOURCE_NOT_FOUND" });
      }
      return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
    } catch (error) {
      const status = error.code === "RESOURCE_NOT_FOUND" ? 404 : error.code === "SANDBOX_REQUIRED" || error.code === "CONFIG_REQUIRED" ? 503 : error.code === "POLICY_DENIED" || error.code === "INVALID_INPUT" || error.code === "NEEDS_INPUT" || error.code === "TEMPLATE_CAPABILITY_MISSING" || error.code === "STALE_REVISION" || error.code === "SCHEMA_REJECTED" || error.code?.startsWith("GRANT_") ? 422 : 400;
      return send(res, status, { code: error.code || "INVALID_INPUT", message: error.message });
    }
  });
  server.on("close", () => {
    for (const session of previewSessions.values()) {
      clearTimeout(session.timer);
      session.preview.close().catch(() => {});
    }
    previewSessions.clear();
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 3100);
  const databaseFile = process.env.SITEPILOT_DB_FILE;
  if (databaseFile && [process.env.SITEPILOT_STATE_FILE, process.env.SITEPILOT_EVIDENCE_FILE, process.env.SITEPILOT_REGISTRY_FILE, process.env.SITEPILOT_GRANTS_DB].some(Boolean)) throw new Error("Configure either SITEPILOT_DB_FILE or legacy state files, not both");
  const store = databaseFile ? new SqliteSitePilotStore(databaseFile) : process.env.SITEPILOT_STATE_FILE ? new JsonSitePilotStore(process.env.SITEPILOT_STATE_FILE) : new SitePilotStore();
  const evidence = databaseFile ? new SqliteEvidenceStore(databaseFile) : process.env.SITEPILOT_EVIDENCE_FILE ? new JsonEvidenceStore(process.env.SITEPILOT_EVIDENCE_FILE) : new EvidenceStore();
  const registry = databaseFile ? new SqliteBlockRegistry(databaseFile) : process.env.SITEPILOT_REGISTRY_FILE ? new JsonBlockRegistry(process.env.SITEPILOT_REGISTRY_FILE) : new BlockRegistry();
  const codeAtlasSettings = [process.env.CODEATLAS_MCP_URL, process.env.CODEATLAS_MCP_TOKEN, process.env.CODEATLAS_REPOSITORIES];
  if (codeAtlasSettings.some(Boolean) && codeAtlasSettings.some((value) => !value)) throw new Error("Configure CODEATLAS_MCP_URL, CODEATLAS_MCP_TOKEN, and CODEATLAS_REPOSITORIES together");
  const codeAtlas = codeAtlasSettings.every(Boolean) ? createCodeAtlasAdapterFromEnvironment() : null;
  const payloadSettings = [process.env.PAYLOAD_SANDBOX_URL, process.env.PAYLOAD_SANDBOX_TOKEN];
  if (payloadSettings.some(Boolean) && payloadSettings.some((value) => !value)) throw new Error("Configure PAYLOAD_SANDBOX_URL and PAYLOAD_SANDBOX_TOKEN together");
  const payload = payloadSettings.every(Boolean) ? new PayloadSandboxAdapter({ backend: new PayloadHttpSandboxBackend({ baseUrl: process.env.PAYLOAD_SANDBOX_URL, token: process.env.PAYLOAD_SANDBOX_TOKEN }) }) : null;
  const host = process.env.SITEPILOT_HOST || "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "0.0.0.0") throw new Error("SITEPILOT_HOST must be 127.0.0.1 or 0.0.0.0");
  const grants = databaseFile ? new SqliteGrantStore(databaseFile) : process.env.SITEPILOT_GRANTS_DB ? new SqliteGrantStore(process.env.SITEPILOT_GRANTS_DB) : new GrantStore();
  const quality = process.env.SITEPILOT_QA_PREVIEWS && process.env.SITEPILOT_QA_ARTIFACT_ROOT ? new QualityAdapter({ preview: new PlaywrightPreviewAdapter({ previews: JSON.parse(process.env.SITEPILOT_QA_PREVIEWS), artifactRoot: process.env.SITEPILOT_QA_ARTIFACT_ROOT }) }) : null;
  const payloadBuildSettings = [process.env.SITEPILOT_PAYLOAD_SOURCE_ROOT, process.env.SITEPILOT_WORKTREE_ROOT, process.env.SITEPILOT_SANDBOX_IMAGE];
  const payloadBuild = payloadBuildSettings.every(Boolean) ? new PayloadBuildPipeline({ sourceRoot: process.env.SITEPILOT_PAYLOAD_SOURCE_ROOT, worktreeRoot: process.env.SITEPILOT_WORKTREE_ROOT, image: process.env.SITEPILOT_SANDBOX_IMAGE }) : null;
  createServer(store, {}, evidence, registry, codeAtlas, payload, quality, { worktreeRoot: process.env.SITEPILOT_WORKTREE_ROOT }, grants, payloadBuild).listen(port, host, () => console.log(`SitePilot API listening on http://${host}:${port}`));
}
