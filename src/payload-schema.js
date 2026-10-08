import { PolicyError } from "./core.js";

const COLLECTIONS = new Set(["pages", "products", "cases", "forms"]);
const LOCALES = new Set(["zh-CN", "en", "en-US", "ja", "de", "fr"]);
const PAGE_FIELDS = ["slug", "title", "hero", "blocks", "seo", "status"];

function unique(values) {
  return [...new Set(values)];
}

function field(name, type, required = false) {
  return { name, type, required };
}

function collection(name, fields) {
  return { name, fields: fields.map(([fieldName, type, required]) => field(fieldName, type, required)) };
}

export function planPayloadSchema({ strategy, locales, projectId } = {}) {
  if (!strategy || typeof strategy !== "object") {
    throw new PolicyError("A frozen website strategy is required", "INVALID_INPUT");
  }
  const selectedLocales = unique(locales || strategy.locales || ["zh-CN", "en"]);
  if (!selectedLocales.length || selectedLocales.some((locale) => !LOCALES.has(locale))) {
    throw new PolicyError("Strategy contains an unsupported locale", "POLICY_DENIED");
  }
  const hierarchy = Array.isArray(strategy.pageHierarchy) ? strategy.pageHierarchy : [];
  const blocks = Array.isArray(strategy.blocks) ? strategy.blocks : [];
  const collections = [
    collection("pages", [
      ["slug", "text", true], ["title", "text", true], ["hero", "group"],
      ["blocks", "blocks"], ["seo", "group"], ["status", "select", true],
    ]),
  ];
  if (hierarchy.includes("products") || blocks.includes("ProductGrid")) {
    collections.push(collection("products", [
      ["slug", "text", true], ["name", "text", true], ["summary", "textarea"],
      ["features", "array"], ["media", "upload"], ["seo", "group"],
    ]));
  }
  if (hierarchy.includes("cases") || blocks.includes("CaseGrid")) {
    collections.push(collection("cases", [
      ["slug", "text", true], ["title", "text", true], ["customer", "text"],
      ["challenge", "textarea"], ["result", "textarea"], ["media", "upload"],
    ]));
  }
  collections.push(collection("forms", [
    ["name", "text", true], ["fields", "array", true], ["recipientRef", "text", true],
    ["consentText", "textarea", true],
  ]));
  return Object.freeze({
    schemaVersion: "payload-schema-v1",
    projectId: projectId || null,
    locales: selectedLocales,
    collections: Object.freeze(collections),
    globals: Object.freeze([
      { name: "navigation", fields: ["items", "footerItems"] },
      { name: "siteSettings", fields: ["siteName", "logo", "defaultSeo", "socialLinks"] },
    ]),
    rules: Object.freeze({
      draftOnly: true,
      publishAllowed: false,
      secretFieldsAllowed: false,
      requiredPageFields: PAGE_FIELDS.filter((name) => name !== "status"),
    }),
  });
}
