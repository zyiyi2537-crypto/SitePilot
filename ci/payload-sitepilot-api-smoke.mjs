import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import lock from "../sources/payload-website.lock.json" with { type: "json" };
import { SitePilotStore } from "../src/core.js";
import { PayloadHttpSandboxBackend, PayloadSandboxAdapter } from "../src/payload-adapter.js";
import { createServer } from "../src/server.js";

assert.equal(process.env.CI, "1");
assert.ok(process.env.SITEPILOT_CI_PASSWORD);
const payloadBaseUrl = "http://127.0.0.1:3000";
const payloadLogin = await fetch(`${payloadBaseUrl}/api/users/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "sitepilot-ci@example.invalid", password: process.env.SITEPILOT_CI_PASSWORD }),
});
assert.equal(payloadLogin.status, 200);
const { token: payloadToken } = await payloadLogin.json();
assert.ok(payloadToken);

const backend = new PayloadHttpSandboxBackend({
  baseUrl: "https://payload-sandbox.invalid",
  token: payloadToken,
  fetchImpl: async (url, options) => {
    const target = new URL(url);
    assert.equal(target.origin, "https://payload-sandbox.invalid");
    return fetch(new URL(`${target.pathname}${target.search}`, payloadBaseUrl), options);
  },
});
const payload = new PayloadSandboxAdapter({ backend });
const apiToken = `sitepilot-ci-api-${crypto.randomBytes(24).toString("hex")}`;
const reviewerToken = `sitepilot-ci-review-${crypto.randomBytes(24).toString("hex")}`;
const store = new SitePilotStore();
const server = createServer(store, { apiToken, reviewerToken, reviewerId: "sitepilot-ci" }, undefined, undefined, null, payload);

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const apiBaseUrl = `http://127.0.0.1:${address.port}`;
  const anonymousStatus = await fetch(`${apiBaseUrl}/payload/status`);
  assert.equal(anonymousStatus.status, 401);
  await anonymousStatus.arrayBuffer();

  const connectedResponse = await fetch(`${apiBaseUrl}/payload/status`, { headers: { authorization: `Bearer ${apiToken}` } });
  assert.equal(connectedResponse.status, 200);
  const connectedStatus = await connectedResponse.json();
  assert.equal(connectedStatus.configured, true);
  assert.equal(connectedStatus.connection, "connected");
  assert.equal(connectedStatus.sandboxOnly, true);
  assert.equal(connectedStatus.writeMode, "draft_only");
  assert.equal(connectedStatus.publishAllowed, false);
  assert.equal(JSON.stringify(connectedStatus).includes(payloadToken), false);

  const suffix = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  const page = `sitepilot-api-${suffix}`;
  const route = `/${page}`;
  const components = [
    { instanceId: `hero_${suffix}`, registryId: "payload-hero", name: "Hero", props: { variant: "lowImpact" }, source: { repository: lock.repositoryId, commit: lock.commit, path: "templates/website/src/heros/LowImpact/index.tsx" } },
    { instanceId: `content_${suffix}`, registryId: "payload-content", name: "Content", props: { columns: 1 }, source: { repository: lock.repositoryId, commit: lock.commit, path: "templates/website/src/blocks/Content/config.ts" } },
    { instanceId: `cta_${suffix}`, registryId: "payload-cta", name: "CTA", props: { links: 0 }, source: { repository: lock.repositoryId, commit: lock.commit, path: "templates/website/src/blocks/CallToAction/config.ts" } },
  ];
  const project = store.createProject({ goal: "Synthetic SitePilot Payload API acceptance", locale: ["en"] });
  const run = store.createRun(project.id);
  run.strategy = { pageHierarchy: [page], blocks: ["Hero", "Content", "CTA"], locales: ["en"] };
  run.pagePlan = { routes: [{ page, route, components: components.map(({ instanceId, props, ...component }) => component) }] };
  const design = store.createDesignDraft(run.id);
  const candidate = store.createCandidate(run.id, {
    designDraftId: design.id,
    codeArtifact: { head: "synthetic-ci-only", designHash: design.designHash },
    build: { passed: true, reportHash: "synthetic-adapter-acceptance-only" },
  });
  const draftResponse = await fetch(`${apiBaseUrl}/candidates/${candidate.id}/payload-draft`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      expectedCmsSnapshot: "ci_synthetic_empty_snapshot",
      idempotencyKey: `sitepilot-api-${suffix}`,
      contentByPage: {
        [page]: {
          title: "SitePilot synthetic API acceptance",
          heroTitle: "SitePilot API to Payload sandbox",
          description: "Synthetic content written through the authenticated SitePilot API.",
          cta: "Review synthetic draft",
          claimRefs: ["ci-sitepilot-api-content-v1"],
        },
      },
    }),
  });
  assert.equal(draftResponse.status, 201);
  const draftResult = await draftResponse.json();
  assert.equal(draftResult.status, "sandbox_draft");
  assert.equal(draftResult.candidate.cmsSnapshot.cmsSnapshotId, draftResult.cmsSnapshotId);
  assert.equal(draftResult.candidate.revision.designHash, design.designHash);
  assert.equal(draftResult.candidate.cmsSnapshot.cmsRecordRefs.length, 1);

  const anonymousDraft = await fetch(`${payloadBaseUrl}/api/pages?where[slug][equals]=${encodeURIComponent(page)}&draft=true`);
  assert.equal(anonymousDraft.status, 200);
  assert.equal((await anonymousDraft.json()).totalDocs, 0);

  const receipt = {
    synthetic: true,
    acceptance: "authenticated SitePilot API to ephemeral Payload sandbox",
    payloadStatus: connectedStatus.connection,
    candidateId: candidate.id,
    cmsCandidateId: draftResult.candidate.id,
    cmsSnapshotId: draftResult.cmsSnapshotId,
    designHash: design.designHash,
    slug: page,
    recordRefs: draftResult.candidate.cmsSnapshot.cmsRecordRefs,
    readbackVerified: true,
    anonymousDraftReadBlocked: true,
    publishAllowed: connectedStatus.publishAllowed,
    buildGate: "synthetic adapter fixture; Payload website build is validated separately",
  };
  const output = path.join(process.env.GITHUB_WORKSPACE || process.cwd(), "ci-results", "sitepilot-payload-api-receipt.json");
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
