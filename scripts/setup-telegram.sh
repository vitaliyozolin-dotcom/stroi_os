#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$0")/.."
test -f .env || { echo "Не найден /opt/stroios/.env"; exit 1; }

read -rsp "Вставьте токен @ikioma_bot из BotFather: " IKIOMA_TELEGRAM_TOKEN
echo
test -n "$IKIOMA_TELEGRAM_TOKEN" || { echo "Токен не введён"; exit 1; }

BOT_INFO="$(curl -fsS --max-time 10 "https://api.telegram.org/bot\${IKIOMA_TELEGRAM_TOKEN}/getMe")" || {
  unset IKIOMA_TELEGRAM_TOKEN
  echo "Telegram не принял токен"
  exit 1
}

BOT_USERNAME="$(printf '%s' "$BOT_INFO" | node -e '
  let body = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => body += chunk);
  process.stdin.on("end", () => {
    const value = JSON.parse(body);
    if (!value.ok || !value.result || !value.result.username) process.exit(1);
    process.stdout.write(value.result.username);
  });
')" || {
  unset IKIOMA_TELEGRAM_TOKEN BOT_INFO
  echo "Не удалось определить имя бота"
  exit 1
}

test "$BOT_USERNAME" = "ikioma_bot" || {
  unset IKIOMA_TELEGRAM_TOKEN BOT_INFO
  echo "Этот токен принадлежит @$BOT_USERNAME, а нужен @ikioma_bot"
  exit 1
}

IKIOMA_TELEGRAM_SETUP_KEY="$(openssl rand -hex 24)"
IKIOMA_TELEGRAM_WEBHOOK_SECRET="$(openssl rand -hex 24)"
IKIOMA_PUBLIC_URL="$(sed -n 's/^APP_PUBLIC_URL=//p' .env | tail -1 | tr -d '"')"
IKIOMA_PUBLIC_URL="\${IKIOMA_PUBLIC_URL:-https://stroios-188-225-38-55.sslip.io}"
IKIOMA_TELEGRAM_WEBHOOK_URL="\${IKIOMA_PUBLIC_URL%/}/api/integrations/telegram/update"

cp -a .env ".env.backup-telegram-$(date +%Y%m%d-%H%M%S)"

update_env() {
  local key="$1"
  local value="$2"
  if grep -q "^\${key}=" .env; then
    sed -i "s|^\${key}=.*|\${key}=\${value}|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

update_env TELEGRAM_BOT_TOKEN "$IKIOMA_TELEGRAM_TOKEN"
update_env TELEGRAM_SETUP_KEY "$IKIOMA_TELEGRAM_SETUP_KEY"
update_env TELEGRAM_WEBHOOK_SECRET "$IKIOMA_TELEGRAM_WEBHOOK_SECRET"
update_env TELEGRAM_WEBHOOK_URL "$IKIOMA_TELEGRAM_WEBHOOK_URL"
chmod 600 .env

unset IKIOMA_TELEGRAM_TOKEN BOT_INFO
docker compose up -d --no-deps --force-recreate app

for _ in $(seq 1 30); do
  STATUS="$(docker inspect -f '{{.State.Health.Status}}' stroios-app-1 2>/dev/null || true)"
  [ "$STATUS" = "healthy" ] && break
  sleep 2
done
test "\${STATUS:-}" = "healthy" || { echo "Приложение не прошло healthcheck"; exit 1; }

HTTP_STATUS="$(curl -sS -o /tmp/ikioma-telegram-bootstrap.json -w '%{http_code}' \
  -X POST -H "x-stroios-setup-key: $IKIOMA_TELEGRAM_SETUP_KEY" \
  "$IKIOMA_PUBLIC_URL/api/integrations/telegram/bootstrap")"

echo "BOT=@$BOT_USERNAME"
echo "APP_STATUS=$STATUS"
if [ "$HTTP_STATUS" = "200" ]; then
  echo "TELEGRAM_READY"
else
  echo "TOKEN_READY_CHAT_REQUIRED"
  echo "Добавьте @ikioma_bot в общий чат, отправьте /start и нажмите «Проверить ещё раз» в ИКИОМА ОС."
fi

unset IKIOMA_TELEGRAM_SETUP_KEY IKIOMA_TELEGRAM_WEBHOOK_SECRET IKIOMA_TELEGRAM_WEBHOOK_URL
