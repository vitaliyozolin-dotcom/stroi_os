#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly APP_DIR="${APP_DIR:-/opt/stroios}"
readonly COMPOSE_FILE="${COMPOSE_FILE:-$APP_DIR/compose.yaml}"
readonly BACKUP_ROOT="${BACKUP_DIR:-/var/backups/stroios}"
readonly MAINTENANCE_LOCK_DIR="/run/lock/stroios"
readonly MAINTENANCE_LOCK_FILE="$MAINTENANCE_LOCK_DIR/maintenance.lock"
readonly RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
readonly RETENTION_COUNT="${BACKUP_RETENTION_COUNT:-14}"
readonly MIN_FREE_KB="${BACKUP_MIN_FREE_KB:-2097152}"
readonly SNAPSHOT_MARGIN_KB="${BACKUP_SNAPSHOT_MARGIN_KB:-262144}"

for command in awk cat chmod chown cut date df docker find flock git gzip head install mktemp mv rm sha256sum sleep sort sync tar; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "STROIOS_BACKUP_ERROR missing_command:$command" >&2
    exit 69
  fi
done

case "$BACKUP_ROOT" in
  /var/backups/stroios|/var/backups/stroios/*) ;;
  *) echo "STROIOS_BACKUP_ERROR unsafe_backup_root" >&2; exit 78 ;;
esac

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "STROIOS_BACKUP_ERROR compose_file_missing" >&2
  exit 78
fi

install -d -o root -g root -m 0750 "$BACKUP_ROOT" "$MAINTENANCE_LOCK_DIR"
if [[ "${STROIOS_MAINTENANCE_LOCK_HELD:-0}" != "1" ]]; then
  exec 8>"$MAINTENANCE_LOCK_FILE"
  if ! flock -n 8; then
    echo "STROIOS_BACKUP_ERROR maintenance_in_progress" >&2
    exit 75
  fi
fi

while IFS= read -r -d '' abandoned_partial; do
  [[ "$abandoned_partial" == "$BACKUP_ROOT"/.20??????T??????Z-* ]] || continue
  rm -rf -- "$abandoned_partial"
done < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '.20??????T??????Z-*' -print0)
while IFS= read -r -d '' abandoned_snapshot; do
  [[ "$abandoned_snapshot" == "$BACKUP_ROOT"/20??????T??????Z-* ]] || continue
  [[ ! -e "$abandoned_snapshot/COMPLETE" ]] || continue
  rm -rf -- "$abandoned_snapshot"
done < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20??????T??????Z-*' -print0)

prune_expired_backups() {
  [[ "$RETENTION_DAYS" =~ ^[0-9]+$ && "$RETENTION_DAYS" -gt 0 ]] || return 0
  local latest_complete expired
  latest_complete="$(find "$BACKUP_ROOT" -mindepth 2 -maxdepth 2 -type f -name COMPLETE \
    -printf '%T@|%h\n' | sort -nr | head -n 1 | cut -d'|' -f2-)"
  while IFS= read -r -d '' expired; do
    [[ "$expired" == "$latest_complete" ]] && continue
    [[ "$expired" == "$BACKUP_ROOT"/20??????T??????Z-* ]] || continue
    rm -rf -- "$expired"
  done < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d \
    -name '20??????T??????Z-*' -mtime "+$RETENTION_DAYS" -print0)
}

prune_expired_backups
prune_backup_pressure() {
  local required_free_kb="${1:-$MIN_FREE_KB}"
  local -a complete_backups=()
  local index available_kb
  mapfile -t complete_backups < <(find "$BACKUP_ROOT" -mindepth 2 -maxdepth 2 -type f -name COMPLETE \
    -printf '%T@|%h\n' | sort -nr | cut -d'|' -f2-)
  if [[ "$RETENTION_COUNT" =~ ^[0-9]+$ && "$RETENTION_COUNT" -gt 0 ]]; then
    for ((index = RETENTION_COUNT; index < ${#complete_backups[@]}; index += 1)); do
      [[ "${complete_backups[$index]}" == "$BACKUP_ROOT"/20??????T??????Z-* ]] || continue
      rm -rf -- "${complete_backups[$index]}"
    done
    complete_backups=("${complete_backups[@]:0:RETENTION_COUNT}")
  fi
  for ((index = ${#complete_backups[@]} - 1; index >= 1; index -= 1)); do
    available_kb="$(df -Pk "$BACKUP_ROOT" | awk 'NR == 2 {print $4}')"
    [[ "$available_kb" =~ ^[0-9]+$ && "$available_kb" -lt "$required_free_kb" ]] || break
    [[ "${complete_backups[$index]}" == "$BACKUP_ROOT"/20??????T??????Z-* ]] || continue
    rm -rf -- "${complete_backups[$index]}"
  done
}

prune_backup_pressure
available_kb="$(df -Pk "$BACKUP_ROOT" | awk 'NR == 2 {print $4}')"
if [[ ! "$available_kb" =~ ^[0-9]+$ || "$available_kb" -lt "$MIN_FREE_KB" ]]; then
  echo "STROIOS_BACKUP_ERROR insufficient_backup_space" >&2
  exit 73
fi

if [[ "${STROIOS_BACKUP_PRUNE_ONLY:-0}" == "1" ]]; then
  echo "STROIOS_BACKUP_PRUNE_OK"
  exit 0
fi

cd "$APP_DIR"
docker compose -f "$COMPOSE_FILE" config --quiet

app_container="$(docker compose -f "$COMPOSE_FILE" ps -aq app | head -n 1)"
db_container="$(docker compose -f "$COMPOSE_FILE" ps -q db)"
if [[ -z "$app_container" || -z "$db_container" ]]; then
  echo "STROIOS_BACKUP_ERROR required_container_missing" >&2
  exit 69
fi

app_was_running="$(docker inspect --format '{{.State.Running}}' "$app_container")"

snapshot_capacity_check() {
  local phase="$1" available_kb database_bytes database_kb files_kb required_kb
  database_bytes="$(docker compose -f "$COMPOSE_FILE" exec -T db sh -ceu \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "SELECT pg_database_size(current_database());"')"
  files_kb="$(docker run --rm --volumes-from "$app_container" busybox:1.37 \
    du -sk /data/files | awk 'NR == 1 {print $1}')"
  available_kb="$(df -Pk "$BACKUP_ROOT" | awk 'NR == 2 {print $4}')"
  if [[ ! "$database_bytes" =~ ^[0-9]+$ || ! "$files_kb" =~ ^[0-9]+$ || \
        ! "$available_kb" =~ ^[0-9]+$ || ! "$MIN_FREE_KB" =~ ^[0-9]+$ || \
        ! "$SNAPSHOT_MARGIN_KB" =~ ^[0-9]+$ ]]; then
    echo "STROIOS_BACKUP_ERROR capacity_measurement_failed:$phase" >&2
    return 73
  fi
  database_kb=$(( (database_bytes + 1023) / 1024 ))
  required_kb=$(( MIN_FREE_KB + SNAPSHOT_MARGIN_KB + database_kb + files_kb ))
  if (( available_kb < required_kb )); then
    prune_backup_pressure "$required_kb"
    available_kb="$(df -Pk "$BACKUP_ROOT" | awk 'NR == 2 {print $4}')"
  fi
  if (( available_kb < required_kb )); then
    echo "STROIOS_BACKUP_ERROR insufficient_backup_capacity:$phase available_kb=$available_kb required_kb=$required_kb" >&2
    return 73
  fi
}

snapshot_capacity_check before_stop
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_prefix="$timestamp-$(printf '%s' "${SOURCE_COMMIT:-unknown}:${TARGET_COMMIT:-unknown}" | sha256sum | cut -c1-10)"
partial="$(mktemp -d "$BACKUP_ROOT/.$backup_prefix.XXXXXX")"
partial_name="${partial##*/}"
backup_id="${partial_name#.}"
destination="$BACKUP_ROOT/$backup_id"
snapshot_published=0
if [[ -e "$destination" ]]; then
  echo "STROIOS_BACKUP_ERROR destination_exists" >&2
  exit 73
