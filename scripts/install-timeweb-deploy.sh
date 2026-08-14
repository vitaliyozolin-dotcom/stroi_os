#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly DEPLOY_USER="stroios-deploy"
readonly APP_DIR="/opt/stroios"
readonly GATE_PATH="/usr/local/bin/stroios-deploy-gate"
readonly ROOT_COMMAND_PATH="/usr/local/sbin/stroios-deploy"
readonly BACKUP_COMMAND_PATH="/usr/local/sbin/stroios-backup"
readonly INFRA_STATE_DIR="/var/lib/stroios-deploy"
readonly INFRA_APPROVAL_FILE="$INFRA_STATE_DIR/approved-infra.sha256"
readonly SAFE_BOOTSTRAP_COMPOSE_SHA256="428310fc10cfd35506dd5d55ab9d9255180b8a816944a6610afd3d6496517cf4"
readonly SAFE_BOOTSTRAP_CADDY_SHA256="6379af8fc2fe2434b1f5ef45c4476c960529b53bcdcaace00124878c271f15a1"
readonly SUDOERS_PATH="/etc/sudoers.d/stroios-deploy"
readonly MAINTENANCE_LOCK_DIR="/run/lock/stroios"
readonly MAINTENANCE_LOCK_FILE="$MAINTENANCE_LOCK_DIR/maintenance.lock"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Запустите установщик через sudo." >&2
  exit 77
fi

deploy_public_key="${DEPLOY_PUBLIC_KEY:-${1:-}}"
if [[ -z "$deploy_public_key" ]]; then
  echo "Передайте DEPLOY_PUBLIC_KEY с публичным ключом ssh-ed25519." >&2
  exit 64
fi
if [[ "$deploy_public_key" == *$'\n'* || ! "$deploy_public_key" =~ ^ssh-ed25519[[:space:]][A-Za-z0-9+/=]+([[:space:]].*)?$ ]]; then
  echo "Допускается одна строка публичного ключа ssh-ed25519." >&2
  exit 64
fi

for command in awk chmod chown cut docker flock getent git gpasswd install mktemp mv passwd rm sed sha256sum sudo sync visudo useradd; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Не найдена обязательная команда: $command" >&2
    exit 69
  fi
done

install -d -o root -g root -m 0750 "$MAINTENANCE_LOCK_DIR"
exec 9>"$MAINTENANCE_LOCK_FILE"
if ! flock -n 9; then
  echo "Другой deploy или backup уже выполняется." >&2
  exit 75
fi

for abandoned_env in "$APP_DIR"/.env.deploy.* "$APP_DIR"/.env.install.*; do
  [[ -f "$abandoned_env" ]] || continue
  rm -f -- "$abandoned_env"
done

if [[ ! -f "$APP_DIR/scripts/deploy-production.sh" || \
      ! -f "$APP_DIR/scripts/stroios-deploy-gate.sh" || \
      ! -f "$APP_DIR/scripts/backup.sh" ]]; then
  echo "Не найдены deploy-скрипты в $APP_DIR/scripts. Сначала обновите репозиторий." >&2
  exit 78
fi

if [[ -n "$(git -C "$APP_DIR" status --porcelain --untracked-files=all)" ]]; then
  echo "Рабочая копия $APP_DIR должна быть чистой." >&2
  exit 78
fi

target_commit="$(git -C "$APP_DIR" rev-parse HEAD)"
infra_approval_tmp="$(mktemp)"
{
  printf 'compose_sha256=%s\n' "$(git -C "$APP_DIR" show "$target_commit:compose.yaml" | sha256sum | cut -d' ' -f1)"
  printf 'caddy_sha256=%s\n' "$(git -C "$APP_DIR" show "$target_commit:deploy/Caddyfile" | sha256sum | cut -d' ' -f1)"
  printf 'deploy_sha256=%s\n' "$(git -C "$APP_DIR" show "$target_commit:scripts/deploy-production.sh" | sha256sum | cut -d' ' -f1)"
  printf 'backup_sha256=%s\n' "$(git -C "$APP_DIR" show "$target_commit:scripts/backup.sh" | sha256sum | cut -d' ' -f1)"
  printf 'gate_sha256=%s\n' "$(git -C "$APP_DIR" show "$target_commit:scripts/stroios-deploy-gate.sh" | sha256sum | cut -d' ' -f1)"
} >"$infra_approval_tmp"
if [[ -f "$INFRA_APPROVAL_FILE" ]]; then
  approved_compose_sha="$(sed -n 's/^compose_sha256=//p' "$INFRA_APPROVAL_FILE")"
  approved_caddy_sha="$(sed -n 's/^caddy_sha256=//p' "$INFRA_APPROVAL_FILE")"
  candidate_compose_sha="$(sed -n 's/^compose_sha256=//p' "$infra_approval_tmp")"
  candidate_caddy_sha="$(sed -n 's/^caddy_sha256=//p' "$infra_approval_tmp")"
  if [[ "$candidate_compose_sha" != "$approved_compose_sha" || \
        "$candidate_caddy_sha" != "$approved_caddy_sha" ]]; then
    rm -f "$infra_approval_tmp"
    echo "Compose/Caddy изменились после bootstrap. Нужен отдельный ручной инфраструктурный rollout." >&2
    exit 78
  fi
