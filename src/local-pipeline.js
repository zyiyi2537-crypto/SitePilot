import { PolicyError } from "./core.js";
import { planComponents } from "./component-planner.js";
import { composePagePlan } from "./page-composer.js";
import { materializePagePlan } from "./code-generator.js";
import { researchComponents } from "./research-agent.js";
import { validateGeneratedCandidate } from "./local-build.js";

export async function runLocalCodePipeline({ strategy, adapter, registry, worktree, worktreeRoot, projectId, runId, repository, expectedCommit, grant } = {}) {
  if (!strategy || !adapter || !registry || !worktree) throw new PolicyError("Local pipeline dependencies are required", "CONFIG_REQUIRED");
  const research = await researchComponents({ strategy, adapter, registry, projectId, repository, expectedCommit });
  if (research.componentPlan.requiresReview) {
    return Object.freeze({ status: "needs_review", research });
  }
  const pagePlan = composePagePlan({ strategy, registry, projectId, runId });
  const generated = await materializePagePlan({ plan: pagePlan, worktree, grant });
  const build = await validateGeneratedCandidate({ worktreeRoot: worktreeRoot || worktree.root });
  return Object.freeze({ status: "generated", research, pagePlan, generated, build });
}
