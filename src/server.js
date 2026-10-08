import http from "node:http";
import crypto from "node:crypto";
import { SitePilotStore, planStrategy } from "./core.js";
import { JsonSitePilotStore } from "./persistence.js";
import { EvidenceStore } from "./evidence.js";
import { planPayloadSchema } from "./payload-schema.js";
import { BlockRegistry } from "./registry.js";
import { researchComponents } from "./research-agent.js";
import { composePagePlan } from "./page-composer.js";

export function createServer(store = new SitePilotStore(), auth = {}, evidence = new EvidenceStore(), registry = new BlockRegistry(), codeAtlas = null, payload = null, quality = null) {
  const apiToken = auth.apiToken ?? process.env.SITEPILOT_API_TOKEN ?? "";
  const reviewerToken = auth.reviewerToken ?? process.env.SITEPILOT_REVIEW_TOKEN ?? "";
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
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { status: "ok", service: "sitepilot" });
      if (apiToken.length < 32 || reviewerToken.length < 32 || !reviewerId || apiToken === reviewerToken) return send(res, 503, { code: "AUTH_NOT_CONFIGURED", message: "Distinct 32-character API and reviewer credentials are required" });
      const authorization = req.headers.authorization || "";
      const reviewMatch = url.pathname.match(/^\/candidates\/([^/]+)\/review$/);
      const blockReviewMatch = url.pathname.match(/^\/components\/([^/]+)\/review$/);
      const requiredToken = req.method === "POST" && (reviewMatch || blockReviewMatch) ? reviewerToken : apiToken;
      if (!validToken(authorization, requiredToken)) return send(res, 401, { code: "UNAUTHORIZED", message: "Valid SitePilot credential required" });
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
      if (req.method === "POST" && url.pathname === "/components") return send(res, 201, registry.register(await readJson(req)));
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
        return send(res, 201, revised);
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
      const candidateRunMatch = url.pathname.match(/^\/runs\/([^/]+)\/candidates$/);
      if (req.method === "POST" && candidateRunMatch) {
        const run = store.runs.get(candidateRunMatch[1]);
        if (!run) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        const candidate = store.createCandidate(run.id, await readJson(req));
        run.checkpoint = "candidate_ready";
        return send(res, 201, candidate);
      }
      const payloadMatch = url.pathname.match(/^\/candidates\/([^/]+)\/payload-draft$/);
      if (req.method === "POST" && payloadMatch) {
        if (!payload || typeof payload.createDraft !== "function") return send(res, 503, { code: "PAYLOAD_NOT_CONFIGURED" });
        const candidate = store.candidates.get(payloadMatch[1]);
        if (!candidate) return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
        if (!candidate.quality?.passed) return send(res, 422, { code: "QUALITY_GATE_REQUIRED" });
        const input = await readJson(req);
        const receipt = await payload.createDraft({ ...input, candidateId: candidate.id, environment: "sandbox" });
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
        return send(res, 201, draft);
      }
      const statusMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
      if (req.method === "GET" && statusMatch) {
        const run = store.runs.get(statusMatch[1]);
        return run ? send(res, 200, run) : send(res, 404, { code: "RESOURCE_NOT_FOUND" });
      }
      return send(res, 404, { code: "RESOURCE_NOT_FOUND" });
    } catch (error) {
      const status = error.code === "RESOURCE_NOT_FOUND" ? 404 : error.code === "POLICY_DENIED" || error.code === "INVALID_INPUT" ? 422 : 400;
      return send(res, status, { code: error.code || "INVALID_INPUT", message: error.message });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 3100);
  const store = process.env.SITEPILOT_STATE_FILE ? new JsonSitePilotStore(process.env.SITEPILOT_STATE_FILE) : new SitePilotStore();
  createServer(store).listen(port, "127.0.0.1", () => console.log(`SitePilot API listening on http://127.0.0.1:${port}`));
}