else
  if [[ "${APPROVE_INFRA_SHA:-}" != "$target_commit" ]]; then
    rm -f "$infra_approval_tmp"
    echo "Инфраструктура изменилась. Сначала выполните отдельный rollout, затем повторите с APPROVE_INFRA_SHA=$target_commit." >&2
    exit 78
  fi
  bootstrap_compose_sha="$(sed -n 's/^compose_sha256=//p' "$infra_approval_tmp")"
  bootstrap_caddy_sha="$(sed -n 's/^caddy_sha256=//p' "$infra_approval_tmp")"
  if [[ "$bootstrap_compose_sha" != "$SAFE_BOOTSTRAP_COMPOSE_SHA256" || \
        "$bootstrap_caddy_sha" != "$SAFE_BOOTSTRAP_CADDY_SHA256" ]]; then
    rm -f "$infra_approval_tmp"
    echo "Этот установщик не разрешает неизвестную версию Compose/Caddy." >&2
    exit 78
  fi
fi

if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --comment "StroiOS restricted deploy" "$DEPLOY_USER"
fi
passwd --lock "$DEPLOY_USER" >/dev/null 2>&1 || true

deploy_home="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
chown root:root "$deploy_home"
chmod 0755 "$deploy_home"
install -d -o root -g root -m 0755 "$deploy_home/.ssh"

sudoers_tmp="$(mktemp)"
authorized_keys_tmp="$(mktemp)"
dotenv_tmp=""
cleanup() {
  local status="$?"
  trap - EXIT
  rm -f "$sudoers_tmp" "$authorized_keys_tmp" "$infra_approval_tmp"
  [[ -z "$dotenv_tmp" ]] || rm -f -- "$dotenv_tmp"
  exit "$status"
}
trap cleanup EXIT

cat >"$sudoers_tmp" <<EOF
$DEPLOY_USER ALL=(root) NOPASSWD: $ROOT_COMMAND_PATH
EOF
visudo -cf "$sudoers_tmp" >/dev/null

printf 'restrict,command="%s" %s\n' "$GATE_PATH" "$deploy_public_key" >"$authorized_keys_tmp"

install -o root -g root -m 0755 "$APP_DIR/scripts/stroios-deploy-gate.sh" "$GATE_PATH"
install -o root -g root -m 0755 "$APP_DIR/scripts/backup.sh" "$BACKUP_COMMAND_PATH"
install -o root -g root -m 0755 "$APP_DIR/scripts/deploy-production.sh" "$ROOT_COMMAND_PATH"
install -o root -g root -m 0440 "$sudoers_tmp" "$SUDOERS_PATH"

if getent group docker >/dev/null 2>&1; then
  gpasswd --delete "$DEPLOY_USER" docker >/dev/null 2>&1 || true
fi
install -d -o root -g root -m 0750 /var/backups/stroios

cd "$APP_DIR"
docker compose -f compose.yaml config --quiet
app_container="$(docker compose -f compose.yaml ps -q app)"
relay_container="$(docker compose -f compose.yaml ps -q telegram-relay)"
for service in db app telegram-relay caddy; do
  service_container="$(docker compose -f compose.yaml ps -q "$service")"
  if [[ -z "$service_container" || "$(docker inspect --format '{{.State.Running}}' "$service_container")" != "true" ]]; then
    echo "Не найден работающий сервис: $service." >&2
    exit 69
  fi
done
app_image="$(docker inspect --format '{{.Image}}' "$app_container")"
relay_image="$(docker inspect --format '{{.Image}}' "$relay_container")"
app_key="${app_image#sha256:}"
relay_key="${relay_image#sha256:}"
app_tag="stroios-app:release-${app_key:0:12}"
relay_tag="stroios-relay:release-${relay_key:0:12}"
docker image tag "$app_image" "$app_tag"
docker image tag "$relay_image" "$relay_tag"

dotenv_tmp="$(mktemp "$APP_DIR/.env.install.XXXXXX")"
awk -v app_image="$app_tag" -v relay_image="$relay_tag" '
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
' .env >"$dotenv_tmp"
chmod --reference=.env "$dotenv_tmp"
chown --reference=.env "$dotenv_tmp"
sync -f "$dotenv_tmp"
mv -f -- "$dotenv_tmp" .env
sync -f .env
sync -f "$APP_DIR"

bootstrap_backup="$(
  BACKUP_DIR=/var/backups/stroios \
  COMPOSE_FILE="$APP_DIR/compose.yaml" \
  STROIOS_MAINTENANCE_LOCK_HELD=1 \
  BACKUP_MIN_FREE_KB=5242880 \
  SOURCE_COMMIT=unattested \
  TARGET_COMMIT="$target_commit" \
  SOURCE_APP_IMAGE="$app_image" \
  SOURCE_RELAY_IMAGE="$relay_image" \
  "$BACKUP_COMMAND_PATH"
)"

install -d -o root -g root -m 0750 "$INFRA_STATE_DIR"
install -o root -g root -m 0600 "$authorized_keys_tmp" "$deploy_home/.ssh/authorized_keys"
install -o root -g root -m 0640 "$infra_approval_tmp" "$INFRA_APPROVAL_FILE"

echo "Ограниченный пользователь $DEPLOY_USER настроен."
echo "Проверенная исходная копия: $bootstrap_backup"
echo "TIMEWEB_USER=$DEPLOY_USER"
deploy_host="${TIMEWEB_HOST:-188.225.38.55}"
echo "TIMEWEB_HOST=$deploy_host"
if [[ -r /etc/ssh/ssh_host_ed25519_key.pub ]]; then
  read -r host_key_type host_key_value _ </etc/ssh/ssh_host_ed25519_key.pub
  echo "TIMEWEB_KNOWN_HOSTS=$deploy_host $host_key_type $host_key_value"
fi
echo "Приватный ключ храните только в GitHub Actions Secret TIMEWEB_SSH_KEY."
