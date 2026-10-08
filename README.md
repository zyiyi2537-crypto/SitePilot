# SitePilot

SitePilot is an evidence-driven, multi-agent website delivery workflow. It creates a strategy from a client's goal, evaluates CodeAtlas source evidence, writes only to an isolated worktree, and packages a candidate only after quality and review gates.

## V0 status

The current vertical slice is intentionally dependency-free:

- `src/core.js` contains the project/run/task/candidate state model, strategy planner, worktree path policy, and fail-closed tool policy.
- `src/server.js` exposes project/run/candidate and reviewer-only packaging routes. Quality decisions are internal and cannot be submitted through HTTP.
- `src/registry.js` and `src/tool-runtime.js` keep reusable components reviewable and tool execution auditable.
- `docs/PI-ADOPTION.md` records the reviewed MIT Pi Agent source and the principles adopted without importing its unrestricted host tools.
- `src/cli.js` runs an industrial bilingual website scenario with a mock planner and a fixed `startup-nextjs` source reference.
- `test/core.test.js` covers strategy differentiation, candidate gates, worktree traversal protection, and L2 fail-closed behavior.

The CodeAtlas MCP adapter is now connected in `src/codeatlas.js`. Set `CODEATLAS_MCP_URL`, `CODEATLAS_MCP_TOKEN`, and a server-approved `CODEATLAS_REPOSITORIES` list at process start. The adapter is read-only and rejects evidence that is not pinned to the run's full commit SHA. Payload integration and the build executor remain gated adapters; the mock run is labelled by its `mock-planner-v0` input snapshot and must not be presented as a production website build.

## Run

```bash
npm test
npm run check
npm start
```

The default worktree root is `/tmp/sitepilot-worktrees`. A deployment must set `SITEPILOT_WORKTREE_ROOT` to an administrator-owned absolute directory. The model cannot supply or override this path.

The API fails closed until distinct `SITEPILOT_API_TOKEN`, `SITEPILOT_REVIEW_TOKEN`, and `SITEPILOT_REVIEWER_ID` values are configured. The reviewer token is accepted only for the review route. Do not expose the API over plain HTTP outside localhost; terminate TLS at the reverse proxy.

## Safety boundary

Only project worktrees are writable. `CodeAtlas`, production repositories, remote Git, credentials, and production publishing are outside the registered tool set. A real adapter must preserve the CandidateRevision -> test preview -> quality -> review -> DraftVersion sequence in `docs/PRD.md`.

Builds and dependency installs require a Docker sandbox runner with an image pinned by digest. The pinned Payload Website Template uses `workspace:*`, so its build snapshot also contains the Payload package workspace and root lockfile. Without Docker, a configured image, and a Node 24.15+ compatible build image, those operations remain unavailable; the API does not invoke them on the host.
