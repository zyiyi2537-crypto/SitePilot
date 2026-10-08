# Pi Agent Adoption Decision

## Source reviewed

- Project: `earendil-works/pi`
- Revision reviewed: `a276dabe57911253350bffb93cb7d7aff6a73261`
- License: MIT (`LICENSE`)
- Local review checkout: temporary `/tmp/pi-agent-source`; it is not copied into the SitePilot product tree.

## Reuse decision

SitePilot should reuse Pi's general agent-runtime principles, not embed the Pi coding-agent CLI as the product runtime.

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

1. Add a durable tool-intent journal to `ToolRuntime` and recover interrupted actions only through `resumeInterrupted`: safe tools require a new run/idempotency key plus reviewer identity; unsafe tools remain blocked.
2. Add checkpointed role tasks and join policies to the existing `DeliveryOrchestrator`.
3. Add a provider adapter only after the deterministic fixture workflow passes.
4. Consider `@earendil-works/pi-agent-core`/`pi-durable` as pinned dependencies only after a TypeScript build and license/lockfile review. Do not copy the whole monorepo or the coding-agent CLI.
