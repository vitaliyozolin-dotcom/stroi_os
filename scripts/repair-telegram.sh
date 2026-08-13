#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."

docker compose ps --status running app | grep -q app || {
  echo "Контейнер ИКИОМА ОС не запущен"
  exit 1
}

docker compose exec -T app node server/repair-telegram.js
