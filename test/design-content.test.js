import test from "node:test";
import assert from "node:assert/strict";
import { SitePilotStore } from "../src/core.js";
import { createCanvasPatch } from "../src/grapes-patch.js";
import { designContentBlocks, resolvePayloadCopy } from "../src/design-content.js";
import { createPayloadDraftPlan } from "../src/payload-template.js";

function fixture() {
  const store = new SitePilotStore();
  const project = store.createProject({ goal: "Draft revision acceptance", locale: ["en"] });
  const run = store.createRun(project.id);
  run.strategy = { pageHierarchy: ["home"], blocks: ["Hero", "Content", "CTA"], locales: ["en"] };
  run.pagePlan = { routes: [{ page: "home", route: "/", components: run.strategy.blocks.map(name => ({
    name, registryId: name, instanceId: name, props: {},
    source: { repository: "fixture", commit: "a".repeat(40), path: name + ".tsx" },
  })) }] };
  const draft = store.createDesignDraft(run.id);
  return { store, run, draft };
}

test("canvas revision preserves copy and layout through the Payload planner", () => {
  const { store, run, draft } = fixture();
  const parent = store.createCandidate(run.id, { designDraftId: draft.id });
  const patch = createCanvasPatch({
    page: draft.pageTree[0], expectedDesignHash: draft.designHash,
    components: [
      { instanceId: "Hero", fields: { title: "Revised hero", description: "Revised lead" } },
      { instanceId: "CTA", fields: { title: "Revised CTA" } },
      { instanceId: "Content", fields: { title: "Revised details", description: "Revised body" } },
    ],
  });
  const next = store.applyDesignPatch(draft.id, patch).draft;
  const legacy = { title: "Home", heroTitle: "Old hero", description: "Old body", cta: "Old CTA", claimRefs: ["supported-claim"] };
  const input = { strategy: run.strategy, pagePlan: run.pagePlan, designDraft: next };
  assert.throws(() => createPayloadDraftPlan({ ...input, contentByPage: { home: legacy } }), error => error.code === "NEEDS_INPUT");
  const blocks = designContentBlocks(next.pageTree[0]);
  const plan = createPayloadDraftPlan({ ...input, contentByPage: { home: { ...legacy, blocks } } });
  const data = plan.operations[0].data;
  assert.equal(data.hero.richText.root.children[0].children[0].text, "Revised hero");
  assert.equal(data.hero.richText.root.children[1].children[0].text, "Revised lead");
  assert.deepEqual(data.layout.map(b => b.blockType), ["cta", "content"]);
  assert.equal(data.layout[0].richText.root.children[0].children[0].text, "Revised CTA");
  assert.equal(data.layout[1].columns[0].richText.root.children[1].children[0].text, "Revised body");
  assert.equal(plan.designMappings.designHash, next.designHash);
  assert.equal(next.parentId, draft.id);
  assert.deepEqual(draft.pageTree[0].components.map(c => c.name), ["Hero", "Content", "CTA"]);
  assert.equal(parent.status, "superseded");
  blocks.Hero.title = "Unreviewed alternative";
  assert.throws(() => createPayloadDraftPlan({ ...input, contentByPage: { home: { ...legacy, blocks } } }), error => error.code === "NEEDS_INPUT");
});

test("unmapped visible fields and copy outside the design fail explicitly", () => {
  const { draft } = fixture();
  const page = structuredClone(draft.pageTree[0]);
  page.components[0].props = { ctaLabel: "Unsupported button" };
  assert.throws(() => designContentBlocks(page), error => error.code === "TEMPLATE_CAPABILITY_MISSING");
  page.components[0].props = {};
  assert.throws(() => resolvePayloadCopy(page, { blocks: { unknown: { title: "Wrong component" } } }), error => error.code === "SCHEMA_REJECTED");
  assert.throws(() => resolvePayloadCopy(page, { blocks: { Hero: { url: "unsupported" } } }), error => error.code === "SCHEMA_REJECTED");
});
