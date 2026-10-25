import crypto from "node:crypto";

import { PolicyError } from "./core.js";

const SUPPORTED_LOCALES = new Set(["zh-CN", "en", "en-US", "ja", "de", "fr"]);
const SAFE_PAGE = /^[a-z][a-z0-9-]{0,63}$/;
const PAYLOAD_BLOCKS = Object.freeze({
  Hero: { target: "hero" },
  Content: { target: "layout", blockType: "content" },
  CTA: { target: "layout", blockType: "cta" },
  ProductGrid: { target: "layout", blockType: "productGrid" },
  ContactForm: { target: "layout", blockType: "contactForm" },
});

function propsHash(props) {
  return crypto.createHash("sha256").update(JSON.stringify(props || {})).digest("hex");
}

function textNode(text, type = "paragraph", headingLevel = 1) {
  const node = { type, children: [{ type: "text", text: String(text), detail: 0, format: 0, mode: "normal", style: "", version: 1 }], direction: "ltr", format: "", indent: 0, version: 1 };
  if (type === "heading") node.tag = `h${headingLevel}`;
  return node;
}

function richText(title, description = "", headingLevel = 1) {
  const children = [textNode(title, "heading", headingLevel)];
  if (description) children.push(textNode(description));
  return { root: { type: "root", children, direction: "ltr", format: "", indent: 0, version: 1 } };
}

function pageOperation(page, componentNames, locale, content) {
  if (typeof page !== "string" || !SAFE_PAGE.test(page)) throw new PolicyError("Payload page slug is invalid", "INVALID_INPUT");
  const blocks = componentNames.map((block) => typeof block === "string" ? block : block?.name).filter(Boolean);
  const unsupported = blocks.filter((block) => !PAYLOAD_BLOCKS[block]);
  if (unsupported.length) throw new PolicyError(`Payload Website Template does not provide approved schema for: ${unsupported.join(", ")}`, "TEMPLATE_CAPABILITY_MISSING");
  if (blocks.filter((block) => block === "Hero").length !== 1 || blocks[0] !== "Hero") throw new PolicyError("Payload Website Template requires exactly one Hero as the first page component", "TEMPLATE_CAPABILITY_MISSING");
  if (!content || typeof content.title !== "string" || !content.title.trim() || typeof content.heroTitle !== "string" || !content.heroTitle.trim() || !Array.isArray(content.claimRefs) || !content.claimRefs.length) throw new PolicyError(`Approved page content and claim references are required: ${page}`, "NEEDS_INPUT");
  const hero = {
    type: "lowImpact",
    richText: richText(content.heroTitle, content.description || ""),
    links: [],
  };
  const layout = [];
  for (const block of blocks.slice(1)) {
    if (block === "Content") {
      if (!content.description?.trim()) throw new PolicyError(`Content block text is required: ${page}`, "NEEDS_INPUT");
      layout.push({ blockType: "content", columns: [{ size: "full", richText: richText(content.description, "", 2) }] });
    } else if (block === "CTA") {
      if (!content.cta?.trim()) throw new PolicyError(`CTA text is required: ${page}`, "NEEDS_INPUT");
      layout.push({ blockType: "cta", richText: richText(content.cta, "", 2), links: [] });
    } else if (block === "ProductGrid") {
      const products = Array.isArray(content.products) ? content.products : [];
      if (!products.length) throw new PolicyError(`ProductGrid requires approved products: ${page}`, "NEEDS_INPUT");
      if (products.length > 24 || products.some((product) => !product || typeof product.slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(product.slug))) throw new PolicyError(`ProductGrid contains invalid product references: ${page}`, "SCHEMA_REJECTED");
      layout.push({ blockType: "productGrid", heading: content.productGridTitle || "Products", products: products.map(({ slug }) => ({ relationTo: "products", value: slug })) });
    } else if (block === "ContactForm") {
      if (typeof content.formSlug !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(content.formSlug)) throw new PolicyError(`ContactForm requires an approved form reference: ${page}`, "NEEDS_INPUT");
      layout.push({ blockType: "contactForm", form: { relationTo: "forms", value: content.formSlug }, consentRequired: true });
    }
  }
  return {
    type: "upsert_page",
    collection: "pages",
    locale,
    data: { title: content.title.trim(), slug: page, hero, layout, meta: { title: content.metaTitle || content.title.trim(), description: content.metaDescription || content.description || "" }, _status: "draft" },
  };
}

