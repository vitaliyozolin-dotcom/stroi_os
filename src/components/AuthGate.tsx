import { useState, type FormEvent } from 'react';
import { KeyRound, LockKeyhole, Mail, ShieldCheck } from 'lucide-react';
import { Field } from './Ui';

const messageFor = (error: string) => ({
  invalid_credentials: 'Неверная почта, логин или пароль.',
  too_many_attempts: 'Слишком много попыток. Подождите 15 минут.',
  invite_expired: 'Ссылка уже использована или её срок истёк. Попросите выдать доступ повторно.',
  password_too_short: 'Пароль должен содержать не менее 12 символов.',
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
      <section className="auth-card">
        <div className="auth-card__brand"><span><ShieldCheck size={25} /></span><div><strong>СТРОЙОС</strong><small>закрытый рабочий контур</small></div></div>
        {inviteToken ? (
          <>
            <div className="auth-card__heading"><h1>Создайте пароль</h1><p>После этого вы сразу войдёте в СтройОС с назначенной ролью.</p></div>
            <form onSubmit={acceptInvite} className="auth-form">
              <Field label="Новый пароль" hint="Не менее 12 символов"><div className="auth-input"><LockKeyhole size={17} /><input required minLength={12} type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></div></Field>
              <Field label="Повторите пароль"><div className="auth-input"><LockKeyhole size={17} /><input required minLength={12} type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></div></Field>
              {message && <div className="auth-message" role="alert">{message}</div>}
              <button className="button button--primary auth-submit" disabled={busy} type="submit"><KeyRound size={17} /> {busy ? 'Создаём доступ…' : 'Создать пароль и войти'}</button>
            </form>
          </>
        ) : (
          <>
            <div className="auth-card__heading"><h1>Вход в систему</h1><p>Используйте почту, на которую пришло приглашение, и свой пароль.</p></div>
            <form onSubmit={submitLogin} className="auth-form">
              <Field label="Почта или логин"><div className="auth-input"><Mail size={17} /><input required autoComplete="username" value={login} onChange={(event) => setLogin(event.target.value)} /></div></Field>
              <Field label="Пароль"><div className="auth-input"><LockKeyhole size={17} /><input required type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></div></Field>
              {message && <div className="auth-message" role="alert">{message}</div>}
              {!message && sessionError && <div className="auth-hint">{sessionError}</div>}
              <button className="button button--primary auth-submit" disabled={busy} type="submit"><KeyRound size={17} /> {busy ? 'Проверяем…' : 'Войти'}</button>
            </form>
          </>
        )}
        <p className="auth-card__footer">Доступ выдаёт руководитель проекта. Пароли по почте не отправляются.</p>
      </section>
    </main>
  );
}
