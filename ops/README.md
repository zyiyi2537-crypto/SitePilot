# SitePilot Deployment

The Compose deployment is the preferred single-host path. It publishes only on `127.0.0.1`, keeps application state in named volumes, and runs the container with a read-only root filesystem and dropped Linux capabilities.

From a checked-out SitePilot copy:

```bash
cp ops/sitepilot.env.example ops/sitepilot.env
${EDITOR:-vi} ops/sitepilot.env
set -a
. ops/sitepilot.env
set +a
npm run deploy:check
docker compose -f compose.yaml config
docker compose -f compose.yaml up --build -d
curl -fsS http://127.0.0.1:3100/health
```

Keep `ops/sitepilot.env` out of Git and backups accessible to application users. Compose persists the project store, component registry, evidence store, worktrees, and quarantine files. Back up consistently before upgrades; stop the service during a file-level backup. Restore by stopping Compose, restoring the named volumes, then starting it again.

Use `SITEPILOT_NODE_IMAGE` with a reviewed Node 24 image digest for release deployments. The default tag is for local smoke testing and is mutable. `docker compose config` validates Compose expansion but does not verify upstream image provenance.

The included Nginx file is a local-only example. Before public exposure, install a TLS vhost, enforce request rate limits, and verify firewall rules. Do not expose port 3100 directly.

This deploys only a single-instance SitePilot control plane. Compose persists project, evidence, registry, and L2 grant state in SQLite. Do not run multiple API processes or treat this as high availability; the current in-memory state cache still requires one writer. Existing JSON deployments need an explicit data migration before switching to this Compose configuration. On a 2 GB-class server, keep builds and browser QA on a separately measured worker.

Set distinct random values of at least 32 characters for `SITEPILOT_API_TOKEN`, `SITEPILOT_REVIEW_TOKEN`, and `SITEPILOT_L2_TOKEN`, plus a server-owned `SITEPILOT_REVIEWER_ID`. `npm run deploy:check` rejects missing, weak, shared, or inconsistent integration configuration without printing credentials. Never place reviewer or L2 tokens in the browser or Agent environment. The L2 token is a temporary service credential for local code generation, not the project-scoped expiring grant model required by the PRD for multi-tenant production use.

Leave all three `CODEATLAS_*` values empty when starting only the control plane; configure URL, token, and repository allowlist together before enabling live retrieval. Compose caps the API container at 384 MB and does not run Payload builds or browser QA.

Docker is not installed in the current local development environment, so the Compose image and runtime have not been exercised here. The existing `ops/install.sh` and systemd deployment remain available for hosts that do not use Compose; populate both registry/evidence paths in the environment file before using that route.
