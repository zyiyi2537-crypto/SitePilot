import { PolicyError } from "./core.js";

const SUPPORTED_LOCALES = new Set(["zh-CN", "en", "en-US", "ja", "de", "fr"]);
const SUPPORTED_BLOCKS = new Set(["Hero", "Content", "CTA"]);
const SAFE_PAGE = /^[a-z][a-z0-9-]{0,63}$/;

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

function pageOperation(page, strategy, locale, content) {
  if (typeof page !== "string" || !SAFE_PAGE.test(page)) throw new PolicyError("Payload page slug is invalid", "INVALID_INPUT");
  const blocks = (strategy.blocks || []).map((block) => typeof block === "string" ? block : block?.name).filter(Boolean);
  const unsupported = blocks.filter((block) => !SUPPORTED_BLOCKS.has(block));
  if (unsupported.length) throw new PolicyError(`Payload Website Template does not provide approved schema for: ${unsupported.join(", ")}`, "TEMPLATE_CAPABILITY_MISSING");
  if (!content || typeof content.title !== "string" || !content.title.trim() || typeof content.heroTitle !== "string" || !content.heroTitle.trim() || !Array.isArray(content.claimRefs) || !content.claimRefs.length) throw new PolicyError(`Approved page content and claim references are required: ${page}`, "NEEDS_INPUT");
  const hero = {
    type: "lowImpact",
    richText: richText(content.heroTitle, content.description || ""),
    links: [],
  };
  const layout = [];
  if (blocks.includes("Content")) {
    if (!content.description?.trim()) throw new PolicyError(`Content block text is required: ${page}`, "NEEDS_INPUT");
    layout.push({ blockType: "content", columns: [{ size: "full", richText: richText(content.description, "", 2) }] });
  }
  if (blocks.includes("CTA")) {
    if (!content.cta?.trim()) throw new PolicyError(`CTA text is required: ${page}`, "NEEDS_INPUT");
    layout.push({ blockType: "cta", richText: richText(content.cta, "", 2), links: [] });
  }
  return {
    type: "upsert_page",
    collection: "pages",
    locale,
    data: { title: content.title.trim(), slug: page, hero, layout, meta: { title: content.metaTitle || content.title.trim(), description: content.metaDescription || content.description || "" }, _status: "draft" },
  };
}

export function createPayloadDraftPlan({ strategy, projectId, locales, contentByPage = {} } = {}) {
  if (!strategy || typeof strategy !== "object") throw new PolicyError("Strategy is required", "INVALID_INPUT");
  const selected = [...new Set(locales || strategy.locales || ["en"])];
  if (!selected.length || selected.some((locale) => !SUPPORTED_LOCALES.has(locale))) throw new PolicyError("Payload locale is not supported by the template", "POLICY_DENIED");
  if (selected.length !== 1) throw new PolicyError("Pinned Payload Website Template has no localization configuration", "TEMPLATE_CAPABILITY_MISSING");
  const pages = Array.isArray(strategy.pageHierarchy) ? strategy.pageHierarchy : [];
  if (!pages.length) throw new PolicyError("Payload draft requires at least one page", "INVALID_INPUT");
  const operations = pages.map((page) => pageOperation(page, strategy, selected[0], contentByPage[page]));
  return Object.freeze({ template: "payload-website", projectId: projectId || null, locales: selected, operations, claimRefs: [...new Set(pages.flatMap((page) => contentByPage[page].claimRefs))], publishAllowed: false });
}
