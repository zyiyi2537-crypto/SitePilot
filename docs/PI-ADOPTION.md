# Pi Agent Adoption Decision

## Source reviewed

- Project: `earendil-works/pi`
- Revision reviewed: `a276dabe57911253350bffb93cb7d7aff6a73261`
- License: MIT (`LICENSE`)
- Local source checkout: `/home/yingyu/agent/pi-agent`; its source remains outside the SitePilot product tree.
- Packages reviewed: `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and experimental `@earendil-works/pi-durable`.

## Reuse decision

SitePilot uses Pi as its agent-loop foundation, not the Pi coding-agent CLI as the product. The pinned `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` packages now power the first model-directed workflow: `Supervisor → Architect → Research → Supervisor`. Studio model settings are adapted in memory; each role receives only its allowlisted SitePilot tools, and outputs are stored as typed artifacts.

The Supervisor now also dispatches a bounded ContentCMS drafting stage after strategy, research, PagePlan, DesignDraft, and a successful candidate build exist. ContentCMS reads only the `pages` schema and returns a proposed ContentModel bound to candidate/design/page-plan hashes; server validation limits pages and fields and checks Claim IDs against active client evidence. Missing facts stop for customer input. This stage runs at L0 and does not expose the L1 Payload writer. A separate reviewer-authenticated server approval binds the exact ContentModel hash to the candidate and design hashes; Payload rejects changed content or missing approval. Coding, QA and Review are still not dispatched by Pi. Automated workflow tests use Pi's faux provider. A successful live-provider multi-role run has not yet been recorded.

Adopted principles:

- Agent loop emits durable lifecycle events and treats assistant/tool-result ordering as a barrier.
- Tool execution commits intent and replay policy before running side effects.
- Safe tools may be replayed after recovery; unsafe tools become interrupted and require a new decision.
- Long-running work is represented as tasks with checkpoints, ownership, joins and resumable state.
- Extensions/tools are installed through a registry instead of hard-coded role branches.
- Durable entries and atomic commits separate persisted state from transient UI output.

SitePilot-specific boundaries remain authoritative:

- Pi does not provide a permission boundary. SitePilot keeps its own L0/L1/L2 policy, CodeAtlas repository allowlist, Payload sandbox, Docker isolation, path policy and reviewer gate.
- Pi's generic `bash`, `write` and `edit` tools cannot be exposed directly to the Agent; they must be wrapped by SitePilot's worktree and sandbox adapters.
- Pi's sub-agent omission is acceptable: SitePilot roles are structured tasks with explicit artifacts, not unrestricted agent-to-agent access.

## Integration status and next steps

1. Done: pinned the Pi dependencies and adapted Studio's selected provider/model into Pi's model APIs for Chat Completions and Responses mode.
2. Done for the first slice: role tools call through SitePilot's `ToolRuntime`; the Supervisor runs at L0, CodeAtlas is bound to an allowlisted repository and fixed commit, and generic filesystem/shell tools remain unavailable.
3. In progress: harden the ContentCMS draft-to-review-to-Payload transition, including server-verifiable human confirmation, then connect Coding only through the scoped project worktree; attach independent QA and Review afterward.
4. Deferred: use Pi durable tasks only after its experimental API passes compatibility and upgrade review. SitePilot's store and replay policy remain authoritative.
5. Current tests cover missing CodeAtlas input, role-tool rejection and a successful Supervisor→Architect→Research workflow with the faux provider. Add incompatible-source, model-failure, restart/recovery and live-provider evidence before enabling write-capable roles.

The Pi monorepo and coding-agent CLI are not copied into SitePilot. Package versions are pinned; future upgrades require source/license review plus security and workflow tests before enabling additional roles in Studio.
