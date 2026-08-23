#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_DIR="/opt/stroios"
readonly CADDY_CONTAINER="stroios-caddy-1"
readonly ORIGIN_IP="188.225.47.207"
readonly ORIGIN_TLS_NAME="arthello-origin.internal"
readonly ORIGIN_SCHOOL_HOST="school-188-225-47-207.sslip.io"
readonly PUBLIC_ARTHELLO_HOST="arthello-188-225-38-55.sslip.io"
readonly PUBLIC_SCHOOL_HOST="school-188-225-38-55.sslip.io"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Запустите скрипт через sudo." >&2
  exit 77
fi

for command in curl cut docker getent git install mktemp sed; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Не найдена обязательная команда: $command" >&2
    exit 69
  }
done

if [[ "$(docker inspect --format '{{.State.Running}}' "$CADDY_CONTAINER" 2>/dev/null || true)" != "true" ]]; then
  echo "Не найден работающий публичный Caddy: $CADDY_CONTAINER" >&2
  exit 69
fi

cd "$APP_DIR"
if [[ "$(git symbolic-ref --quiet --short HEAD || true)" != "main" ]]; then
  echo "Репозиторий StroiOS должен находиться на ветке main." >&2
  exit 78
fi
if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  echo "Рабочая копия $APP_DIR должна быть чистой." >&2
  exit 78
fi
if ! grep -Fqx 'import /data/external-routes.caddy' deploy/Caddyfile; then
  echo "В deploy/Caddyfile отсутствует постоянный импорт внешних маршрутов." >&2
  exit 78
fi

caddy_data="$(docker inspect "$CADDY_CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')"
if [[ ! "$caddy_data" =~ ^/var/lib/docker/volumes/[^/]+/_data$ || ! -d "$caddy_data" ]]; then
  echo "Не удалось безопасно определить постоянный том Caddy." >&2
  exit 78
fi
origin_ca="$caddy_data/arthello-origin-root.crt"
if [[ ! -s "$origin_ca" ]]; then
  echo "Не найден корневой сертификат ArtHello origin: $origin_ca" >&2
  exit 78
fi

probe_origin() {
  local host="$1" status
  status="$(curl --noproxy '*' --silent --show-error --connect-timeout 5 --max-time 20 \
    --cacert "$origin_ca" \
    --resolve "$ORIGIN_TLS_NAME:443:$ORIGIN_IP" \
    --header "Host: $host" \
    --output /dev/null --write-out '%{http_code}' \
    "https://$ORIGIN_TLS_NAME/" 2>/dev/null || true)"
  if [[ ! "$status" =~ ^[234][0-9]{2}$ ]]; then
    echo "Origin не отвечает для $host, HTTP ${status:-000}. Изменения не применены." >&2
    exit 69
  fi
  echo "ORIGIN_OK host=$host status=$status"
}

probe_origin "$ORIGIN_TLS_NAME"
probe_origin "$ORIGIN_SCHOOL_HOST"

work_dir="$(mktemp -d /tmp/stroios-external-routes.XXXXXX)"
cleanup() {
  rm -f -- "$work_dir/external-routes.caddy" "$work_dir/live-before.json"
  rmdir "$work_dir" 2>/dev/null || true
}
trap cleanup EXIT

cat >"$work_dir/external-routes.caddy" <<EOF
$PUBLIC_ARTHELLO_HOST {
  encode zstd gzip
  reverse_proxy $ORIGIN_IP:443 {
    header_up Host $ORIGIN_TLS_NAME
    transport http {
      tls
      tls_server_name $ORIGIN_TLS_NAME
      tls_trust_pool file /data/arthello-origin-root.crt
    }
  }
}

$PUBLIC_SCHOOL_HOST {
  encode zstd gzip
  reverse_proxy $ORIGIN_IP:443 {
    header_up Host $ORIGIN_SCHOOL_HOST
    transport http {
      tls
      tls_server_name $ORIGIN_TLS_NAME
      tls_trust_pool file /data/arthello-origin-root.crt
    }
  }
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Frame-Options "DENY"
    Referrer-Policy "same-origin"
    -Server
  }
}
EOF

docker exec "$CADDY_CONTAINER" wget -qO- http://127.0.0.1:2019/config/ >"$work_dir/live-before.json"
install -o root -g root -m 0644 "$work_dir/external-routes.caddy" "$caddy_data/external-routes.caddy"

deploy_home="$(getent passwd stroios-deploy | cut -d: -f6)"
deploy_key="$(cut -d' ' -f2- "$deploy_home/.ssh/authorized_keys" | sed -n '1p')"
if [[ ! "$deploy_key" =~ ^ssh-ed25519[[:space:]][A-Za-z0-9+/=]+([[:space:]].*)?$ ]]; then
  echo "Не удалось прочитать действующий публичный deploy-ключ." >&2
  exit 78
fi

target_commit="$(git rev-parse HEAD)"
env APPROVE_INFRA_SHA="$target_commit" DEPLOY_PUBLIC_KEY="$deploy_key" \
  "$APP_DIR/scripts/install-timeweb-deploy.sh"

docker exec "$CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

wait_public() {
  local label="$1" url="$2" attempt status
  for ((attempt = 1; attempt <= 36; attempt += 1)); do
    status="$(curl --noproxy '*' --silent --show-error --connect-timeout 5 --max-time 12 \
      --output /dev/null --write-out '%{http_code}' "$url" 2>/dev/null || true)"
    if [[ "$status" =~ ^[234][0-9]{2}$ ]]; then
      echo "PUBLIC_OK service=$label status=$status url=$url"
      return 0
    fi
    sleep 5
  done
  echo "Публичная проверка не пройдена: $label, HTTP ${status:-000}, $url" >&2
  docker logs --since 10m "$CADDY_CONTAINER" 2>&1 | tail -n 120 >&2 || true
  return 1
}

wait_public "StroiOS" "https://stroios-188-225-38-55.sslip.io/"
wait_public "ArtHello OS" "https://$PUBLIC_ARTHELLO_HOST/"
wait_public "School 1-11" "https://$PUBLIC_SCHOOL_HOST/"

echo "SCHOOL_ROUTE_OK https://$PUBLIC_SCHOOL_HOST/"
