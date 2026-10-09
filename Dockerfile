ARG NODE_IMAGE=node:24-alpine
FROM ${NODE_IMAGE}

ENV NODE_ENV=production \
    PORT=3100 \
    SITEPILOT_HOST=0.0.0.0 \
    SITEPILOT_STATE_FILE=/var/lib/sitepilot/state.json \
    SITEPILOT_REGISTRY_FILE=/var/lib/sitepilot/registry.json \
    SITEPILOT_EVIDENCE_FILE=/var/lib/sitepilot/evidence.json \
    SITEPILOT_WORKTREE_ROOT=/var/lib/sitepilot-worktrees \
    SITEPILOT_QUARANTINE_ROOT=/var/lib/sitepilot-quarantine

WORKDIR /app
RUN mkdir -p /var/lib/sitepilot /var/lib/sitepilot-worktrees /var/lib/sitepilot-quarantine \
    && chown -R node:node /var/lib/sitepilot /var/lib/sitepilot-worktrees /var/lib/sitepilot-quarantine
COPY --chown=node:node package.json package-lock.json README.md ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --chown=node:node src ./src
USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:3100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
