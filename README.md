# SitePilot

SitePilot is an evidence-driven, multi-agent website delivery workflow. It creates a strategy from a client's goal, evaluates CodeAtlas source evidence, writes only to an isolated worktree, and packages a candidate only after quality and review gates.

## Local development status (2026-10)

- `/studio` provides a local customer workflow and a separate reviewer view. Enter API/reviewer credentials only on a trusted local machine; the page holds them in memory and does not persist them. L2 credentials and CodeAtlas credentials are never requested by the page. Start with `SITEPILOT_HOST=127.0.0.1 npm run serve` after configuring API credentials, then open `http://127.0.0.1:3100/studio`.
- CodeAtlas retrieval now supports bounded, line-verified pagination of its actual numbered `get_file` responses. Integration with the live index has **not** been verified in this environment because `CODEATLAS_MCP_URL` and `CODEATLAS_MCP_TOKEN` are absent. Run `npm run codeatlas:probe` with the server-side variables and approved repository list before calling this complete.
- The generated React page is a scaffold with copied, pinned source evidence, not an imported/working approved component. The generated-candidate check validates manifest/file consistency only. It is **not** a Payload build, a functional contact form, or a ready website. The pinned Payload template requires a Node 24.15+ compatible isolated build workspace; do not run unreviewed generated dependencies or build scripts on the host.
- Real Playwright QA is available via `PlaywrightPreviewAdapter` using installed `playwright-core` and a local Chrome executable. Configure `SITEPILOT_QA_PREVIEWS` as a JSON map of preview IDs to `{ "baseUrl": "http://127.0.0.1:PORT/", "candidateHash": "..." }` and `SITEPILOT_QA_ARTIFACT_ROOT` as an absolute screenshot directory. Only fixed localhost preview origins and read-only checks are accepted. The structural preview intentionally fails missing SEO/form checks; a generated site must run in a separate sandbox before delivery QA.
- Set `SITEPILOT_DB_FILE=/absolute/path/sitepilot.sqlite` for SQLite-backed projects, runs, evidence, component registry and single-use L2 grants. Do not combine it with legacy JSON file variables. SQLite currently uses Node's experimental `node:sqlite`; the tool journal remains a separate store. L2 grants expire within 15 minutes, bind project/run/tool/path/page-plan hash, and can be revoked. Production deployment is deferred.
- `PayloadBuildPipeline` now verifies the exact Payload source lock, rejects dirty or wrong-HEAD snapshots, creates a project/run Git worktree, then requires a digest-pinned Docker image with Node 24.15+ and pnpm before offline locked `website...` install and `website` build. The generic `node:24-alpine` image lacks pnpm, and the offline sandbox currently has no prepopulated pnpm store mount; a dedicated build image and controlled dependency cache are still required. A local fixed snapshot was verified and worktree creation succeeded on 2026-10-10; Docker is absent here, so no actual install/build or running Payload preview has passed. `createPayloadDraftPlan` emits only supported Website Template page/hero/layout/meta draft operations and blocks components requiring unimplemented template schema. See the dual-mode authorization and Payload build path in `docs/PRD.md`.
- Payload draft planning requires explicit page content and Claim references; it never invents customer copy. The pinned template has no localization configuration, so multi-locale draft creation is reported as a template capability gap until the schema and frontend are deliberately extended.

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

Run the dependency-free Research -> review -> code -> build-gate slice locally:

```bash
npm run local:demo
```

`local:demo` uses an explicit in-process CodeAtlas fixture and a local reviewer identity. It creates a temporary worktree, stops once for component review, then generates the page and validates `src/generated/sitepilot-manifest.json`. It does not call the network, Payload, Docker, or GitHub. Set `SITEPILOT_KEEP_LOCAL_WORKTREE=1` when inspecting the generated files after the command exits.

The production-shaped flow is assembled from the same modules: configure the read-only CodeAtlas adapter, run `researchComponents`, approve registry blocks with license and test evidence, call `runLocalCodePipeline` with an L2 grant, and only then expose the generated worktree to preview/build adapters. The pipeline now invokes the generated-candidate build gate before returning `status: "generated"`.

The API exposes `POST /runs/:id/page-plan` after component approval and `POST /runs/:id/generate` for a server-owned local candidate directory. Generation requires a separate `SITEPILOT_L2_TOKEN`; the ordinary API token cannot trigger code writes. The generated-candidate check only validates the manifest and files. It does not replace real build, browser QA, or reviewer approval, and does not mark the candidate's quality gate as passed.

The default worktree root is `/tmp/sitepilot-worktrees`. A deployment must set `SITEPILOT_WORKTREE_ROOT` to an administrator-owned absolute directory. The model cannot supply or override this path.

The API fails closed until distinct `SITEPILOT_API_TOKEN`, `SITEPILOT_REVIEW_TOKEN`, and `SITEPILOT_REVIEWER_ID` values are configured. The reviewer token is accepted only for the review route. Do not expose the API over plain HTTP outside localhost; terminate TLS at the reverse proxy.

## Safety boundary

Only project worktrees are writable. `CodeAtlas`, production repositories, remote Git, credentials, and production publishing are outside the registered tool set. A real adapter must preserve the CandidateRevision -> test preview -> quality -> review -> DraftVersion sequence in `docs/PRD.md`.

Builds and dependency installs require a Docker sandbox runner with an image pinned by digest. The pinned Payload Website Template uses `workspace:*`, so its build snapshot also contains the Payload package workspace and root lockfile. Without Docker, a configured image, and a Node 24.15+ compatible build image, those operations remain unavailable; the API does not invoke them on the host.

## Deployment Readiness

The API can persist projects/runs, component approvals, evidence, and L2 grants in SQLite. The Compose setup mounts the database in a persistent named volume and publishes the API only on `127.0.0.1`. Run `npm run deploy:check` before deployment. TLS termination and public access controls remain an operator responsibility. Storage is single-instance only; the in-memory state cache does not support concurrent API writers. See [ops/README.md](ops/README.md) for setup and backup instructions.
