#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly APP_DIR="/opt/stroios"
readonly COMPOSE_FILE="$APP_DIR/compose.yaml"
readonly BACKUP_COMMAND="/usr/local/sbin/stroios-backup"
readonly INFRA_APPROVAL_FILE="/var/lib/stroios-deploy/approved-infra.sha256"
readonly MAINTENANCE_LOCK_DIR="/run/lock/stroios"
readonly LOCK_FILE="$MAINTENANCE_LOCK_DIR/maintenance.lock"
readonly BACKUP_DIR="/var/backups/stroios"
readonly MIN_FREE_KB=5242880
readonly HEALTH_ATTEMPTS=36
readonly ROLLBACK_HEALTH_ATTEMPTS=12
readonly HEALTH_INTERVAL_SECONDS=5

IFS= read -r requested_commit || true
if [[ ! "$requested_commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "STROIOS_DEPLOY_ERROR invalid_commit" >&2
  exit 64
fi

for command in awk chmod chown curl df docker flock git grep head install mktemp mv rm sed sha256sum sleep sync tar tr; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "STROIOS_DEPLOY_ERROR missing_command:$command" >&2
    exit 69
  fi
done

install -d -o root -g root -m 0750 "$MAINTENANCE_LOCK_DIR" "$BACKUP_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "STROIOS_DEPLOY_ERROR already_running" >&2
  exit 75
fi

cd "$APP_DIR"
for abandoned_env in "$APP_DIR"/.env.deploy.* "$APP_DIR"/.env.install.*; do
  [[ -f "$abandoned_env" ]] || continue
  rm -f -- "$abandoned_env"
done
if [[ ! -f "$COMPOSE_FILE" || ! -f .env || ! -x "$BACKUP_COMMAND" ]]; then
  echo "STROIOS_DEPLOY_ERROR production_layout_invalid" >&2
  exit 78
fi
if grep -Eq "^[[:space:]]*(APP_PASSWORD|POSTGRES_PASSWORD)=['\"]?replace-with-" .env; then
  echo "STROIOS_DEPLOY_ERROR insecure_placeholder_secret" >&2
  exit 78
fi
if [[ ! -r "$INFRA_APPROVAL_FILE" ]]; then
  echo "STROIOS_DEPLOY_ERROR infrastructure_approval_missing" >&2
  exit 78
fi
if [[ "$(git symbolic-ref --quiet --short HEAD || true)" != "main" ]]; then
  echo "STROIOS_DEPLOY_ERROR main_branch_not_checked_out" >&2
  exit 78
fi
if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  echo "STROIOS_DEPLOY_ERROR worktree_not_clean" >&2
  exit 78
fi
origin_url="$(git remote get-url origin)"
case "$origin_url" in
  git@github.com:vitaliyozolin-dotcom/stroi_os.git|\
  https://github.com/vitaliyozolin-dotcom/stroi_os|\
  https://github.com/vitaliyozolin-dotcom/stroi_os.git|\
  ssh://git@github.com/vitaliyozolin-dotcom/stroi_os.git) ;;
  *) echo "STROIOS_DEPLOY_ERROR unexpected_origin" >&2; exit 78 ;;
esac

docker compose -f "$COMPOSE_FILE" config --quiet

for service in db app telegram-relay caddy; do
  container="$(docker compose -f "$COMPOSE_FILE" ps -q "$service")"
  if [[ -z "$container" || "$(docker inspect --format '{{.State.Running}}' "$container")" != "true" ]]; then
    echo "STROIOS_DEPLOY_ERROR service_not_running:$service" >&2
    exit 69
  fi
done
if ! docker compose -f "$COMPOSE_FILE" exec -T app test -w /data/files; then
  echo "STROIOS_DEPLOY_ERROR file_volume_not_writable" >&2
  exit 73
fi

require_free_space() {
  local path="$1" label="$2" available_kb
  available_kb="$(df -Pk "$path" | awk 'NR == 2 {print $4}')"
  if [[ ! "$available_kb" =~ ^[0-9]+$ || "$available_kb" -lt "$MIN_FREE_KB" ]]; then
    echo "STROIOS_DEPLOY_ERROR insufficient_space:$label" >&2
    return 1
  fi
}

release_image_is_protected() {
  local candidate_tag="$1"
  shift
  local candidate_id container container_id protected_tag protected_id
  candidate_id="$(docker image inspect "$candidate_tag" --format '{{.Id}}' 2>/dev/null || true)"
  [[ -n "$candidate_id" ]] || return 0
  while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    container_id="$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null || true)"
    [[ "$container_id" == "$candidate_id" ]] && return 0
  done < <(docker ps -aq)
  for protected_tag in "$@"; do
    protected_id="$(docker image inspect "$protected_tag" --format '{{.Id}}' 2>/dev/null || true)"
    [[ -n "$protected_id" && "$protected_id" == "$candidate_id" ]] && return 0
  done
  return 1
}

prune_release_tags() {
  local keep="${1:-6}"
  shift || true
  local tag retained=0
  while IFS= read -r tag; do
    [[ "$tag" =~ ^stroios-(runtime|app|relay):release-[0-9a-f]{12,40}$ ]] || continue
    if release_image_is_protected "$tag" "$@"; then
      continue
    fi
    retained=$((retained + 1))
    if (( retained > keep )); then
      docker image rm "$tag" >/dev/null 2>&1 || true
    fi
  done < <(docker image ls --format '{{.Repository}}:{{.Tag}}')
}

prune_release_tags_under_pressure() {
  local filesystem_path="$1"
  shift
  local available_kb index tag
  local -a release_tags=()
  prune_release_tags 6 "$@"
  available_kb="$(df -Pk "$filesystem_path" | awk 'NR == 2 {print $4}')"
  if [[ "$available_kb" =~ ^[0-9]+$ && "$available_kb" -ge "$MIN_FREE_KB" ]]; then
    return 0
  fi
  mapfile -t release_tags < <(docker image ls --format '{{.Repository}}:{{.Tag}}')
  for ((index = ${#release_tags[@]} - 1; index >= 0; index -= 1)); do
    tag="${release_tags[$index]}"
    [[ "$tag" =~ ^stroios-(runtime|app|relay):release-[0-9a-f]{12,40}$ ]] || continue
    if release_image_is_protected "$tag" "$@"; then
      continue
    fi
    docker image rm "$tag" >/dev/null 2>&1 || true
    available_kb="$(df -Pk "$filesystem_path" | awk 'NR == 2 {print $4}')"
    if [[ "$available_kb" =~ ^[0-9]+$ && "$available_kb" -ge "$MIN_FREE_KB" ]]; then
      break
    fi
  done
}

prune_abandoned_candidate_tags() {
  local tag
  while IFS= read -r tag; do
    [[ "$tag" =~ ^stroios-runtime:candidate-[0-9a-f]{40}-[0-9]+$ ]] || continue
    if release_image_is_protected "$tag"; then
      continue
    fi
    docker image rm "$tag" >/dev/null 2>&1 || true
  done < <(docker image ls --format '{{.Repository}}:{{.Tag}}')
}

prune_backup_storage() {
  env \
    BACKUP_DIR="$BACKUP_DIR" \
    COMPOSE_FILE="$COMPOSE_FILE" \
    BACKUP_MIN_FREE_KB="$MIN_FREE_KB" \
    STROIOS_MAINTENANCE_LOCK_HELD=1 \
    STROIOS_BACKUP_PRUNE_ONLY=1 \
    "$BACKUP_COMMAND" >/dev/null
}

prune_builder_cache_under_pressure() {
  local filesystem_path="$1" available_kb
  docker builder prune --force --filter until=168h >/dev/null 2>&1 || true
  available_kb="$(df -Pk "$filesystem_path" | awk 'NR == 2 {print $4}')"
  if [[ ! "$available_kb" =~ ^[0-9]+$ || "$available_kb" -lt "$MIN_FREE_KB" ]]; then
    docker builder prune --all --force >/dev/null 2>&1 || true
  fi
}

docker_root="$(docker info --format '{{.DockerRootDir}}')"
prune_abandoned_candidate_tags
prune_builder_cache_under_pressure "$docker_root"
prune_release_tags_under_pressure "$docker_root"
prune_backup_storage
require_free_space "$APP_DIR" repository
require_free_space "$BACKUP_DIR" backups
require_free_space "$docker_root" docker

previous_commit="$(git rev-parse HEAD)"
git fetch --quiet --prune origin main
target_commit="$(git rev-parse origin/main)"
if [[ "$target_commit" != "$requested_commit" ]]; then
  echo "STROIOS_DEPLOY_SUPERSEDED $requested_commit"
  exit 0
fi
if [[ "$previous_commit" != "$target_commit" ]] && \
   ! git merge-base --is-ancestor "$previous_commit" "$target_commit"; then
  echo "STROIOS_DEPLOY_ERROR non_fast_forward" >&2
  exit 78
fi
approved_compose_sha="$(sed -n 's/^compose_sha256=//p' "$INFRA_APPROVAL_FILE" | head -n 1)"
approved_caddy_sha="$(sed -n 's/^caddy_sha256=//p' "$INFRA_APPROVAL_FILE" | head -n 1)"
approved_deploy_sha="$(sed -n 's/^deploy_sha256=//p' "$INFRA_APPROVAL_FILE" | head -n 1)"
approved_backup_sha="$(sed -n 's/^backup_sha256=//p' "$INFRA_APPROVAL_FILE" | head -n 1)"
approved_gate_sha="$(sed -n 's/^gate_sha256=//p' "$INFRA_APPROVAL_FILE" | head -n 1)"
candidate_compose_sha="$(git show "$target_commit:compose.yaml" | sha256sum | awk '{print $1}')"
candidate_caddy_sha="$(git show "$target_commit:deploy/Caddyfile" | sha256sum | awk '{print $1}')"
candidate_deploy_sha="$(git show "$target_commit:scripts/deploy-production.sh" | sha256sum | awk '{print $1}')"
candidate_backup_sha="$(git show "$target_commit:scripts/backup.sh" | sha256sum | awk '{print $1}')"
candidate_gate_sha="$(git show "$target_commit:scripts/stroios-deploy-gate.sh" | sha256sum | awk '{print $1}')"
if [[ ! "$approved_compose_sha" =~ ^[0-9a-f]{64}$ || \
      ! "$approved_caddy_sha" =~ ^[0-9a-f]{64}$ || \
      "$candidate_compose_sha" != "$approved_compose_sha" || \
      "$candidate_caddy_sha" != "$approved_caddy_sha" ]]; then
  echo "STROIOS_DEPLOY_ERROR manual_infrastructure_rollout_required" >&2
  exit 78
fi
if [[ ! "$approved_deploy_sha" =~ ^[0-9a-f]{64}$ || \
      ! "$approved_backup_sha" =~ ^[0-9a-f]{64}$ || \
      ! "$approved_gate_sha" =~ ^[0-9a-f]{64}$ || \
      "$candidate_deploy_sha" != "$approved_deploy_sha" || \
      "$candidate_backup_sha" != "$approved_backup_sha" || \
      "$candidate_gate_sha" != "$approved_gate_sha" ]]; then
  echo "STROIOS_DEPLOY_ERROR manual_ops_rollout_required" >&2
  exit 78
fi

candidate_reset_key="$(git show "$target_commit:sites/worker.js" | \
  sed -n "s/^const BATTLE_RESET_KEY = '\([^']*\)';$/\1/p" | head -n 1)"
if [[ ! "$candidate_reset_key" =~ ^[A-Za-z0-9_-]{1,80}$ ]]; then
  echo "STROIOS_DEPLOY_ERROR candidate_reset_key_invalid" >&2
  exit 78
fi
reset_marker="$(printf "SELECT value FROM system_meta WHERE key='%s' LIMIT 1;\n" "$candidate_reset_key" | \
  docker compose -f "$COMPOSE_FILE" exec -T db sh -ceu \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atq')"
if [[ "$reset_marker" != "done" ]]; then
  echo "STROIOS_DEPLOY_ERROR manual_data_initialization_required:$candidate_reset_key" >&2
  exit 78
fi

service_health_check() {
  local service="$1" max_attempts="${2:-$HEALTH_ATTEMPTS}" attempt container status
  for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
    container="$(docker compose -f "$COMPOSE_FILE" ps -q "$service")"
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
      "$container" 2>/dev/null || true)"
    if [[ "$status" == "healthy" || "$status" == "running" ]]; then
      return 0
    fi
    sleep "$HEALTH_INTERVAL_SECONDS"
  done
  return 1
}

readiness_response() {
  docker compose -f "$COMPOSE_FILE" exec -T app \
    wget -qO- http://127.0.0.1:3000/api/readiness 2>/dev/null || true
}

readiness_check() {
  local expected_sha="$1" max_attempts="${2:-$HEALTH_ATTEMPTS}" attempt response diagnostic
  for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
    response="$(readiness_response)"
    if [[ "$response" == *'"ok":true'* && \
          "$response" == *'"database":true'* && \
          "$response" == *"\"buildSha\":\"$expected_sha\""* ]]; then
      return 0
    fi
    sleep "$HEALTH_INTERVAL_SECONDS"
  done
  diagnostic="$(printf '%s' "$response" | tr '\r\n' ' ' | cut -c1-600)"
  echo "STROIOS_DEPLOY_ERROR internal_readiness_failed response=${diagnostic:-empty}" >&2
  return 1
}

public_readiness_check() {
  local expected_sha="$1" max_attempts="${2:-$HEALTH_ATTEMPTS}" public_url attempt response
  local response_file http_status diagnostic
  public_url="$(docker compose -f "$COMPOSE_FILE" exec -T app printenv APP_PUBLIC_URL | tr -d '\r\n')"
  if [[ ! "$public_url" =~ ^https://[^/[:space:]]+/?$ ]]; then
    echo "STROIOS_DEPLOY_ERROR public_url_invalid" >&2
    return 1
  fi
  public_url="${public_url%/}"
  response_file="$(mktemp)"
  for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
    http_status="$(curl --silent --show-error --max-time 10 \
      --output "$response_file" --write-out '%{http_code}' \
      "$public_url/api/readiness" 2>/dev/null || true)"
    response="$(head -c 2048 "$response_file")"
    if [[ "$http_status" == "200" && \
          "$response" == *'"ok":true'* && \
          "$response" == *'"database":true'* && \
          "$response" == *"\"buildSha\":\"$expected_sha\""* ]]; then
      rm -f -- "$response_file"
      return 0
    fi
    sleep "$HEALTH_INTERVAL_SECONDS"
  done
  diagnostic="$(printf '%s' "$response" | tr '\r\n' ' ' | cut -c1-600)"
  echo "STROIOS_DEPLOY_ERROR public_readiness_failed status=${http_status:-000} response=${diagnostic:-empty}" >&2
  rm -f -- "$response_file"
  return 1
}

reload_caddy() {
  docker compose -f "$COMPOSE_FILE" exec -T caddy \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  docker compose -f "$COMPOSE_FILE" exec -T caddy \
    caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  echo "STROIOS_CADDY_RELOADED"
}

telegram_probe() {
  local attempt
  for ((attempt = 1; attempt <= 12; attempt += 1)); do
    if docker compose -f "$COMPOSE_FILE" exec -T app node --input-type=module -e '
    const token = String(process.env.TELEGRAM_BOT_TOKEN || "");
    const secret = String(process.env.TELEGRAM_RELAY_SECRET || "");
    const base = String(process.env.TELEGRAM_API_BASE || "").replace(/\/+$/u, "");
    const expected = String(process.env.TELEGRAM_WEBHOOK_URL || "");
    let webhookUrl;
    try {
      webhookUrl = new URL(expected);
    } catch {
      process.exit(2);
    }
    if (!token || !secret || !base || webhookUrl.protocol !== "https:" ||
        webhookUrl.username || webhookUrl.password || webhookUrl.hash) process.exit(2);
    const headers = { "X-Telegram-Relay-Secret": secret };
    for (const method of ["getMe", "getWebhookInfo"]) {
      const response = await fetch(`${base}/bot${token}/${method}`, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.ok !== true) process.exit(3);
      if (method === "getWebhookInfo") {
        if (body?.result?.url !== expected) process.exit(4);
      }
    }
    ' >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
  done
  return 1
}

service_health_check telegram-relay
telegram_was_ready=0
if telegram_probe; then
  telegram_was_ready=1
else
  echo "STROIOS_TELEGRAM_DEGRADED before_deploy" >&2
fi

app_container="$(docker compose -f "$COMPOSE_FILE" ps -q app)"
relay_container="$(docker compose -f "$COMPOSE_FILE" ps -q telegram-relay)"
previous_app_image="$(docker inspect --format '{{.Image}}' "$app_container")"
previous_relay_image="$(docker inspect --format '{{.Image}}' "$relay_container")"
current_app_revision="$(docker image inspect "$previous_app_image" \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)"
current_relay_revision="$(docker image inspect "$previous_relay_image" \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)"
previous_app_key="${previous_app_image#sha256:}"
previous_relay_key="${previous_relay_image#sha256:}"
[[ "$current_app_revision" =~ ^[0-9a-f]{40}$ ]] && previous_app_key="$current_app_revision"
[[ "$current_relay_revision" =~ ^[0-9a-f]{40}$ ]] && previous_relay_key="$current_relay_revision"
previous_app_tag="stroios-app:release-${previous_app_key:0:12}"
previous_relay_tag="stroios-relay:release-${previous_relay_key:0:12}"
target_tag="stroios-runtime:release-$target_commit"
docker image tag "$previous_app_image" "$previous_app_tag"
docker image tag "$previous_relay_image" "$previous_relay_tag"

write_runtime_images() {
  local app_image="$1" relay_image="$2" temporary
  temporary="$(mktemp "$APP_DIR/.env.deploy.XXXXXX")"
  awk -v app_image="$app_image" -v relay_image="$relay_image" '
    BEGIN { app_seen = 0; relay_seen = 0 }
    /^STROIOS_APP_IMAGE=/ {
      if (!app_seen) print "STROIOS_APP_IMAGE=" app_image
      app_seen = 1
      next
    }
    /^STROIOS_RELAY_IMAGE=/ {
      if (!relay_seen) print "STROIOS_RELAY_IMAGE=" relay_image
      relay_seen = 1
      next
    }
    { print }
    END {
      if (!app_seen) print "STROIOS_APP_IMAGE=" app_image
      if (!relay_seen) print "STROIOS_RELAY_IMAGE=" relay_image
    }
  ' .env >"$temporary"
  chmod --reference=.env "$temporary"
  chown --reference=.env "$temporary"
  sync -f "$temporary"
  mv -f -- "$temporary" .env
  sync -f .env
  sync -f "$APP_DIR"
}

if [[ "$previous_commit" == "$target_commit" && \
      "$previous_app_image" == "$previous_relay_image" && \
      "$current_app_revision" == "$target_commit" && \
      "$current_relay_revision" == "$target_commit" ]] && \
   readiness_check "$target_commit" && public_readiness_check "$target_commit"; then
  docker image tag "$previous_app_image" "$target_tag"
  write_runtime_images "$target_tag" "$target_tag"
  if [[ "$telegram_was_ready" == "1" ]]; then
    telegram_state="ready"
  else
    telegram_state="degraded"
    echo "STROIOS_TELEGRAM_DEGRADED current_release"
  fi
  echo "STROIOS_DEPLOY_OK $target_commit telegram=$telegram_state"
  exit 0
fi

build_dir="$(mktemp -d /var/tmp/stroios-build.XXXXXX)"
candidate_tag="stroios-runtime:candidate-$target_commit-$$"
worktree_changed=0
runtime_pointer_changed=0
live_services_touched=0
cleanup() {
  docker image rm "$candidate_tag" >/dev/null 2>&1 || true
  rm -rf -- "$build_dir"
}
rollback() {
  local status="${1:-$?}"
  local rollback_failed=0 restored_app_container restored_relay_container restored_app_image restored_relay_image
  trap - ERR HUP INT TERM
  set +e
  echo "STROIOS_DEPLOY_ROLLBACK started" >&2
  if [[ "$worktree_changed" == "1" ]]; then
    git reset --hard "$previous_commit" >/dev/null 2>&1 || rollback_failed=1
  fi
  [[ "$(git rev-parse HEAD 2>/dev/null)" == "$previous_commit" ]] || rollback_failed=1
  write_runtime_images "$previous_app_tag" "$previous_relay_tag" >/dev/null 2>&1 || rollback_failed=1
  grep -Fqx "STROIOS_APP_IMAGE=$previous_app_tag" .env || rollback_failed=1
  grep -Fqx "STROIOS_RELAY_IMAGE=$previous_relay_tag" .env || rollback_failed=1
  if [[ "$live_services_touched" == "1" ]]; then
    docker compose -f "$COMPOSE_FILE" up -d --no-deps --no-build --force-recreate \
      telegram-relay app >&2 || rollback_failed=1
    service_health_check telegram-relay "$ROLLBACK_HEALTH_ATTEMPTS" >&2 || rollback_failed=1
    service_health_check app "$ROLLBACK_HEALTH_ATTEMPTS" >&2 || rollback_failed=1
    reload_caddy >&2 || rollback_failed=1
    restored_app_container="$(docker compose -f "$COMPOSE_FILE" ps -q app 2>/dev/null)"
    restored_relay_container="$(docker compose -f "$COMPOSE_FILE" ps -q telegram-relay 2>/dev/null)"
    restored_app_image="$(docker inspect --format '{{.Image}}' "$restored_app_container" 2>/dev/null)"
    restored_relay_image="$(docker inspect --format '{{.Image}}' "$restored_relay_container" 2>/dev/null)"
    [[ "$restored_app_image" == "$previous_app_image" ]] || rollback_failed=1
    [[ "$restored_relay_image" == "$previous_relay_image" ]] || rollback_failed=1
    if [[ "$current_app_revision" =~ ^[0-9a-f]{40}$ ]]; then
      readiness_check "$current_app_revision" "$ROLLBACK_HEALTH_ATTEMPTS" >&2 || rollback_failed=1
      public_readiness_check "$current_app_revision" "$ROLLBACK_HEALTH_ATTEMPTS" >&2 || rollback_failed=1
    else
      echo "STROIOS_DEPLOY_ROLLBACK unattested_previous_build" >&2
      rollback_failed=1
    fi
    if [[ "$telegram_was_ready" == "1" ]] && ! telegram_probe >&2; then
      echo "STROIOS_DEPLOY_ROLLBACK telegram_not_restored" >&2
      rollback_failed=1
    fi
  fi
  if [[ "$rollback_failed" == "0" ]]; then
    echo "STROIOS_DEPLOY_ROLLBACK_OK $previous_commit" >&2
  else
    echo "STROIOS_DEPLOY_ROLLBACK_FAILED $previous_commit" >&2
    docker compose -f "$COMPOSE_FILE" logs --tail=120 app telegram-relay >&2 || true
  fi
  cleanup
  exit "$status"
}
trap cleanup EXIT
trap 'rollback $?' ERR
trap 'rollback 129' HUP
trap 'rollback 130' INT
trap 'rollback 143' TERM

git archive "$target_commit" | tar -x -C "$build_dir"
docker build \
  --build-arg "BUILD_SHA=$target_commit" \
  --label "org.opencontainers.image.revision=$target_commit" \
  --tag "$candidate_tag" \
  "$build_dir" >&2
built_revision="$(docker image inspect "$candidate_tag" \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
[[ "$built_revision" == "$target_commit" ]] || {
  echo "STROIOS_DEPLOY_ERROR built_revision_mismatch" >&2
  false
}

git fetch --quiet origin main
if [[ "$(git rev-parse origin/main)" != "$target_commit" ]]; then
  echo "STROIOS_DEPLOY_SUPERSEDED $requested_commit"
  trap - ERR HUP INT TERM
  cleanup
  trap - EXIT
  exit 0
fi

prune_builder_cache_under_pressure "$docker_root"
prune_release_tags_under_pressure "$docker_root" "$previous_app_tag" "$previous_relay_tag"
prune_backup_storage
require_free_space "$BACKUP_DIR" backups_after_build
require_free_space "$docker_root" docker_after_build

for _attempt in {1..12}; do
  sending_count="$(docker compose -f "$COMPOSE_FILE" exec -T db sh -ceu \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "SELECT count(*) FROM telegram_outbox WHERE status = '\''sending'\'';"' \
    2>/dev/null)"
  [[ "$sending_count" == "0" ]] && break
  sleep 5
done
if [[ "$sending_count" != "0" ]]; then
  echo "STROIOS_DEPLOY_ERROR telegram_outbox_busy" >&2
  false
fi

current_readiness="$(readiness_response)"
source_commit="$previous_commit"
if [[ "$current_readiness" != *"\"buildSha\":\"$previous_commit\""* ]]; then
  source_commit="unattested"
fi

live_services_touched=1
docker compose -f "$COMPOSE_FILE" stop -t 45 app

backup_path="$( \
  env \
    BACKUP_DIR="$BACKUP_DIR" \
    COMPOSE_FILE="$COMPOSE_FILE" \
    BACKUP_MIN_FREE_KB="$MIN_FREE_KB" \
    STROIOS_MAINTENANCE_LOCK_HELD=1 \
    SOURCE_COMMIT="$source_commit" \
    TARGET_COMMIT="$target_commit" \
    SOURCE_APP_IMAGE="$previous_app_image" \
    SOURCE_RELAY_IMAGE="$previous_relay_image" \
    "$BACKUP_COMMAND" \
)"
echo "STROIOS_BACKUP $backup_path"
require_free_space "$BACKUP_DIR" backups_after_snapshot
require_free_space "$docker_root" docker_after_snapshot

if [[ "$previous_commit" != "$target_commit" ]]; then
  worktree_changed=1
  git merge --quiet --ff-only "$target_commit"
fi

docker image tag "$candidate_tag" "$target_tag"
runtime_pointer_changed=1
write_runtime_images "$target_tag" "$target_tag"
docker compose -f "$COMPOSE_FILE" config --quiet
docker compose -f "$COMPOSE_FILE" up -d --no-deps --no-build --force-recreate telegram-relay
service_health_check telegram-relay
docker compose -f "$COMPOSE_FILE" up -d --no-deps --no-build --force-recreate app
service_health_check app
readiness_check "$target_commit"
reload_caddy
public_readiness_check "$target_commit"
if telegram_probe; then
  telegram_state="ready"
  echo "STROIOS_TELEGRAM_READY $target_commit"
elif [[ "$telegram_was_ready" == "1" ]]; then
  echo "STROIOS_DEPLOY_ERROR telegram_regressed" >&2
  false
else
  telegram_state="degraded"
  echo "STROIOS_TELEGRAM_DEGRADED $target_commit"
fi

trap - ERR HUP INT TERM
worktree_changed=0
runtime_pointer_changed=0
live_services_touched=0
cleanup
trap - EXIT

prune_release_tags 6 "$target_tag" "$previous_app_tag" "$previous_relay_tag"
prune_builder_cache_under_pressure "$docker_root"

echo "STROIOS_DEPLOY_PREVIOUS $previous_commit"
echo "STROIOS_DEPLOY_OK $target_commit telegram=$telegram_state"
