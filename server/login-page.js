const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

export const loginPage = ({ username = '', error = '', blocked = false, notice = '' } = {}) => `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Вход — ИКИОМА ОС</title>
  <style>
    :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17211b;background:#f4f5f2}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 15% 10%,#fff 0,transparent 34%),linear-gradient(145deg,#eef1eb,#f7f7f4)}
    .shell{width:min(100%,440px)}.brand{display:flex;align-items:center;gap:12px;margin:0 0 22px 4px;font-weight:750;letter-spacing:-.03em;font-size:20px}.mark{width:34px;height:34px;border-radius:11px;background:#1f6b45;display:grid;place-items:center;color:#fff;font-size:15px}
    .card{background:#fff;border:1px solid #e1e5de;border-radius:24px;padding:32px;box-shadow:0 24px 70px rgba(28,45,34,.11)}h1{font-size:30px;line-height:1.1;letter-spacing:-.04em;margin:0 0 10px}p{color:#68746c;margin:0 0 28px;line-height:1.5}
    label{display:block;font-size:13px;font-weight:700;margin:0 0 8px}.field{margin-bottom:18px}input{width:100%;height:50px;border:1px solid #d8ddd6;border-radius:13px;padding:0 15px;font:inherit;background:#fbfcfa;outline:none;transition:.15s}input:focus{border-color:#1f6b45;box-shadow:0 0 0 4px rgba(31,107,69,.1);background:#fff}
    button{width:100%;height:52px;border:0;border-radius:13px;background:#1f6b45;color:#fff;font:700 15px inherit;cursor:pointer;margin-top:4px}button:hover{background:#18583a}.error,.notice{padding:12px 14px;border-radius:12px;font-size:13px;margin:-8px 0 18px}.error{background:#fff0ed;color:#9d382a}.notice{background:#edf8f0;color:#1d6841}.foot{text-align:center;color:#879189;font-size:12px;margin-top:18px}
    @media(max-width:520px){body{padding:16px;align-items:end}.card{padding:26px 22px;border-radius:22px}.brand{margin-left:2px}h1{font-size:28px}}
  </style>
</head>
<body>
  <main class="shell">
    <div class="brand"><span class="mark">И</span><span>ИКИОМА ОС</span></div>
    <section class="card">
      <h1>Добро пожаловать</h1>
      <p>Сотрудники входят по email и своему паролю.</p>
      ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ''}
      ${error ? `<div class="error">${blocked ? 'Слишком много попыток. Повторите вход через 15 минут.' : 'Неверный логин или пароль.'}</div>` : ''}
      <form method="post" action="/api/auth/login">
        <div class="field"><label for="username">Email</label><input id="username" name="username" value="${escapeHtml(username)}" autocomplete="username" inputmode="email" required autofocus></div>
        <div class="field"><label for="password">Пароль</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
        <button type="submit">Войти</button>
      </form>
    </section>
    <div class="foot">Защищённый доступ · ИКИОМА</div>
  </main>
</body>
</html>`;
