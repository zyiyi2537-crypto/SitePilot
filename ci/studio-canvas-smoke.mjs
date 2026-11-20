import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright-core";
import { createServer } from "../src/server.js";
import { SitePilotStore } from "../src/core.js";

const store = new SitePilotStore();
const project = store.createProject({ goal: "Visual editing acceptance", industry: "industrial", locale: ["en"] });
const run = store.createRun(project.id);
run.strategy = { strategy: "industrial-leadgen", audience: "buyers", primaryConversion: "Contact", businessGoal: "Qualified inquiries", designDirection: "Industrial" };
run.pagePlan = { routes: [{ page: "home", route: "/", components: ["Hero", "ProductGrid", "CTA"].map((name, i) => ({
  instanceId: "section_" + i, name, registryId: "block_" + i,
  source: { repository: "fixture", commit: "a".repeat(40), path: name + ".tsx" },
  props: { title: i ? "Products" : "Original headline" },
})) }] };
const original = store.createDesignDraft(run.id);
const candidate = store.createCandidate(run.id, { designDraftId: original.id });
const apiToken = randomBytes(24).toString("hex");
const server = createServer(store, { apiToken, reviewerToken: randomBytes(24).toString("hex"), reviewerId: "fixture" });
server.listen(0, "127.0.0.1");
await once(server, "listening");
let browser;
try {
  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });
  try {
    await page.goto("http://127.0.0.1:" + server.address().port + "/studio");
    await page.locator("#api-token").fill(apiToken);
    await page.locator("#connect").click();
    await page.locator("#project-list button").first().click();
    await page.locator("#notice").filter({ hasText: /^已更新$/ }).waitFor();
    await page.locator('[data-stage-target="stage-design"]').click();
    await page.locator("#toggle-canvas-edit").click();
    const frame = page.frameLocator("#canvas-frame").first();
    const title = frame.locator('[data-instance="section_0"] [data-sp-field="title"]');
    await title.click();
    const input = page.locator("#canvas-text-edit");
    await input.fill("Revised & approved");
    await page.locator("#apply-canvas-text").click();
    assert.equal(await title.textContent(), "Revised & approved");
    const card = frame.locator('[data-instance="section_1"] [data-sp-field="itemTitle"]').first();
    await card.click();
    await input.fill("Custom product");
    await page.locator("#apply-canvas-text").click();
    await title.click();
    assert.ok(await page.locator("#canvas-move-down").isDisabled());
    await card.click();
    await page.locator("#canvas-move-down").click();
    assert.deepEqual(await frame.locator("main > [data-instance]").evaluateAll(els => els.map(el => el.dataset.instance)), ["section_0", "section_2", "section_1"]);
    await page.locator("#canvas-device-select").selectOption("Mobile");
    await page.waitForFunction(() => document.querySelector("#canvas-frame").getBoundingClientRect().width <= 400);
    const saved = page.waitForResponse(res => res.url().endsWith("/patches") && res.request().method() === "POST");
    await page.locator("#save-canvas-edit").click();
    assert.equal((await saved).status(), 201);
    await page.locator("#design-status").filter({ hasText: "版本 2" }).waitFor();
    const next = store.designs.get(run.designDraftId);
    assert.equal(next.parentId, original.id);
    assert.deepEqual(next.pageTree[0].components.map(c => c.instanceId), ["section_0", "section_2", "section_1"]);
    assert.equal(next.pageTree[0].components[2].props.items[0].title, "Custom product");
    assert.equal(next.pageTree[0].components[0].props.title, "Revised & approved");
    assert.equal(original.pageTree[0].components[0].props.title, "Original headline");
    assert.equal(candidate.status, "superseded");
    await page.locator("#design-version").selectOption(original.id);
    assert.ok(await page.locator("#toggle-canvas-edit").isDisabled());
    await page.locator("#design-version").selectOption(next.id);
    await page.locator("#toggle-canvas-edit").click();
    await frame.locator('[data-instance="section_0"] [data-sp-field="title"]').click();
    await input.fill("Not saved");
    assert.ok(await page.locator("#save-canvas-edit").isDisabled());
    await page.locator("#cancel-canvas-edit").click();
    assert.equal(store.designs.size, 2);
    assert.deepEqual(errors, []);
    console.log("Passed: canvas selection, plain text, block order, immutable revision and superseded candidate.");
  } catch (error) {
    console.error([...new Set(errors)].join("\n"), await page.locator("#notice").textContent());
    throw error;
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
