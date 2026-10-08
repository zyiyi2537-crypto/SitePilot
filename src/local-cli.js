import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FixtureCodeAtlasTransport, CodeAtlasMcpAdapter } from "./codeatlas.js";
import { BlockRegistry } from "./registry.js";
import { WorktreePolicy } from "./core.js";
import { runLocalCodePipeline } from "./local-pipeline.js";

const commit = "e730b6a99c77b96c835f11347231faa4f4e9f767";
const strategy = { locales: ["zh-CN", "en"], pageHierarchy: ["home"], blocks: ["Hero", "ProductGrid", "ContactForm"] };
const fixtures = Object.fromEntries(strategy.blocks.map((name) => [name, { repository: "payload", commit, path: `src/components/${name}.tsx`, license_reference: "MIT", evidenceId: `fixture-${name.toLowerCase()}` }]));
const adapter = new CodeAtlasMcpAdapter({
  repositories: ["payload"],
  transport: new FixtureCodeAtlasTransport({
    search_code: ({ query }) => {
      const normalized = query.toLowerCase().replaceAll(" ", "");
      const aliases = { ProductGrid: "productgrid", ContactForm: "contactform" };
      const block = strategy.blocks.find((name) => normalized.includes((aliases[name] || name.toLowerCase())));
      return block ? [fixtures[block]] : [];
    },
  }),
});
const registry = new BlockRegistry();
const root = await fs.mkdtemp(path.join(os.tmpdir(), "sitepilot-local-"));
const worktree = new WorktreePolicy(root);

try {
  const input = { strategy, adapter, registry, worktree, projectId: "local-demo", runId: "local-run", repository: "payload", expectedCommit: commit, grant: { level: "L2" } };
  const first = await runLocalCodePipeline(input);
  if (first.status === "needs_review") {
    for (const block of registry.blocks.values()) registry.transition(block.id, "approved", { reviewerId: "local-fixture-reviewer", licenseVerified: true, testsPassed: true });
  }
  const result = first.status === "needs_review" ? await runLocalCodePipeline({ ...input, runId: "local-run-reviewed" }) : first;
  console.log(JSON.stringify({ status: result.status, root, build: result.build, files: result.generated?.files || [] }, null, 2));
} finally {
  if (process.env.SITEPILOT_KEEP_LOCAL_WORKTREE !== "1") await fs.rm(root, { recursive: true, force: true });
}
