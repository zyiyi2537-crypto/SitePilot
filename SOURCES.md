# Pinned Sources

## Payload Website Template

- Repository: `payloadcms/payload`
- Template path: `templates/website`
- Commit: `31ba7ee8271998ad7aa8963111764cbacf37b157`
- Source URL: https://github.com/payloadcms/payload/tree/31ba7ee8271998ad7aa8963111764cbacf37b157/templates/website
- License: MIT, as declared by `templates/website/package.json` and the repository `LICENSE.md` at the pinned commit.
- Usage boundary: SitePilot may fetch this exact revision into a quarantined source snapshot. It must not follow the moving `main` branch or copy an unpinned revision. The selected build scope contains `templates/website`, `packages/`, the root pnpm workspace/lock files, Node version files, and `LICENSE.md`; unrelated repository content is excluded.
- Lock file: `sources/payload-website.lock.json`. The scoped source contains 4,881 files (26,606,826 bytes), with source tree SHA-256 `cc9d4f3a467982758a7ebd2af936a2804583726fde96b35d8ee83a3f0c974f6c`, archive SHA-256 `86a25c8fd25436f0d46f4986b52552c4dd83298515934dc3ff9a75ce70a0953e`, and template content manifest SHA-256 `8c04604e142e9f6655d233aac2d37df600a7809897076757a51046521f58caae`. The template source is verified, but has not yet been installed, built, QA-tested, or previewed.

The template package identifies itself as `Website template for Payload` and provides the Payload configuration, admin panel, content collections, layout builder, SEO, search, redirects, drafts, and preview capabilities used as the CMS baseline.

## Pi Agent Runtime

- Repository: `earendil-works/pi`
- Revision reviewed: `a276dabe57911253350bffb93cb7d7aff6a73261`
- License: MIT (`LICENSE`)
- Reviewed packages: `packages/agent`, `packages/durable`, `packages/protocol`, `packages/ai`
- Usage: architecture reference only at this stage; no Pi source is copied into the product and no Pi dependency is installed yet.
- Adopted ideas: durable tool intent, replay policy, checkpointed task graph, immutable entries, atomic commits and event streaming. See `docs/PI-ADOPTION.md`.
