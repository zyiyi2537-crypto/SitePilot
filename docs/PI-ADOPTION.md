# Pi Agent Adoption Decision

## Source reviewed

- Project: `earendil-works/pi`
- Revision reviewed: `a276dabe57911253350bffb93cb7d7aff6a73261`
- License: MIT (`LICENSE`)
- Local source checkout: `/home/yingyu/agent/pi-agent`; its source remains outside the SitePilot product tree.
- Packages reviewed: `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and experimental `@earendil-works/pi-durable`.

## Reuse decision

SitePilot adopts Pi as the planned agent-loop foundation, not the Pi coding-agent CLI as the product. The current SitePilot implementation has not imported Pi packages and does not yet run model-directed multi-agent roles. Existing role labels, deterministic orchestration, and durable tool journal are groundwork, not evidence of independent collaborating agents.

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

## Integration order

1. Add pinned `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` dependencies; adapt Studio's selected provider/model into Pi's model API and retain an OpenAI-compatible fallback only where required.
2. Give each SitePilot business role a Pi `Agent` instance, but expose only role-specific tools that call through SitePilot's `ToolRuntime`, L0/L1/L2 grants, source allowlist, worktree policy and audit journal. Pi's generic filesystem and shell tools stay unavailable.
3. Replace deterministic role hand-offs incrementally: Architect first, then Research/Content in read-only parallel, then Coding behind a scoped grant, then independent QA and Review. Every hand-off is a versioned artifact, not shared chat history.
4. Add checkpointed tasks and joins using Pi durable only after its experimental API passes a compatibility/upgrade review. Keep SitePilot's store and permission model authoritative; interrupted side effects require SitePilot replay policy and reviewer identity.
5. Prove different next-action paths across missing evidence, incompatible component, and QA failure cases. Until those tests pass, describe the pipeline as deterministic orchestration, not completed multi-agent collaboration.

Do not copy the monorepo or coding-agent CLI. Pin package versions and source revision, build and license-check them, then run security and workflow tests before enabling a role in Studio.
