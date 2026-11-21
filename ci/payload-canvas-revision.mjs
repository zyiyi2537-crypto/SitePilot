import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { designContentBlocks } from "../src/design-content.js";
import lock from "../sources/payload-website.lock.json" with { type: "json" };

// Exercises the built upstream template, not the production L2 candidate builder.
// All projects, content and reviewer approvals below are ephemeral CI fixtures.
export async function verifyCanvasPayloadRevision({ store, apiBaseUrl, apiToken, reviewerToken, payloadBaseUrl }) {
  assert.equal(process.env.CI, "1");
  assert.ok(process.env.PREVIEW_SECRET);
  const slug = "canvas-" + crypto.randomBytes(6).toString("hex");
  const project = store.createProject({ goal: "Canvas revision acceptance " + slug, locale: ["en"] });
  const run = store.createRun(project.id);
  run.strategy = { pageHierarchy: [slug], blocks: ["Hero", "Content", "CTA"], locales: ["en"] };
  const sourcePaths = { Hero: "src/heros/LowImpact/index.tsx", Content: "src/blocks/Content/config.ts", CTA: "src/blocks/CallToAction/config.ts" };
  run.pagePlan = { routes: [{ page: slug, route: "/" + slug, components: run.strategy.blocks.map(name => ({
    name, registryId: "payload-" + name.toLowerCase(), instanceId: name,
    source: { repository: lock.repositoryId, commit: lock.commit, path: "templates/website/" + sourcePaths[name] },
  })) }] };
  const original = store.createDesignDraft(run.id);
  const originalCandidate = store.createCandidate(run.id, { designDraftId: original.id });
  const browser = await chromium.launch(process.env.SITEPILOT_CI_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.SITEPILOT_CI_CHROMIUM_EXECUTABLE } : { channel: "chrome" });
  const post = async (route, body, token = apiToken) => {
    const res = await fetch(apiBaseUrl + route, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const errors = [];
  const outputRoot = path.join(process.env.GITHUB_WORKSPACE || process.cwd(), "ci-results");
  await fs.mkdir(outputRoot, { recursive: true });
  try {
    const studio = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    studio.on("pageerror", error => errors.push(error.message));
    await studio.goto(apiBaseUrl + "/studio");
    await studio.locator("#api-token").fill(apiToken);
    await studio.locator("#connect").click();
    await studio.locator("#project-list button").filter({ hasText: project.goal }).click();
    await studio.locator("#notice").filter({ hasText: /^已更新$/ }).waitFor();
    await studio.locator('[data-stage-target="stage-design"]').click();
    await studio.locator("#toggle-canvas-edit").click();
    const frame = studio.frameLocator("#canvas-frame");
    const editCopy = async (id, field, value) => {
      await frame.locator('[data-instance="' + id + '"] [data-sp-field="' + field + '"]').click();
      await studio.locator("#canvas-text-edit").fill(value);
      await studio.locator("#apply-canvas-text").click();
    };
    await editCopy("Hero", "title", "Canvas revised hero");
    assert.ok(await studio.locator("#canvas-move-down").isDisabled());
    await editCopy("Hero", "description", "Canvas revised introduction");
    await editCopy("Content", "title", "Canvas revised details");
    await editCopy("Content", "description", "Canvas revised body");
    await editCopy("CTA", "title", "Canvas revised call to action");
    await studio.locator("#canvas-move-up").click();
    await studio.locator("#save-canvas-edit").click();
    await studio.locator("#design-status").filter({ hasText: "版本 2" }).waitFor();
    const revised = store.designs.get(run.designDraftId);
    assert.equal(revised.parentId, original.id);
    assert.equal(originalCandidate.status, "superseded");
    assert.deepEqual(revised.pageTree[0].components.map(c => c.name), ["Hero", "CTA", "Content"]);
    assert.deepEqual(original.pageTree[0].components.map(c => c.name), ["Hero", "Content", "CTA"]);
    const stale = await post("/candidates/" + originalCandidate.id + "/payload-plan", {});
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "STALE_DESIGN_REVISION");

    const candidate = store.createCandidate(run.id, {
      parentId: originalCandidate.id, designDraftId: revised.id,
      codeArtifact: { head: lock.commit, designHash: revised.designHash },
      build: { passed: true, reportHash: "synthetic-template-adapter-fixture-only" },
    });
    const content = { title: "Canvas revision CI", heroTitle: "Old hero", description: "Old body", cta: "Old CTA", claimRefs: ["synthetic-ci-copy"] };
    const mismatched = await post("/candidates/" + candidate.id + "/payload-plan", { contentByPage: { [slug]: content } });
    assert.equal(mismatched.status, 422);
    assert.equal(mismatched.body.code, "NEEDS_INPUT");
    const contentByPage = { [slug]: { ...content, blocks: designContentBlocks(revised.pageTree[0]) } };
    const binding = { candidateId: candidate.id, candidateHash: candidate.candidateHash, designDraftId: revised.id, designHash: revised.designHash, pagePlanHash: null, contentByPage };
    const contentHash = crypto.createHash("sha256").update(JSON.stringify(binding)).digest("hex");
    candidate.contentModel = { ...binding, contentHash, status: "proposed" };
    const writeBody = { expectedCmsSnapshot: "ci_empty_snapshot", idempotencyKey: slug, useAgentContent: true, contentByPage };
    const unapproved = await post("/candidates/" + candidate.id + "/payload-draft", writeBody);
    assert.equal(unapproved.status, 422);
    assert.equal(unapproved.body.code, "CONTENT_APPROVAL_REQUIRED");
    const approved = await post("/candidates/" + candidate.id + "/content-approval", { approved: true, expectedContentHash: contentHash }, reviewerToken);
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    const written = await post("/candidates/" + candidate.id + "/payload-draft", writeBody);
    assert.equal(written.status, 201, JSON.stringify(written.body));
    assert.equal(written.body.candidate.revision.designHash, revised.designHash);
    assert.equal(written.body.candidate.parentId, candidate.id);
    assert.deepEqual(written.body.plan.operations[0].data.layout.map(b => b.blockType), ["cta", "content"]);
    const replay = await post("/candidates/" + candidate.id + "/payload-draft", writeBody);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.candidate.id, written.body.candidate.id);
    await studio.close();

    const anonymous = await fetch(payloadBaseUrl + "/api/pages?where[slug][equals]=" + slug + "&draft=true");
    assert.equal((await anonymous.json()).totalDocs, 0);
    const checks = [];
    for (const [device, viewport] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 375, height: 812 }]]) {
      const context = await browser.newContext({ baseURL: payloadBaseUrl, viewport });
      try {
        const login = await context.request.post("/api/users/login", { data: { email: "sitepilot-ci@example.invalid", password: process.env.SITEPILOT_CI_PASSWORD } });
        assert.equal(login.status(), 200);
        const preview = await context.request.get("/next/preview?path=/" + slug + "&previewSecret=" + encodeURIComponent(process.env.PREVIEW_SECRET), { maxRedirects: 0 });
        assert.equal(preview.status(), 307);
        const rendered = await context.newPage();
        rendered.on("pageerror", error => errors.push(error.message));
        assert.equal((await rendered.goto(payloadBaseUrl + "/" + slug)).status(), 200);
        const body = await rendered.locator("body").innerText();
        const renderedOrder = [
          "Canvas revised hero",
          "Canvas revised call to action",
          "Canvas revised details",
        ].map(text => body.indexOf(text));
        assert.ok(
          renderedOrder.every(index => index >= 0),
          `${device} must render all revised blocks: ${body}`,
        );
        assert.ok(
          renderedOrder[0] < renderedOrder[1] && renderedOrder[1] < renderedOrder[2],
          `${device} rendered block order must match DesignDraft: ${body}`,
        );
        assert.ok(body.includes("Canvas revised introduction"));
        assert.ok(body.includes("Canvas revised body"));
        assert.ok(!body.includes("Old hero") && !body.includes("Old CTA"));
        assert.equal(await rendered.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        await rendered.screenshot({ path: path.join(outputRoot, "canvas-payload-" + device + ".png"), fullPage: true });
        checks.push(device + ": revised copy and order rendered by real Payload");
      } finally { await context.close(); }
    }
    assert.deepEqual(errors, []);
    const receipt = {
      synthetic: true, sourceCommit: lock.commit, originalDesignId: original.id, revisedDesignId: revised.id,
      designHash: revised.designHash, candidateId: candidate.id, cmsCandidateId: written.body.candidate.id,
      cmsSnapshotId: written.body.cmsSnapshotId, contentHash, checks, published: false,
      staleCandidateRejected: true, approvalRequired: true, idempotentReplay: true,
      limitations: ["Uses a built pinned template and synthetic candidate build receipt; does not attest the production L2 worktree build.", "Single ephemeral process; durable multi-worker CMS revision writes remain separate work."],
    };
    await fs.writeFile(path.join(outputRoot, "canvas-payload-revision.json"), JSON.stringify(receipt, null, 2) + "\n");
    console.log(JSON.stringify(receipt, null, 2));
  } catch (error) {
    await fs.writeFile(
      path.join(outputRoot, "canvas-payload-revision-failure.json"),
      JSON.stringify({
        synthetic: true,
        slug,
        errors,
        message: error instanceof Error ? error.message : String(error),
      }, null, 2) + "\n",
    );
    throw error;
  } finally { await browser.close(); }
}
