import { useEffect, useState } from 'react';
import type { AuthenticatedUser, UserRole } from '../entities/index';
import { requestApi } from '../infrastructure/api-http';
import { clearProjectCache } from '../infrastructure/project-cache';

export function useSession() {
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [role, setRole] = useState<UserRole>('client');
  const [sessionError, setSessionError] = useState('');
  useEffect(() => {
    let active = true;
    void requestApi('/api/session', { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json() as { user?: AuthenticatedUser; error?: string };
        if (!response.ok || !body.user) throw new Error(body.error ?? 'session_unavailable');
        if (!active) return;
        setSession(body.user);
        setRole(body.user.role);
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (import.meta.env.DEV) {
          setSession({
            id: 'owner',
            email: 'vitaliyozolin@gmail.com',
            name: 'Виталий Озолин',
            role: 'management',
            isOwner: true,
          });
          setRole('management');
          return;
        }
        setSessionError(error instanceof Error && error.message === 'access_not_assigned'
          ? 'Ваш аккаунт разрешён на сайте, но роль в проекте ещё не назначена.'
          : 'Не удалось подтвердить рабочий доступ. Обновите страницу или обратитесь к владельцу.');
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!session) return undefined;
    const verifySession = async () => {
      try {
        const response = await requestApi('/api/session', { headers: { Accept: 'application/json' }, cache: 'no-store' });
        if (response.ok) return;
        if (response.status !== 401 && response.status !== 403) return;
      } catch {
        return;
      }
      await clearProjectCache();
      window.location.assign('/login');
    };
    const verifyVisibleSession = () => {
      if (document.visibilityState === 'visible') void verifySession();
    };
    const timer = window.setInterval(() => void verifySession(), 30_000);
    window.addEventListener('focus', verifyVisibleSession);
    window.addEventListener('pageshow', verifyVisibleSession);
    document.addEventListener('visibilitychange', verifyVisibleSession);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', verifyVisibleSession);
      window.removeEventListener('pageshow', verifyVisibleSession);
      document.removeEventListener('visibilitychange', verifyVisibleSession);
    };
  }, [session]);

  return { session, role, sessionError };
}
