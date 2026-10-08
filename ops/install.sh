#!/usr/bin/env bash
set -euo pipefail
APP_DIR=${APP_DIR:-/opt/sitepilot}
STATE_DIR=/var/lib/sitepilot
WORKTREE_DIR=/var/lib/sitepilot-worktrees
QUARANTINE_DIR=/var/lib/sitepilot-quarantine
[[ "$(id -u)" == "0" ]] || { echo "Run as root" >&2; exit 1; }
id sitepilot >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin sitepilot
install -d -o sitepilot -g sitepilot -m 0750 "$APP_DIR" "$STATE_DIR" "$WORKTREE_DIR" "$QUARANTINE_DIR" /etc/sitepilot
if [[ ! -f /etc/sitepilot/sitepilot.env ]]; then install -o root -g sitepilot -m 0640 ops/sitepilot.env.example /etc/sitepilot/sitepilot.env; fi
rsync -a --delete --exclude='.git' --exclude='node_modules' ./ "$APP_DIR/"
chown -R root:sitepilot "$APP_DIR"
find "$APP_DIR" -type d -exec chmod 0750 {} +
find "$APP_DIR" -type f -exec chmod 0640 {} +
command -v node >/dev/null 2>&1 || { echo "Node.js LTS is required" >&2; exit 1; }
install -o root -g root -m 0644 ops/sitepilot.service /etc/systemd/system/sitepilot.service
systemctl daemon-reload
systemctl enable --now sitepilot
systemctl --no-pager --full status sitepilot
