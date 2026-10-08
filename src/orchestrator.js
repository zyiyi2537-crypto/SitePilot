import { PolicyError } from "./core.js";

export class DeliveryOrchestrator {
  constructor({ store, buildExecutor, payloadAdapter, qualityAdapter } = {}) {
    if (!store || !buildExecutor || !payloadAdapter || !qualityAdapter) throw new PolicyError("Delivery orchestrator dependencies are required", "CONFIG_REQUIRED");
    this.store = store;
    this.buildExecutor = buildExecutor;
    this.payloadAdapter = payloadAdapter;
    this.qualityAdapter = qualityAdapter;
  }

  async runCandidate({ runId, codeArtifact, cmsSnapshot, build, payload, quality } = {}) {
    const run = this.store.runs.get(runId);
    if (!run) throw new PolicyError("Run not found", "RESOURCE_NOT_FOUND");
    const candidate = this.store.createCandidate(runId, { codeArtifact, cmsSnapshot, sourceRefs: codeArtifact?.sourceRefs || [] });
    run.checkpoint = "candidate_created";
    const buildReport = await this.buildExecutor.run({ ...build, candidateId: candidate.id, commit: codeArtifact?.headCommit || build?.commit });
    if (!buildReport.passed) {
      this.store.markQuality(candidate.id, { passed: false, reason: "build_failed", buildReport });
      return { candidate, buildReport, status: "quality_failed" };
    }
    const cmsReceipt = await this.payloadAdapter.createDraft({ ...payload, candidateId: candidate.id, expectedCmsSnapshot: cmsSnapshot });
    const qualityReport = await this.qualityAdapter.run({ ...quality, candidateId: candidate.id, candidateHash: candidate.candidateHash, qaPreviewId: cmsReceipt.cmsSnapshotId });
    const qualityResult = this.store.markQuality(candidate.id, { passed: qualityReport.passed, buildReport, cmsReceipt, qualityReport });
    run.checkpoint = qualityReport.passed ? "quality_passed" : "quality_failed";
    return { candidate: qualityResult, buildReport, cmsReceipt, qualityReport, status: qualityReport.passed ? "ready_for_review" : "quality_failed" };
  }

  packageApproved(candidateId, review) { return this.store.packageReview(candidateId, review); }
}
