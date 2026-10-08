import { PolicyError } from "./core.js";
import { BlockRegistry } from "./registry.js";

const KIND_BY_BLOCK = new Map([
  ["Hero", "hero"],
  ["ProductGrid", "product-grid"],
  ["CaseGrid", "case-grid"],
  ["FeatureGrid", "feature-grid"],
  ["Pricing", "pricing"],
  ["FAQ", "faq"],
  ["ContactForm", "contact-form"],
  ["TechnicalProof", "technical-proof"],
  ["ContentGrid", "content-grid"],
  ["CTA", "cta"],
]);

function blockName(value) {
  return typeof value === "string" ? value : value?.name;
}

export function planComponents({ strategy, evidence = [], registry = new BlockRegistry(), projectId } = {}) {
  if (!strategy || typeof strategy !== "object") throw new PolicyError("A strategy is required", "INVALID_INPUT");
  if (!Array.isArray(evidence)) throw new PolicyError("Component evidence must be an array", "INVALID_INPUT");
  const byPath = new Map(evidence.map((item) => [`${item.repository}:${item.path}`, item]));
  const components = (strategy.blocks || []).map((value) => {
    const name = blockName(value);
    const kind = KIND_BY_BLOCK.get(name) || name?.toLowerCase().replaceAll(" ", "-");
    const match = [...byPath.values()].find((item) => item.componentName === name || item.kind === kind);
    if (!match) return { name, kind, status: "missing_evidence", evidenceRequired: true };
    if (!match.licenseReference) return { name, kind, status: "license_missing", evidenceId: match.evidenceId };
    const block = registry.register({
      name, kind, repository: match.repository, commit: match.commit, path: match.path,
      license: match.licenseReference, sourceRefs: [match.evidenceId],
      supportedLocales: strategy.locales || ["zh-CN", "en"],
      targetStacks: ["nextjs-payload"], tests: match.tests || [],
      compatibility: { notes: match.compatibilityNotes || [], projectId: projectId || null },
    });
    return { name, kind, status: "candidate", blockId: block.id, evidenceId: match.evidenceId };
  });
  return Object.freeze({
    registryVersion: registry.version,
    projectId: projectId || null,
    components: Object.freeze(components),
    requiresReview: components.some((component) => component.status !== "candidate"),
    manifest: registry.manifest(),
  });
}
