# V0 Implementation Notes

## Pi multi-agent runtime status

`@earendil-works/pi-agent-core@1.0.0` and `@earendil-works/pi-ai@1.0.0` are pinned MIT dependencies. `src/agent-runtime.js` adapts SitePilot's in-memory model configuration to Pi's `Agent` and OpenAI-compatible provider APIs. Pi is not exposed as a CLI and its generic filesystem/shell tools are not registered.

`src/agent-roles.js` defines role policy and artifact types. `src/agent-tools.js` converts only allowlisted SitePilot tools into Pi tools and requires a run-scoped context. `src/agent-supervisor.js` implements the first dynamic loop: a Supervisor can delegate Architect, delegate Research against a server-frozen CodeAtlas repository/commit, ask for customer input, or complete the strategy/research stage. `SitePilotStore` persists artifacts and agent events; JSON and SQLite stores include the artifact collection.

Architect's bounded optional `designTokens` now travels with the model-generated strategy. When Studio creates the first DesignDraft without an override, the server carries those tokens into the immutable draft. Omitted groups use deterministic defaults; invalid colors, spacing, typography, or unknown token keys are rejected.

This is the first real Pi-backed slice, not the complete delivery system. ContentCMS, Coding, QA and Review still use the existing guarded adapters and will be attached to the supervisor in later iterations. The acceptance tests must prove a missing-input path, an incompatible/rejected tool path, and a successful Supervisor→Architect→Research path before enabling code-writing roles.

Natural-language intake uses an OpenAI-compatible adapter in src/intake.js, supporting both Chat Completions and Responses API. Studio can configure and test URL/model/key; interactive credentials are held only in process memory and are never returned to the browser or persisted. Environment configuration remains available for managed installs, including a bounded 60-second default model timeout (`SITEPILOT_MODEL_TIMEOUT_MS`). POST /intake/preview returns a validated RequirementBrief without creating a project; quotes must be supported by the original request. The preview is held in server memory for 15 minutes, and POST /intake/confirm creates the project and Run only after confirmation. Intake confirmation still seeds a deterministic baseline strategy; the separate Pi Supervisor action can replace it with a model-generated SiteStrategy and request CodeAtlas research.

## PRD anchor

The first executable delivery slice followed **PRD Draft 0.6 (2026-10-10)**. Draft 0.7 extended the product target with the natural-language-to-design-draft-to-preview-feedback creation path; Draft 0.9 clarified the Pi Supervisor and specialist-agent boundary. Draft 1.0 records the first implemented Pi-backed creation workflow. The validated natural-language intake, Supervisor→Architect→Research loop, immutable DesignDraft/CanvasPatch slice, and a safe visual design-preview surface are implemented. The visual surface is an isolated, read-only direction preview; it must not be described as the real Payload candidate preview. Public customer preview, model-generated visual design, write-capable Pi roles and maintenance mode remain roadmap work.

Current evidence covers the guarded SitePilot workflow, CodeAtlas read-only adapter, source/worktree controls, immutable design drafts with schema-constrained CanvasPatch versions, Payload draft/build adapters, synthetic Payload CI preview, a real Responses API intake check against the locally configured test provider, and faux-provider tests of the Pi agent loop and dynamic role delegation. It does not yet prove a successful live-provider multi-role run, Puck canvas integration, persistent public preview URL, or GitHub Issue/PostHog maintenance loop.

## Current flow

`createProject` -> `createRun` -> role tasks -> `createCandidate` -> `markQuality` -> `packageReview`.

The creation-mode design slice adds `page-plan` -> `POST /runs/:id/design-drafts` -> isolated Studio direction preview -> `POST /design-drafts/:id/patches`. Each design revision is immutable, stores a design hash and parent, and is retained by the run. Patches accept only bounded `set_props`, `replace_props`, and `move` operations against approved page-plan components; stale hashes, cross-run parents, executable markup, and unknown components fail closed. Studio renders the current page with the same registered component names, bounded design tokens, and responsive desktop/tablet/mobile frames. Customer-controlled text is escaped, the preview is loaded in a sandboxed iframe without scripts or form submission, and no external component code is executed. Candidate creation records the current `designDraftId`, so later Payload/code work can bind to the exact design revision. Generated manifests, Payload sandbox receipts, and the local candidate preview all carry the same design hash.

After a generated candidate passes the manifest/build gate, `POST /candidates/:id/preview` starts a read-only localhost preview from that candidate's server-owned worktree. The endpoint validates the manifest, source hash, and design hash before returning a 15-minute session URL; repeated calls reuse the live session and `DELETE /previews/:sessionId` closes it. Preview sessions are process-local and are never persisted or exposed as public/Payload delivery URLs.

