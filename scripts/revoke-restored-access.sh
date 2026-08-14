#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

readonly compose_file="${COMPOSE_FILE:-compose.yaml}"
[[ -f "$compose_file" ]] || { echo "STROIOS_RESTORE_ERROR compose_file_missing" >&2; exit 78; }

app_container="$(docker compose -f "$compose_file" ps -q app 2>/dev/null || true)"
if [[ -n "$app_container" ]] && [[ "$(docker inspect -f '{{.State.Running}}' "$app_container" 2>/dev/null || true)" == "true" ]]; then
  echo "STROIOS_RESTORE_ERROR stop_app_before_access_revocation" >&2
  exit 75
fi

docker compose -f "$compose_file" run --rm --no-deps app node server/revoke-restored-access.js