fi
chown root:root "$partial"
chmod 0750 "$partial"

wait_for_app() {
  local attempt status
  for ((attempt = 1; attempt <= 24; attempt += 1)); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
      "$app_container" 2>/dev/null || true)"
    if [[ "$status" == "healthy" || "$status" == "running" ]]; then
      return 0
    fi
    sleep 5
  done
  return 1
}

cleanup() {
  local status="$?"
  trap - EXIT
  set +e
  if [[ "$app_was_running" == "true" ]]; then
    if ! docker compose -f "$COMPOSE_FILE" start app >/dev/null || ! wait_for_app; then
      echo "STROIOS_BACKUP_ERROR app_restart_failed" >&2
      status=70
    fi
  fi
  if [[ "$status" -ne 0 ]]; then
    if [[ "$snapshot_published" == "1" && "$destination" == "$BACKUP_ROOT"/20??????T??????Z-* ]]; then
      rm -f -- "$destination/COMPLETE"
      rm -rf -- "$destination"
      sync -f "$BACKUP_ROOT" >/dev/null 2>&1 || true
    fi
    rm -rf -- "$partial"
  fi
  exit "$status"
}
trap cleanup EXIT

if [[ "$app_was_running" == "true" ]]; then
  docker compose -f "$COMPOSE_FILE" stop -t 45 app >/dev/null
