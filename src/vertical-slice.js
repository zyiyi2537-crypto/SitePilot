import { EvidenceStore } from "./evidence.js";
import { BlockRegistry } from "./registry.js";

export function buildIndustrialSlice({ projectId, evidence = new EvidenceStore(), registry = new BlockRegistry(), codeEvidence = [] } = {}) {
  const sources = [
    { name: "company.md", content: "Company: 澄岳流体设备\nGoal: technical consultation\nLanguages: zh-CN, en", kind: "client" },
    { name: "products.md", content: "CY-P01 pump; CY-V02 valve; no unsupported specifications", kind: "client" },
    { name: "terminology.md", content: "技术咨询 = Technical consultation; 流量控制 = Flow control", kind: "client" },
  ].map((input) => evidence.registerSource({ projectId, version: "1", ...input }));
  const records = sources.map((source) => evidence.addRecord({ sourceId: source.id, sourceType: "client", locator: "document:full", quote: source.name === "company.md" ? "Goal: technical consultation" : source.name === "products.md" ? "CY-P01 pump; CY-V02 valve" : "技术咨询 = Technical consultation", allowedClaims: ["site.strategy"] }));
  const claim = evidence.createClaim({ projectId, statement: "The site should prioritize bilingual technical consultation requests for a pump and valve catalog", evidenceIds: records.map((record) => record.id) });
  const blocks = [
    ["Hero", "hero", "src/components/Hero/index.tsx"],
    ["ProductGrid", "product-grid", "src/blocks/ProductGrid"],
    ["ContactForm", "contact-form", "src/blocks/ContactForm"],
  ].map(([name, kind, path], index) => registry.register({ name, kind, repository: codeEvidence[index]?.repository || "sitepilot-authored", commit: codeEvidence[index]?.commit || "0000000000000000000000000000000000000000", path, license: codeEvidence[index]?.licenseReference || "review-required", state: codeEvidence[index] ? "candidate" : "candidate", supportedLocales: ["zh-CN", "en"], targetStacks: ["nextjs-payload"] }));
  const strategy = {
    strategy: "industrial-leadgen",
    audience: ["procurement", "process-engineers"],
    primaryConversion: "technical-consultation",
    pageHierarchy: ["home", "products", "product-detail", "contact"],
    contentModel: ["product", "application", "contactRequest"],
    blocks: blocks.map((block) => block.name),
    locales: ["zh-CN", "en"],
    forbiddenClaims: ["certifications", "pressure-ranges", "delivery-times", "customer-names"],
    evidenceRefs: [claim.id],
    openQuestions: ["certification evidence", "missing pressure ranges", "contact recipient and SLA"],
  };
  return { sources, records, claim, blocks, strategy, registryManifest: registry.manifest(), evidenceSnapshot: evidence.snapshot(projectId) };
}
