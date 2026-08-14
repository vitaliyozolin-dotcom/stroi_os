const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const roleLabels = { management: 'Управление', foreman: 'Прораб', client: 'Клиент' };
const messages = {
  weak_password: 'Пароль должен содержать от 15 до 128 символов.',
  password_mismatch: 'Пароли не совпадают.',
  invite_invalid: 'Ссылка недействительна, уже использована или её срок закончился.',
  rate_limited: 'Слишком много попыток. Повторите позже.',
};

const styles = `
  :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17211b;background:#f4f5f2}
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 15% 10%,#fff 0,transparent 34%),linear-gradient(145deg,#eef1eb,#f7f7f4)}
  .shell{width:min(100%,480px)}.brand{display:flex;align-items:center;gap:12px;margin:0 0 22px 4px;font-weight:750;letter-spacing:-.03em;font-size:20px}.mark{width:34px;height:34px;border-radius:11px;background:#1f6b45;display:grid;place-items:center;color:#fff;font-size:15px}
  .card{background:#fff;border:1px solid #e1e5de;border-radius:24px;padding:32px;box-shadow:0 24px 70px rgba(28,45,34,.11)}h1{font-size:30px;line-height:1.1;letter-spacing:-.04em;margin:0 0 10px}p{color:#68746c;margin:0 0 24px;line-height:1.5}.meta{display:grid;gap:9px;padding:15px;border-radius:14px;background:#f5f7f3;margin-bottom:24px}.meta span{display:flex;justify-content:space-between;gap:16px;font-size:13px;color:#68746c}.meta strong{color:#17211b;text-align:right}
  label{display:block;font-size:13px;font-weight:700;margin:0 0 8px}.field{margin-bottom:18px}input{width:100%;height:50px;border:1px solid #d8ddd6;border-radius:13px;padding:0 15px;font:inherit;background:#fbfcfa;outline:none}input:focus{border-color:#1f6b45;box-shadow:0 0 0 4px rgba(31,107,69,.1);background:#fff}small{display:block;color:#879189;line-height:1.45;margin-top:7px}
  button,.button{width:100%;height:52px;border:0;border-radius:13px;background:#1f6b45;color:#fff;font:700 15px inherit;cursor:pointer;margin-top:4px;text-decoration:none;display:grid;place-items:center}button:hover,.button:hover{background:#18583a}.error{padding:12px 14px;border-radius:12px;background:#fff0ed;color:#9d382a;font-size:13px;margin:0 0 18px}.foot{text-align:center;color:#879189;font-size:12px;margin-top:18px}
  @media(max-width:520px){body{padding:16px;align-items:end}.card{padding:26px 22px;border-radius:22px}h1{font-size:28px}}
`;

const shell = (content, title = 'Доступ — ИКИОМА ОС') => `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(title)}</title><style>${styles}</style></head>
<body><main class="shell"><div class="brand"><span class="mark">И</span><span>ИКИОМА ОС</span></div>${content}<div class="foot">Защищённый доступ · ИКИОМА</div></main></body></html>`;

export const activationPage = ({ token, invite, error = '' }) => shell(`
  <section class="card">
    <h1>${invite.purpose === 'reset' ? 'Обновите пароль' : 'Активируйте доступ'}</h1>
    <p>${invite.purpose === 'reset' ? 'Задайте новый пароль. Все прежние сессии будут завершены.' : 'Придумайте пароль — после активации вы войдёте по своему email.'}</p>
    <div class="meta">
      <span>Пользователь <strong>${escapeHtml(invite.name)}</strong></span>
      <span>Логин <strong>${escapeHtml(invite.email)}</strong></span>
      <span>Роль <strong>${escapeHtml(roleLabels[invite.role] || invite.role)}</strong></span>
      <span>Проект <strong>${escapeHtml(invite.projectName)}</strong></span>
    </div>
    ${error ? `<div class="error" role="alert">${escapeHtml(messages[error] || 'Не удалось активировать доступ. Попросите руководителя выпустить новую ссылку.')}</div>` : ''}
    <form method="post" action="/api/auth/activate">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <div class="field"><label for="password">Новый пароль</label><input id="password" name="password" type="password" minlength="15" maxlength="128" autocomplete="new-password" required autofocus><small>Не менее 15 символов. Не используйте пароль от почты или Telegram.</small></div>
      <div class="field"><label for="passwordConfirm">Повторите пароль</label><input id="passwordConfirm" name="passwordConfirm" type="password" minlength="15" maxlength="128" autocomplete="new-password" required></div>
      <button type="submit">${invite.purpose === 'reset' ? 'Сохранить новый пароль' : 'Активировать и войти'}</button>
    </form>
  </section>
`);

export const invalidActivationPage = () => shell(`
  <section class="card">
    <h1>Ссылка не работает</h1>
    <p>Она могла закончиться, быть использована или заменена новой. Попросите руководителя выпустить новую ссылку в настройках ИКИОМА ОС.</p>
    <a class="button" href="/login">Перейти ко входу</a>
  </section>
`, 'Ссылка недействительна — ИКИОМА ОС');