fi

snapshot_capacity_check after_stop

docker compose -f "$COMPOSE_FILE" exec -T db sh -ceu \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner --no-acl' \
  >"$partial/database.dump"

docker run --rm --volumes-from "$app_container" busybox:1.37 \
  tar -czf - -C /data/files . >"$partial/files.tar.gz"

[[ -s "$partial/database.dump" ]] || { echo "STROIOS_BACKUP_ERROR empty_database_dump" >&2; exit 65; }
[[ -s "$partial/files.tar.gz" ]] || { echo "STROIOS_BACKUP_ERROR empty_files_archive" >&2; exit 65; }

docker compose -f "$COMPOSE_FILE" exec -T db pg_restore --list \
  <"$partial/database.dump" >"$partial/database.list"
gzip -t "$partial/files.tar.gz"
tar -tzf "$partial/files.tar.gz" >/dev/null

source_commit="${SOURCE_COMMIT:-$(git rev-parse HEAD 2>/dev/null || printf unknown)}"
target_commit="${TARGET_COMMIT:-unknown}"
source_app_image="${SOURCE_APP_IMAGE:-$(docker inspect --format '{{.Image}}' "$app_container")}"
source_relay_image="${SOURCE_RELAY_IMAGE:-unknown}"
cat >"$partial/manifest.txt" <<EOF
backup_id=$backup_id
created_at=$timestamp
source_commit=$source_commit
target_commit=$target_commit
source_app_image=$source_app_image
source_relay_image=$source_relay_image
compose_project=stroios
database_format=postgres_custom
files_format=tar_gzip
EOF

(
  cd "$partial"
  sha256sum database.dump files.tar.gz database.list manifest.txt >SHA256SUMS
  sha256sum --check SHA256SUMS >/dev/null
  printf 'ok\n' >VERIFIED
)

sync -f "$partial/database.dump"
sync -f "$partial/files.tar.gz"
sync -f "$partial/VERIFIED"
sync -f "$partial"

snapshot_published=1
mv -- "$partial" "$destination"
sync -f "$BACKUP_ROOT"
(
  cd "$destination"
  sha256sum --check SHA256SUMS >/dev/null
  [[ "$(cat VERIFIED)" == "ok" ]]
)
printf 'ok\n' >"$destination/COMPLETE"
sync -f "$destination/COMPLETE"
sync -f "$BACKUP_ROOT"
snapshot_published=2

prune_expired_backups
prune_backup_pressure
available_kb="$(df -Pk "$BACKUP_ROOT" | awk 'NR == 2 {print $4}')"
if [[ ! "$available_kb" =~ ^[0-9]+$ || "$available_kb" -lt "$MIN_FREE_KB" ]]; then
  echo "STROIOS_BACKUP_ERROR insufficient_backup_space_after_snapshot" >&2
  exit 73
fi

echo "$destination"
