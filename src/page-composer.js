import crypto from "node:crypto";

import { PolicyError } from "./core.js";

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;

function pageName(value) {
  if (typeof value !== "string" || !SAFE_NAME.test(value)) {
    throw new PolicyError(`Invalid page name: ${value || "missing"}`, "INVALID_INPUT");
  }
  return value;
}

export function composePagePlan({ strategy, registry, projectId, runId } = {}) {
  if (!strategy || !registry) throw new PolicyError("Strategy and block registry are required", "CONFIG_REQUIRED");
  const pages = Array.isArray(strategy.pageHierarchy) ? strategy.pageHierarchy : [];
  if (new Set(pages).size !== pages.length) throw new PolicyError("Page hierarchy contains duplicate pages", "INVALID_INPUT");
  const blockNames = (strategy.blocks || []).map((value) => typeof value === "string" ? value : value?.name);
  const approved = registry.select({ locales: strategy.locales || [] });
  const byName = new Map(approved.map((block) => [block.name, block]));
  const missing = blockNames.filter((name) => !byName.has(name));
  if (missing.length) {
    throw new PolicyError(`Strategy blocks are not approved: ${missing.join(", ")}`, "COMPONENTS_NOT_APPROVED");
  }
  const routes = pages.map((page) => {
    const name = pageName(page);
    return {
      page: name,
      route: name === "home" ? "/" : `/${name}`,
      file: name === "home" ? "src/app/(frontend)/page.tsx" : `src/app/(frontend)/${name}/page.tsx`,
      components: blockNames.map((blockName) => ({
        name: blockName,
        registryId: byName.get(blockName).id,
        source: {
          repository: byName.get(blockName).repository,
          commit: byName.get(blockName).commit,
          path: byName.get(blockName).path,
        },
      })),
    };
  });
  const plan = {
    planVersion: "page-plan-v1",
    projectId: projectId || null,
    runId: runId || null,
    routes,
    files: routes.map((route) => route.file),
    sourceManifestHash: crypto.createHash("sha256").update(JSON.stringify(routes)).digest("hex"),
    writesAllowed: false,
  };
  return Object.freeze(plan);
}
