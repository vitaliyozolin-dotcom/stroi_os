import { useState, type FormEvent } from 'react';
import { CalendarCheck2, KeyRound, LockKeyhole, Mail, ShieldCheck, WalletCards } from 'lucide-react';
import { Field } from './Ui';

const messageFor = (error: string) => ({
  invalid_credentials: 'Неверная почта, логин или пароль.',
  too_many_attempts: 'Слишком много попыток. Подождите 15 минут.',
  invite_expired: 'Ссылка уже использована или её срок истёк. Попросите выдать доступ повторно.',
  password_too_short: 'Пароль должен содержать не менее 10 символов.',
}[error] || 'Не удалось выполнить вход. Повторите попытку.');

export function AuthGate({ sessionError }: { sessionError?: string }) {
  const inviteToken = new URLSearchParams(window.location.search).get('invite') || '';
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const submitLogin = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login, password }),
      });
      const body = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !body.ok) throw new Error(body.error || 'login_failed');
      window.location.assign('/');
    } catch (error) {
      setMessage(messageFor(error instanceof Error ? error.message : 'login_failed'));
      setBusy(false);
    }
  };

  const acceptInvite = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirmation) return setMessage('Пароли не совпадают.');
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/auth/accept-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: inviteToken, password }),
      });
      const body = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !body.ok) throw new Error(body.error || 'invite_failed');
      window.location.assign('/');
    } catch (error) {
      setMessage(messageFor(error instanceof Error ? error.message : 'invite_failed'));
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <div className="auth-shell">
        <aside className="auth-story" aria-label="ИКИОМА ОС — операционная система строительства">
          <div className="auth-story__brand"><span><img src="/favicon.svg" alt="" /></span><div><strong>ИКИОМА <span>ОС</span></strong><small>операционная система строительства</small></div></div>
          <div className="auth-story__copy"><span className="auth-story__eyebrow">Рабочий контур ИКИОМА</span><h1>Стройка под контролем.<br />От заявки до сдачи.</h1><p>Проекты, сроки, деньги, снабжение и качество — в одном защищённом пространстве.</p></div>
          <div className="auth-story__points"><span><CalendarCheck2 size={18} /> План и факт по этапам</span><span><WalletCards size={18} /> Прозрачная экономика</span><span><ShieldCheck size={18} /> Персональные роли и доступы</span></div>
          <small className="auth-story__footer">Внутренняя система управления · доступ только для команды</small>
        </aside>
        <section className="auth-card">
          <div className="auth-card__brand"><span><img src="/favicon.svg" alt="" /></span><div><strong>ИКИОМА ОС</strong><small>защищённый вход</small></div></div>
          {inviteToken ? (
            <>
              <div className="auth-card__heading"><span>Первый вход</span><h2>Создайте свой пароль</h2><p>Пароль известен только вам. После сохранения вы сразу войдёте с назначенной ролью.</p></div>
              <form onSubmit={acceptInvite} className="auth-form">
                <Field label="Новый пароль" hint="Не менее 10 символов"><div className="auth-input"><LockKeyhole size={17} /><input required minLength={10} type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></div></Field>
                <Field label="Повторите пароль"><div className="auth-input"><LockKeyhole size={17} /><input required minLength={10} type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></div></Field>
                {message && <div className="auth-message" role="alert">{message}</div>}
                <button className="button button--primary auth-submit" disabled={busy} type="submit"><KeyRound size={17} /> {busy ? 'Создаём доступ…' : 'Создать пароль и войти'}</button>
              </form>
            </>
          ) : (
            <>
              <div className="auth-card__heading"><span>С возвращением</span><h2>Вход в ИКИОМА ОС</h2><p>Введите личный логин или почту и свой пароль.</p></div>
              <form onSubmit={submitLogin} className="auth-form">
                <Field label="Логин или почта"><div className="auth-input"><Mail size={17} /><input required autoCapitalize="none" autoCorrect="off" autoComplete="username" value={login} onChange={(event) => setLogin(event.target.value)} /></div></Field>
                <Field label="Пароль"><div className="auth-input"><LockKeyhole size={17} /><input required type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></div></Field>
                {message && <div className="auth-message" role="alert">{message}</div>}
                {!message && sessionError && <div className="auth-hint">{sessionError}</div>}
                <button className="button button--primary auth-submit" disabled={busy} type="submit"><KeyRound size={17} /> {busy ? 'Проверяем…' : 'Войти в систему'}</button>
              </form>
            </>
          )}
          <p className="auth-card__footer">Доступ создаёт администратор. Общих паролей у команды нет.</p>
        </section>
      </div>
    </main>
  );
}
