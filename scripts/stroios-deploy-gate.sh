#!/usr/bin/env bash
set -Eeuo pipefail

original_command="${SSH_ORIGINAL_COMMAND:-}"
if [[ ! "$original_command" =~ ^deploy[[:space:]]([0-9a-f]{40})$ ]]; then
  echo "Only a pinned StroiOS deployment is allowed." >&2
  exit 77
fi

printf '%s\n' "${BASH_REMATCH[1]}" | exec sudo -n /usr/local/sbin/stroios-deploy