`POST /candidates/:id/payload-plan` is the read-only CMS boundary before `POST /candidates/:id/payload-draft`: it accepts only explicit per-page content and Claim references, invokes the pinned Website Template schema planner, and returns draft operations tagged with the candidate's design revision. Missing content and unsupported template blocks fail with `422`; no CMS write occurs in this step.

`POST /candidates/:id/payload-draft` now accepts the same `contentByPage` input and internally carries the planner result into the Payload sandbox adapter. It requires the code build gate, sends the candidate hash and design hash with the sandbox request, and creates an immutable child CandidateRevision containing the CMS snapshot receipt. Replays with the same idempotency key reuse that child; the parent candidate is retained as superseded and is never used for QA. Explicit pre-planned operations remain supported for the internal orchestrator, but also produce a CMS child revision.

The Studio client exposes the guarded vertical slice: reviewer and L2 credentials are requested only for candidate generation, while API credentials are used for sandbox draft, local preview and QA calls. A local preview session is registered temporarily with the Playwright QA adapter and removed when the preview is closed or expires. The Studio does not expose production publishing or a public preview URL.

Design feedback after a candidate now supports a child candidate: the new immutable `DesignDraft` is generated in its own server-derived `worktreeRoot/runId/designDraftId`, and the new `CandidateRevision.parentId` references the preceding candidate. Existing candidates and their preview sessions are retained. Re-generating against the same design revision is rejected, and reviewer grants bind to the exact revision worktree.

The V0 HTTP server exposes `POST /projects`, `POST /projects/:id/runs`, `POST /runs/:id/candidates`, and reviewer-only `POST /candidates/:id/review`. It does not expose a quality-decision route: QA outcomes must be written by the internal orchestrator, not claimed by a client. The API requires distinct operator and reviewer bearer tokens; no route publishes production or moves a delivery pointer.

`CandidateRevision` is the mutable-workflow boundary. Code and CMS changes create candidates; a `DraftVersion` is created only by `packageReview` after quality and review gates pass. The default in-memory store is a V0 executable specification; `src/persistence.js` provides an opt-in JSON durable store for local recovery.

`src/orchestrator.js` remains the guarded deterministic delivery sequence used by the existing adapter workflow. The new Pi-backed Supervisor path is exposed separately at `POST /runs/:id/agent`; only Supervisor, Architect and read-only Research are dispatched there so far. Build failure stops before CMS/QA; QA failure leaves the candidate failed; only an explicit reviewer decision can create a DraftVersion.

`src/registry.js` implements the Block Registry boundary. CodeAtlas results begin as candidates and cannot be selected for a project until a reviewer verifies the license and tests. Pi role tools call through `src/tool-runtime.js`, which enforces tool envelopes, timeouts, idempotency, policy versions and replay records. The tool journal path is derived from durable state unless `SITEPILOT_TOOL_JOURNAL_PATH` is explicitly set; explicit paths must be absolute.

`src/evidence.js` implements the content evidence chain: source snapshots are content-hashed and versioned, replacing a source expires its evidence records, and claims referencing expired evidence become `needs_reconfirmation` instead of silently remaining approved.

`JsonToolJournal` in `src/tool-runtime.js` persists tool intent before a handler runs and settles the same record after completion. On process recovery, `intent_committed` and `running` records become `interrupted`. The normal idempotency key cannot silently retry them. `resumeInterrupted` requires a new idempotency key, agent run ID, input, and reviewer identity; only records explicitly marked `replay: "safe"` can use it. This keeps unsafe CMS, filesystem, and deployment operations behind a fresh reviewed decision.

The API exposes the protected evidence workflow through `POST /projects/:id/sources`, `POST /sources/:id/records`, and `POST /projects/:id/claims`. These endpoints accept source material and citations only; they do not grant CodeAtlas write access or turn unsupported claims into facts.

## Adapter contracts to implement next

### CodeAtlasMcpAdapter

Input: project repository allowlist, query, source type, and frozen commit. Output: repository, commit, path, locator, license reference, index status, and compatibility notes. It must reject an active-index result whose commit does not match the frozen source snapshot.

The implementation is in `src/codeatlas.js`. Production configuration is supplied at process start and never persisted:

- `CODEATLAS_MCP_URL`: the CodeAtlas `/mcp` endpoint.
- `CODEATLAS_MCP_TOKEN`: a read-only bearer token; do not place it in project files.
- `CODEATLAS_REPOSITORIES`: comma-separated opaque repository IDs from `list_repositories` allowed for the run (not display names).

The HTTP transport uses MCP `initialize` and `tools/call`; the fixture transport is only for deterministic tests. Search and file reads fail closed unless the result contains the requested full 40-character commit SHA.