function designPageComponents({ page, route, pagePlan, designDraft } = {}) {
  if (!designDraft) return null;
  if (typeof designDraft.id !== "string" || !designDraft.id || !/^[a-f0-9]{64}$/i.test(designDraft.designHash || "") || !Array.isArray(designDraft.pageTree) || !Array.isArray(pagePlan?.routes)) {
    throw new PolicyError("A bound DesignDraft and page plan are required for component mapping", "SCHEMA_REJECTED");
  }
  const designPage = designDraft.pageTree.find((item) => item.page === page && item.route === route);
  const plannedPage = pagePlan.routes.find((item) => item.page === page && item.route === route);
  if (!designPage || !plannedPage || !Array.isArray(designPage.components) || !Array.isArray(plannedPage.components) || designPage.components.length !== plannedPage.components.length) {
    throw new PolicyError(`DesignDraft route does not match the frozen page plan: ${page}`, "STALE_REVISION");
  }
  const unmatched = [...plannedPage.components];
  const components = designPage.components.map((component) => {
    const index = unmatched.findIndex((planned) => planned.registryId === component.registryId && planned.name === component.name && JSON.stringify(planned.source) === JSON.stringify(component.source));
    if (index < 0) throw new PolicyError(`DesignDraft component is outside the frozen page plan: ${component.name}`, "STALE_REVISION");
    unmatched.splice(index, 1);
    const schema = PAYLOAD_BLOCKS[component.name];
    if (!schema) throw new PolicyError(`Payload Website Template does not provide approved schema for: ${component.name}`, "TEMPLATE_CAPABILITY_MISSING");
    return { instanceId: component.instanceId, registryId: component.registryId, name: component.name, propsHash: propsHash(component.props), schema };
  });
  if (unmatched.length) throw new PolicyError(`DesignDraft omits planned components: ${page}`, "STALE_REVISION");
  const heroes = components.filter((component) => component.name === "Hero");
  if (heroes.length !== 1 || components[0]?.name !== "Hero") throw new PolicyError(`Payload Website Template requires one leading Hero: ${page}`, "TEMPLATE_CAPABILITY_MISSING");
  let layoutIndex = 0;
  return components.map((component) => ({
    instanceId: component.instanceId,
    registryId: component.registryId,
    name: component.name,
    propsHash: component.propsHash,
    payloadTarget: component.name === "Hero" ? "hero" : `layout[${layoutIndex++}]`,
    blockType: component.schema.blockType || null,
    copyPolicy: "approved_content_required",
  }));
}

export function createPayloadDraftPlan({ strategy, projectId, locales, contentByPage = {}, designDraft, pagePlan } = {}) {
  if (!strategy || typeof strategy !== "object") throw new PolicyError("Strategy is required", "INVALID_INPUT");
  const selected = [...new Set(locales || strategy.locales || ["en"])];
  if (!selected.length || selected.some((locale) => !SUPPORTED_LOCALES.has(locale))) throw new PolicyError("Payload locale is not supported by the template", "POLICY_DENIED");
  if (selected.length !== 1) throw new PolicyError("Pinned Payload Website Template has no localization configuration", "TEMPLATE_CAPABILITY_MISSING");
  const pages = Array.isArray(strategy.pageHierarchy) ? strategy.pageHierarchy : [];
  if (!pages.length) throw new PolicyError("Payload draft requires at least one page", "INVALID_INPUT");
  if (designDraft && (!designDraft || typeof designDraft !== "object" || !Array.isArray(designDraft.pageTree) || pages.length !== designDraft.pageTree.length || pages.some((page) => !designDraft.pageTree.some((item) => item.page === page)))) {
    throw new PolicyError("DesignDraft pages do not match the strategy hierarchy", "STALE_REVISION");
  }
  const designPages = new Map();
  const operations = pages.map((page) => {
    const route = designDraft?.pageTree.find((item) => item.page === page)?.route || (page === "home" ? "/" : `/${page}`);
    const mapping = designPageComponents({ page, route, pagePlan, designDraft });
    if (mapping) designPages.set(page, { page, route, claimRefs: [...new Set(contentByPage[page]?.claimRefs || [])], components: mapping });
    const names = mapping ? mapping.map((component) => component.name) : (strategy.blocks || []).map((block) => typeof block === "string" ? block : block?.name).filter(Boolean);
    if (mapping) {
      const expected = (strategy.blocks || []).map((block) => typeof block === "string" ? block : block?.name).filter(Boolean).sort();
      if (expected.length !== names.length || expected.some((name, index) => name !== [...names].sort()[index])) {
        throw new PolicyError(`DesignDraft components do not match the strategy blocks: ${page}`, "STALE_REVISION");
      }
    }
    return pageOperation(page, names, selected[0], contentByPage[page]);
  });
  const designMappings = designDraft ? {
    schemaVersion: "payload-website-block-map-v1",
    designDraftId: designDraft.id,
    designHash: designDraft.designHash,
    pages: [...designPages.values()],
  } : null;
  return Object.freeze({ template: "payload-website", projectId: projectId || null, locales: selected, operations, claimRefs: [...new Set(pages.flatMap((page) => contentByPage[page].claimRefs))], designMappings, publishAllowed: false });
}
