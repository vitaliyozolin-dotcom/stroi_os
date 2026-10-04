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
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="color-scheme" content="light">
  <meta name="theme-color" content="#111510">
  <title>Вход — ИКИОМА ОС</title>
  <style>
    :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#151914;background:#f5f4ef;font-synthesis:none;-webkit-font-smoothing:antialiased;--ink:#111510;--paper:#f5f4ef;--accent:#d5ff48;--muted:#696e64}
    *{box-sizing:border-box}body{margin:0}button,input{font:inherit}svg{display:block}p{margin:0}a,button,input{-webkit-tap-highlight-color:transparent}
    .shell{min-height:100vh;min-height:100svh;display:grid;grid-template-columns:minmax(0,1.08fr) minmax(0,1fr)}
    .identity{position:relative;isolation:isolate;overflow:hidden;background:var(--ink);color:var(--paper);padding:48px clamp(36px,5vw,88px);display:flex;flex-direction:column;justify-content:space-between;min-height:680px}
    .brand{display:flex;align-items:center;gap:12px;font-size:23px;font-weight:780;letter-spacing:-.055em;line-height:1;white-space:nowrap}.brand em{color:var(--accent);font-style:normal}.mark{width:38px;height:38px;border-radius:4px;background:var(--accent);color:var(--ink);display:grid;place-items:center;flex-shrink:0}.mark svg{width:25px;height:25px}
    .statement{position:relative;z-index:1;margin:70px 0 auto;font-size:clamp(42px,4.8vw,76px);font-weight:750;line-height:1.03;letter-spacing:-.065em;text-transform:uppercase}.statement span{color:var(--accent)}
    .drawing{position:relative;width:min(100%,510px);height:auto;aspect-ratio:1.7;margin:32px auto 16px;color:var(--accent)}
    .identity-foot{border-top:1px solid #363c31;padding-top:18px;display:flex;justify-content:space-between;gap:20px;color:#aab19f;font-size:12px;letter-spacing:.015em}.identity-foot span:last-child{color:var(--accent)}.mobile-note{display:none}
    .entry{display:flex;flex-direction:column;justify-content:center;align-items:center;padding:64px clamp(32px,5.5vw,88px);background:var(--paper)}
    .card{width:100%;max-width:390px}.eyebrow{display:flex;align-items:center;gap:8px;color:#5d6554;font-size:11px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;margin-bottom:24px}.eyebrow::before{content:"";width:6px;height:6px;background:#75864a}
    h1{font-size:clamp(32px,3vw,43px);font-weight:760;line-height:1.05;letter-spacing:-.055em;margin:0 0 12px}.intro{font-size:14px;line-height:1.6;color:var(--muted);margin:0 0 36px}
    .field{margin-bottom:22px}label{display:block;font-size:13px;font-weight:600;margin-bottom:9px}input{width:100%;min-width:0;height:54px;border:1px solid #d4d7cb;border-radius:4px;padding:0 15px;font-size:16px;background:#fff;color:var(--ink);outline:none}input::placeholder{color:#92978a;opacity:1}input:focus{border-color:#687849;box-shadow:0 0 0 3px #d5ff4870}
    .submit{display:flex;align-items:center;justify-content:space-between;gap:16px;width:100%;min-height:54px;margin-top:8px;padding:15px 18px;border:1px solid transparent;border-radius:4px;background:var(--accent);color:var(--ink);font-size:15px;font-weight:700;cursor:pointer}.submit svg{width:21px;height:21px}.submit:hover{background:#c8f137}.submit:active{background:#bce527}.submit:focus-visible{outline:2px solid #151914;outline-offset:4px}
    .help{font-size:12px;line-height:1.6;color:var(--muted);margin-top:24px}.foot{display:flex;align-items:center;gap:8px;border-top:1px solid #dbddd3;padding-top:22px;margin-top:40px;color:#777e6c;font-size:11px}.foot svg{width:13px;height:13px;flex-shrink:0}
    .error,.notice{padding:12px 14px;margin:0 0 24px;border-left:3px solid;font-size:13px;line-height:1.5;overflow-wrap:anywhere}.error{background:#f8e8e3;color:#8d3429;border-color:#ad4836}.notice{background:#e8efdf;color:#3f572b;border-color:#6d8445}
    @media(min-width:1600px){.identity{padding-top:64px;padding-bottom:48px}.statement{margin-top:100px}.drawing{width:580px}}
    @media(max-width:760px){
      .shell{grid-template-columns:1fr;grid-template-rows:auto 1fr;min-height:100vh;min-height:100svh}
      .identity{min-height:0;padding:max(28px,env(safe-area-inset-top)) 24px 26px}.brand{font-size:22px;gap:11px}.mark{width:34px;height:34px}.mark svg{width:22px;height:22px}
      .statement,.drawing,.identity-foot{display:none}.mobile-note{display:block;font-size:13px;line-height:1.5;color:#b0b7a7;margin-top:17px}
      .entry{justify-content:flex-start;padding:38px 24px max(24px,env(safe-area-inset-bottom))}.card{max-width:430px}.eyebrow{margin-bottom:18px;font-size:10px}h1{font-size:34px}.intro{font-size:13px;margin-bottom:28px}.field{margin-bottom:20px}input{height:52px}.submit{min-height:52px}.help{margin-top:22px}.foot{margin-top:30px;padding-top:20px}
    }
    @media(max-width:360px){.identity{padding-left:20px;padding-right:20px}.entry{padding-left:20px;padding-right:20px}h1{font-size:31px}}
    @media(max-width:760px) and (max-height:700px){.identity{padding-top:max(20px,env(safe-area-inset-top));padding-bottom:20px}.mobile-note{margin-top:12px}.entry{padding-top:26px}.eyebrow{margin-bottom:14px}.intro{margin-bottom:22px}.foot{margin-top:24px}}
  </style>
</head>
<body>
  <main class="shell">
    <aside class="identity" aria-label="ИКИОМА ОС">
      <div class="brand"><span class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-2M10 6h4M10 10h4M10 14h4M10 18h4"/></svg></span><span>ИКИОМА <em>ОС</em></span></div>
      <p class="statement">От плана<br>до готового<br><span>дома.</span></p>
      <svg class="drawing" viewBox="0 0 510 300" fill="none" aria-hidden="true">
        <g stroke="#343d2d" stroke-width="1"><path d="m15 220 250 70 230-130M15 240l195 55M65 194l250 69M115 168l250 68M165 141l250 69M215 115l250 69M56 232l240-131M108 246l240-131M160 261l240-131M212 275l240-131"/></g>
        <g stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M102 215V116l61-77 199 52 49 96v76l-186-49-62 30-61-29Z"/><path d="m102 116 123 34 49-60-111-51m62 175v-64l186 49M274 90l137 109M163 244V134m0-95v95m0 0 62 16m-62-16-61-18"/><path d="M247 219v-53l38 10v53m16 4v-53l38 10v53m16 4v-53l38 10v53M119 221v-78l25 7v82"/></g>
        <g stroke="#758653" stroke-width=".7"><path d="m93 230 67 34m9-3 53-28m12 2 178 47M93 225v10m68 24v10m8-14v11m53-38v10m12-9v12m178 35v12"/></g>
      </svg>
      <div class="identity-foot"><span>Объекты · Команда · Финансы</span><span>Всё под контролем.</span></div>
      <p class="mobile-note">От плана до готового дома.</p>
    </aside>
    <section class="entry" aria-labelledby="login-title"><div class="card">
      <div class="eyebrow">Рабочее пространство</div>
      <h1 id="login-title">Вход в систему</h1>
      <p class="intro">Ваши объекты, команда и финансы.</p>
      ${notice ? `<div class="notice" role="status">${escapeHtml(notice)}</div>` : ''}
      ${error ? `<div class="error" role="alert">${blocked ? 'Слишком много попыток. Повторите вход через 15 минут.' : 'Неверный логин или пароль.'}</div>` : ''}
      <form method="post" action="/api/auth/login">
        <div class="field"><label for="username">Email</label><input id="username" name="username" type="text" value="${escapeHtml(username)}" autocomplete="username" inputmode="email" autocapitalize="none" spellcheck="false" placeholder="name@company.ru" required></div>
        <div class="field"><label for="password">Пароль</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
        <button class="submit" type="submit"><span>Войти</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12h16m-6-6 6 6-6 6"/></svg></button>
      </form>
      <p class="help">Нет доступа? Обратитесь к администратору проекта.</p>
      <div class="foot"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg><span>ИКИОМА ОС · Управление строительством</span></div>
    </div></section>
  </main>
</body>
</html>`;
