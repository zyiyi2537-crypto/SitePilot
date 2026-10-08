# V0 Implementation Notes

## Current flow

`createProject` -> `createRun` -> role tasks -> `createCandidate` -> `markQuality` -> `packageReview`.

The V0 HTTP server exposes `POST /projects`, `POST /projects/:id/runs`, `POST /runs/:id/candidates`, and reviewer-only `POST /candidates/:id/review`. It does not expose a quality-decision route: QA outcomes must be written by the internal orchestrator, not claimed by a client. The API requires distinct operator and reviewer bearer tokens; no route publishes production or moves a delivery pointer.

`CandidateRevision` is the mutable-workflow boundary. Code and CMS changes create candidates; a `DraftVersion` is created only by `packageReview` after quality and review gates pass. The default in-memory store is a V0 executable specification; `src/persistence.js` provides an opt-in JSON durable store for local recovery.

`src/orchestrator.js` composes the adapters into the guarded delivery sequence. Build failure stops before CMS/QA; QA failure leaves the candidate failed; only an explicit reviewer decision can create a DraftVersion.

`src/registry.js` implements the Block Registry boundary. CodeAtlas results begin as candidates and cannot be selected for a project until a reviewer verifies the license and tests. `src/tool-runtime.js` provides the common tool envelope, timeout, idempotency, policy version and replay record used by the multi-agent runtime.

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
