#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

secure_replace_login_env() {
  local target=$1
  local target_dir temporary
  target_dir="$(dirname "$target")"
  temporary="$(mktemp "$target_dir/.env.login-reset.XXXXXX")"
  trap 'rm -f -- "$temporary"' RETURN

  cp --preserve=mode,ownership "$target" "$temporary"
  cat >"$temporary"
  sync -f "$temporary"
  mv -f -- "$temporary" "$target"
  temporary=""
  sync -f "$target"
  sync -f "$target_dir"
  trap - RETURN
}

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

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

if (( ${#password} < 16 )); then
  echo "ERROR: пароль должен содержать минимум 16 символов"
  exit 1
fi

backup="$(mktemp "${XDG_RUNTIME_DIR:-/tmp}/stroios-env-before-login-reset.XXXXXX")"
cp -a .env "$backup"

cleanup_login_reset() {
  rm -f -- "$backup"
  unset password password_confirmation password_line
}
trap cleanup_login_reset EXIT

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

{
  have_username=0
  have_password=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      APP_USERNAME=*) printf 'APP_USERNAME=%s\n' "$username"; have_username=1 ;;
      APP_PASSWORD=*) printf '%s\n' "$password_line"; have_password=1 ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < .env
  (( have_username )) || printf 'APP_USERNAME=%s\n' "$username"
  (( have_password )) || printf '%s\n' "$password_line"
} | secure_replace_login_env .env

docker compose up -d --no-deps --force-recreate app >/dev/null

for _ in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' stroios-app-1 2>/dev/null || true)
  [[ "$status" == "healthy" ]] && break
  sleep 2
done
[[ "${status:-}" == "healthy" ]]

# Ротация break-glass пароля немедленно отзывает все ранее выданные сессии
# владельца. Персональные сессии сотрудников не затрагиваются.
docker compose exec -T db sh -ceu '
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, NOW()::text) WHERE is_owner = TRUE"
' >/dev/null

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
echo "IKIOMA_LOGIN_READY"
echo "Логин: ${username}"
