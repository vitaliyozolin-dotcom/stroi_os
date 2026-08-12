#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ ! -f .env ]]; then
  echo "ERROR: .env not found in $(pwd)"
  exit 1
fi

username="vitaliy"
read -rsp "Введите новый пароль для ${username}: " password
echo
read -rsp "Повторите пароль: " password_confirmation
echo

if [[ "$password" != "$password_confirmation" ]]; then
  echo "ERROR: пароли не совпадают"
  exit 1
fi

if (( ${#password} < 10 )); then
  echo "ERROR: пароль должен содержать минимум 10 символов"
  exit 1
fi

backup=".env.before-login-reset-$(date +%Y%m%d-%H%M%S)"
cp -a .env "$backup"

restore_previous_config() {
  local exit_code=$?
  trap - ERR
  echo "ERROR: проверка входа не пройдена; восстанавливаю прежнюю конфигурацию"
  cp -a "$backup" .env
  docker compose up -d --no-deps --force-recreate app >/dev/null
  unset password password_confirmation
  exit "$exit_code"
}
trap restore_previous_config ERR

escape_dotenv_single_quote() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\'/\\\'}
  printf "'%s'" "$value"
}

password_line="APP_PASSWORD=$(escape_dotenv_single_quote "$password")"

awk -v username_line="APP_USERNAME=${username}" -v password_line="$password_line" '
  BEGIN { have_username = 0; have_password = 0 }
  /^APP_USERNAME=/ { print username_line; have_username = 1; next }
  /^APP_PASSWORD=/ { print password_line; have_password = 1; next }
  { print }
  END {
    if (!have_username) print username_line
    if (!have_password) print password_line
  }
' .env > .env.login-reset.tmp
mv .env.login-reset.tmp .env

docker compose up -d --no-deps --force-recreate app >/dev/null

for _ in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' stroios-app-1 2>/dev/null || true)
  [[ "$status" == "healthy" ]] && break
  sleep 2
done
[[ "${status:-}" == "healthy" ]]

printf '%s\n%s' "$username" "$password" | docker compose exec -T app node -e '
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", async () => {
    const separator = input.indexOf("\n");
    const username = input.slice(0, separator);
    const password = input.slice(separator + 1);
    const login = await fetch("http://127.0.0.1:3000/api/auth/login", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password }),
    });
    const setCookie = login.headers.get("set-cookie") || "";
    if (login.status !== 303 || !setCookie.includes("stroios_session=")) {
      console.error(`LOGIN_TEST_FAILED status=${login.status}`);
      process.exit(1);
    }
    const cookie = setCookie.split(";", 1)[0];
    const home = await fetch("http://127.0.0.1:3000/", {
      redirect: "manual",
      headers: { accept: "text/html", cookie },
    });
    if (home.status !== 200) {
      console.error(`SESSION_TEST_FAILED status=${home.status}`);
      process.exit(1);
    }
    console.log("LOGIN_TEST_OK");
  });
' 

trap - ERR
unset password password_confirmation
echo "IKIOMA_LOGIN_READY"
echo "Логин: ${username}"
