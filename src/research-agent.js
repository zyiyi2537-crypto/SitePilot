import { PolicyError } from "./core.js";
import { planComponents } from "./component-planner.js";

const QUERY_BY_BLOCK = new Map([
  ["Hero", "hero section component"],
  ["ProductGrid", "product grid component"],
  ["CaseGrid", "case studies grid component"],
  ["FeatureGrid", "feature grid component"],
  ["Pricing", "pricing section component"],
  ["FAQ", "FAQ accordion component"],
  ["ContactForm", "contact form component"],
  ["TechnicalProof", "technical proof component"],
  ["ContentGrid", "content grid component"],
  ["CTA", "call to action component"],
]);

export async function researchComponents({ adapter, strategy, repository, expectedCommit, registry, projectId, topK = 5 } = {}) {
  if (!adapter || typeof adapter.search !== "function") throw new PolicyError("CodeAtlas adapter is required", "CONFIG_REQUIRED");
  if (!strategy || !repository || !expectedCommit) throw new PolicyError("Strategy, repository and commit are required", "INVALID_INPUT");
  const blocks = Array.isArray(strategy.blocks) ? strategy.blocks : [];
  const evidence = [];
  const searches = [];
  for (const block of blocks) {
    const name = typeof block === "string" ? block : block?.name;
    const query = QUERY_BY_BLOCK.get(name) || `${name} component`;
    searches.push({ name, query });
    const results = await adapter.search({ query, repository, expectedCommit, topK });
    const first = results[0];
    if (first) evidence.push({ ...first, componentName: name, kind: block?.kind });
  }
  const componentPlan = planComponents({ strategy, evidence, registry, projectId });
  return Object.freeze({
    repository,
    commit: expectedCommit.toLowerCase(),
    searches,
    evidence,
    componentPlan,
  });
}
