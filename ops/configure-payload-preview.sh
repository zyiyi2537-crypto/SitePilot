#!/usr/bin/env bash
set -euo pipefail

runtime_root="${SITEPILOT_RUNTIME_ROOT:-/home/yingyu/agent/SitePilot-runtime}"
source_root="${SITEPILOT_PAYLOAD_SOURCE_ROOT:-$runtime_root/payload-source}"
network_name="${SITEPILOT_PAYLOAD_PREVIEW_NETWORK:-sitepilot-preview}"
image="${SITEPILOT_SANDBOX_IMAGE:-}"
lock_file="$(dirname "$0")/../sources/payload-website.lock.json"

fail() { printf 'configuration error: %s\n' "$1" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "docker CLI is not installed"
docker info >/dev/null 2>&1 || fail "docker daemon is unavailable to the current user; grant access to the Docker socket first"

test -d "$source_root/.git" || fail "pinned Payload git source is missing: $source_root"
expected_commit="$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).commit)' "$lock_file")"
actual_commit="$(git -C "$source_root" rev-parse HEAD 2>/dev/null || true)"
test "$actual_commit" = "$expected_commit" || fail "Payload source HEAD must be $expected_commit (got ${actual_commit:-missing})"

test -n "$image" || fail "SITEPILOT_SANDBOX_IMAGE must be a reviewed digest-pinned Node 24.15+ image with pnpm"
[[ "$image" =~ @sha256:[0-9a-fA-F]{64}$ ]] || fail "SITEPILOT_SANDBOX_IMAGE must end in @sha256:<64 hex chars>"

if docker network inspect "$network_name" >/dev/null 2>&1; then
  internal="$(docker network inspect --format '{{.Internal}}' "$network_name")"
  label="$(docker network inspect --format '{{index .Labels "sitepilot.preview"}}' "$network_name")"
  test "$internal" = true && test "$label" = true || fail "existing network $network_name must have Internal=true and sitepilot.preview=true"
else
  docker network create --internal --label sitepilot.preview=true "$network_name" >/dev/null
fi

mkdir -p "${SITEPILOT_WORKTREE_ROOT:-$runtime_root/worktrees}"
printf 'Payload preview prerequisites are configured.\n'
printf 'source=%s\ncommit=%s\nnetwork=%s\n' "$source_root" "$expected_commit" "$network_name"