### PinnedSourceFetcher

Input: repository ID, full commit SHA, source evidence ID, size limit, and L2 grant. Output: immutable quarantine snapshot, verified HEAD, file manifest hash, and content hash. It must not accept arbitrary model URLs, branch names, submodules, Git hooks, LFS, symlinks, or host paths.

The V0 implementation is in `src/source-fetcher.js`. `createPinnedSourceFetcher()` in `src/pinned-sources.js` derives the Payload repository, commit, include paths, and expected tree/archive hashes from the checked-in source lock. The request cannot provide a URL, branch, or broader source scope. The fetcher creates a temporary Git snapshot, verifies `FETCH_HEAD` against the requested SHA, rejects unsafe tree entries, enforces a cumulative size limit, checks both lock hashes, and returns hashes without exposing a host path to the model.

`sources/payload-website.lock.json` is the checked-in source lock for the Payload baseline. The Payload template depends on `workspace:*`, so the pinned snapshot includes the template, Payload `packages/`, root workspace manifest and lockfile, and Node version files. The scoped tree is about 26.6 MB and excludes unrelated repository content. A pending or hash-mismatched snapshot blocks preview generation.

`src/template-verifier.js` validates a fetched snapshot against that lock, including required files, package license, symlink rejection and file-level SHA-256 manifest. Worktree creation must receive its `verified: true` result; a directory listing or partial archive is insufficient.

### PayloadSandboxAdapter

Input: candidate ID, expected CMS snapshot, page operations, and idempotency key. Output: a CMS snapshot receipt. It must never create a DraftVersion or move the delivery preview pointer.

`src/payload-adapter.js` implements the V0 boundary. It accepts only bounded page/global/media/form operations in a sandbox environment, rejects disallowed collections, locales and secret-shaped fields, and stores idempotent receipts. The backend is deliberately injected so a real Payload API client can be added without giving the Agent production credentials or promotion controls.

`PayloadHttpSandboxBackend` is the real HTTP backend. It requires an HTTPS sandbox URL and a server-side bearer token, posts only allowlisted collections as drafts, attaches the candidate/request hash, and rejects responses without a record ID. It does not expose a publish or preview-pointer operation.

### SourcePackageInspector

`src/source-inspector.js` implements the read-only `inspect_source_package` gate. It resolves only an opaque `source_*` snapshot ID under the configured quarantine root, checks LICENSE/NOTICE files, package manifests, lockfiles, scripts and binary assets, and returns a manifest hash plus a reuse mode. Missing licensing or unsafe scripts force `reference-only` until a reviewer resolves the risk.

### BuildExecutor

Input: candidate ID, worktree, approved script IDs, limits, and L2 grant. Output: build/test artifacts and logs. It runs in a non-root sandbox, with no production credentials and no network by default.

`src/build-executor.js` contains `LockedDependencyInstaller`, `BuildExecutor`, and `DockerSandboxRunner`. Install/build operations require the Docker runner, a digest-pinned image, non-root user, no network, read-only container root, dropped capabilities, no-new-privileges, and CPU/memory/process limits. Missing Docker or image configuration leaves execution unavailable. Offline package installation requires dependencies already cached in the image. Monorepo installs may use a server-configured exact pnpm workspace filter; for the Payload Website Template use `website...` so only that package and its workspace dependencies are selected.

### ProjectWorktreeManager

`src/worktree.js` implements the fixed-template portion of `create_project_worktree`. It accepts only a registered quarantine snapshot and a full template commit, derives the target directory from the server-owned root plus project/run IDs, and returns an opaque `pathRef`; it does not accept a model-supplied host path or remote Git credentials. A registered snapshot may pin sparse-checkout paths and a project subdirectory, so the Payload baseline materializes only `templates/website` plus the root `LICENSE.md` and builds from the template directory.

### QualityAdapter

Input: candidate ID and a temporary QA preview. Output: checks tied to the exact candidate hash. It must not mutate the candidate and must not promote the QA preview to a delivery preview.

`src/quality-adapter.js` implements deterministic profiles for general, industrial and SaaS sites. A missing or malformed check result fails that check; the adapter records every result against the candidate hash and always returns `deliveryPreviewMoved: false`.

## Open decisions

- Durable store: PostgreSQL or SQLite for local V0, with the same immutable entity model. The tool journal currently uses a separate atomic JSON file and should be colocated with the durable store before multi-process deployment.
- Model provider: a server-side provider adapter; no model key belongs in the browser or worktree.
- Payload Website Template: pin the selected commit and copy its license/media attribution into `SOURCES.md` before integration.
- Sandbox runner: evaluate a minimal container runner before adopting a larger coding-agent runtime.
