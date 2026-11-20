import { PolicyError } from "./core.js";

const ALIASES = {
  title: ["title", "heading", "headline", "label"],
  description: ["description", "subtitle", "body", "summary"],
};
const MAPPED_COPY = new Set(["Hero", "Content", "CTA"]);
const UNMAPPED_COPY = ["eyebrow", "overline", "ctaLabel", "buttonLabel", "cta", "items"];

function text(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 2000 || /<\/?[a-z][^>]*>|javascript:|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/i.test(value)) {
    throw new PolicyError("Invalid component copy: " + label, "SCHEMA_REJECTED");
  }
  return value.trim();
}

// These are proposals until the containing ContentModel is reviewed.
export function designContentBlocks(page) {
  const entries = [];
  for (const component of page?.components || []) {
    const fields = {};
    for (const [field, aliases] of Object.entries(ALIASES)) {
      const key = aliases.find(key => (typeof component.props?.[key] === "string" || typeof component.props?.[key] === "number") && String(component.props[key]).trim());
      if (key) fields[field] = text(String(component.props[key]), component.instanceId + "." + field);
    }
    const unmapped = UNMAPPED_COPY.filter(key => component.props?.[key] !== undefined && component.props[key] !== "" && (!Array.isArray(component.props[key]) || component.props[key].length));
    if (unmapped.length || Object.keys(fields).length && !MAPPED_COPY.has(component.name)) {
      throw new PolicyError("当前 Payload 模板尚未映射该区块文案：" + component.name + (unmapped.length ? " / " + unmapped.join(", ") : ""), "TEMPLATE_CAPABILITY_MISSING");
    }
    if (Object.keys(fields).length) entries.push([component.instanceId, fields]);
  }
  return Object.fromEntries(entries);
}

export function validateBlockContent(page, supplied = {}) {
  if (!page || !supplied || typeof supplied !== "object" || Array.isArray(supplied)) throw new PolicyError("Component copy requires a bound design page", "SCHEMA_REJECTED");
  const normalized = {};
  const entries = Object.entries(supplied);
  if (entries.length > page.components.length) throw new PolicyError("Too many component copy entries", "SCHEMA_REJECTED");
  for (const [id, fields] of entries) {
    const component = page.components.find(item => item.instanceId === id);
    if (!component || !MAPPED_COPY.has(component.name)) throw new PolicyError("Component copy is outside the supported design: " + id, "SCHEMA_REJECTED");
    if (!fields || typeof fields !== "object" || Array.isArray(fields) || Object.keys(fields).some(key => !Object.hasOwn(ALIASES, key))) throw new PolicyError("Unknown component copy field: " + id, "SCHEMA_REJECTED");
    Object.defineProperty(normalized, id, { enumerable: true, value: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, text(value, id + "." + key)])) });
  }
  return normalized;
}

export function resolvePayloadCopy(page, content) {
  const required = designContentBlocks(page);
  const supplied = validateBlockContent(page, content.blocks);
  const resolved = {};
  for (const component of page.components) {
    const legacy = component.name === "Hero" ? { title: content.heroTitle, description: content.description }
      : component.name === "Content" ? { title: content.description }
      : component.name === "CTA" ? { title: content.cta } : {};
    const copy = { ...legacy, ...supplied[component.instanceId] };
    for (const [key, value] of Object.entries(required[component.instanceId] || {})) {
      if (copy[key] !== value) throw new PolicyError("审核内容与设计文案不一致：" + page.page + " / " + component.instanceId + "." + key + "；请重新生成并审核内容。", "NEEDS_INPUT");
    }
    Object.defineProperty(resolved, component.instanceId, { enumerable: true, value: copy });
  }
  return resolved;
}
