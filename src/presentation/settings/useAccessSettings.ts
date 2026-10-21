import { useEffect, useState, type FormEvent } from 'react';
import type { SystemUser, UserRole } from '../../entities/index';
import type { RemoteProjectSnapshot } from '../../application';
import type { createSettingsUseCases } from '../../application';
import type { AccessSnapshot, AccessUser, UserProjectAccess, UserProjectAccessSnapshot, WebAccessStatus, SettingsProps, SettingsTab } from './contracts';
import { useSettingsRequest } from './useSettingsRequest';

export function useAccessSettings({ state, canManageAccess, onServerSnapshot }: SettingsProps, settingsCommands: ReturnType<typeof createSettingsUseCases>, tab: SettingsTab, setIntegrationMessage: (message: string) => void) {
  const { request: requestApi, applySnapshot, isActive } = useSettingsRequest(state.project.id, onServerSnapshot);
  const [rosterExpected, setRosterExpected] = useState('');
  const [showInvite, setShowInvite] = useState(false);
  const [invite, setInvite] = useState({ name: '', email: '', role: 'foreman' as UserRole, telegram: '' });
  const [editingUser, setEditingUser] = useState<SystemUser | null>(null);
  const [accessSnapshot, setAccessSnapshot] = useState<AccessSnapshot | null>(null);
  const [accessBusy, setAccessBusy] = useState<{ userId: string; action: string } | null>(null);
  const [accessErrors, setAccessErrors] = useState<Record<string, string>>({});
  const [accessLink, setAccessLink] = useState<{ userName: string; login: string; url: string; expiresAt?: string; purpose: 'activate' | 'reset' | 'existing' } | null>(null);
  const [projectAccess, setProjectAccess] = useState<{
    user: SystemUser;
    mode: 'issue' | 'manage';
    accountActive: boolean;
    projects: UserProjectAccess[];
    selected: string[];
  } | null>(null);

  const accessErrorText = (code?: string) => ({
    profile_not_saved: 'Профиль ещё сохраняется. Повторите через несколько секунд.',
    project_not_found: 'Проект ещё не сохранён на сервере.',
    user_not_found: 'Профиль ещё не сохранён. Повторите через несколько секунд.',
    duplicate_email: 'Этот email уже назначен другому пользователю проекта.',
    owner_account_reserved: 'Email владельца нельзя использовать для приглашения.',
    user_disabled: 'Сначала разблокируйте пользователя.',
    access_not_active: 'Сначала выдайте и активируйте доступ.',
    owner_required: 'Выдавать и отзывать веб-доступ может только владелец.',
    invalid_user_profile: 'Проверьте имя, email и роль пользователя.',
    revision_conflict: 'Профиль уже изменён. Обновите страницу и повторите.',
    invalid_projects: 'Список проектов изменился. Обновите страницу и выберите проекты заново.',
  }[code ?? ''] ?? 'Не удалось изменить веб-доступ. Обновите страницу и повторите.');

  const refreshAccess = async () => {
    try {
      const response = await requestApi(`/api/access/users?projectId=${encodeURIComponent(state.project.id)}`, { cache: 'no-store' });
      if (response.status === 404) {
        setAccessSnapshot({ authMode: 'sites_sso', users: [] });
        return;
      }
      const body = await response.json() as AccessSnapshot & { ok?: boolean };
      if (!response.ok || !body.ok) throw new Error('access_unavailable');
      setAccessSnapshot({ authMode: body.authMode, users: body.users ?? [] });
    } catch {
      setAccessSnapshot(null);
    }
  };

  useEffect(() => {
    if (tab !== 'access') return;
    void refreshAccess();
  }, [tab, state.project.id, state.settings.users.length]);

  const inviteUser = async (event: FormEvent) => {
    event.preventDefault();
    if (!invite.name.trim() || !invite.email.trim()) return;
    const normalizedEmail = invite.email.trim().toLocaleLowerCase('en-US');
    if (state.settings.users.some((item) => item.email.trim().toLocaleLowerCase('en-US') === normalizedEmail)) {
      setAccessErrors((current) => ({ ...current, new: 'Пользователь с таким email уже есть в проекте.' }));
      return;
    }
    if (canManageAccess && accessSnapshot?.authMode !== 'sites_sso') {
      setAccessBusy({ userId: 'new', action: 'create' });
      try {
        const response = await requestApi('/api/access/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: state.project.id,
            user: { name: invite.name, email: invite.email, role: invite.role, telegram: invite.telegram },
          }),
        });
        const body = await response.json() as { ok?: boolean; error?: string; user?: SystemUser; snapshot?: RemoteProjectSnapshot };
        if (!(response.status === 404 && body.error === 'not_found')) {
          if (!response.ok || !body.ok || !body.user || !body.snapshot) throw new Error(body.error || 'access_error');
          applySnapshot(body.snapshot);
          setShowInvite(false);
          setInvite({ name: '', email: '', role: 'foreman', telegram: '' });
          setAccessErrors((current) => ({ ...current, new: '' }));
          await openProjectAccess(body.user, 'issue');
          return;
        }
      } catch (error) {
        setAccessErrors((current) => ({ ...current, new: accessErrorText(error instanceof Error ? error.message : '') }));
        return;
      } finally {
        setAccessBusy(null);
      }
    }
    const result = settingsCommands.execute({ kind: 'user', expected: rosterExpected, ...invite });
    if (!result.ok) { setAccessErrors(current => ({ ...current, new: result.error })); return; }
    setShowInvite(false);
    setInvite({ name: '', email: '', role: 'foreman', telegram: '' });
    setAccessErrors((current) => ({ ...current, new: '' }));
  };

  const saveUser = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingUser?.name.trim() || !editingUser.email.trim()) return;
    if (canManageAccess && accessSnapshot?.authMode !== 'sites_sso') {
      setAccessBusy({ userId: editingUser.id, action: 'profile' });
      try {
        const response = await requestApi(`/api/access/users/${encodeURIComponent(editingUser.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: state.project.id,
            user: {
              name: editingUser.name,
              email: editingUser.email,
              role: editingUser.role,
              telegram: editingUser.telegram ?? '',
            },
          }),
        });
        const body = await response.json() as { ok?: boolean; error?: string; snapshot?: RemoteProjectSnapshot };
        if (!(response.status === 404 && body.error === 'not_found')) {
          if (!response.ok || !body.ok || !body.snapshot) throw new Error(body.error || 'access_error');
          applySnapshot(body.snapshot);
          setEditingUser(null);
          await refreshAccess();
          return;
        }
      } catch (error) {
        setAccessErrors((current) => ({ ...current, [editingUser.id]: accessErrorText(error instanceof Error ? error.message : '') }));
        return;
      } finally {
        setAccessBusy(null);
      }
    }
    const result = settingsCommands.execute({ kind: 'user', expected: rosterExpected, id: editingUser.id, name: editingUser.name, email: editingUser.email, role: editingUser.role, telegram: editingUser.telegram ?? '' });
    if (!result.ok) { setAccessErrors(current => ({ ...current, [editingUser.id]: result.error })); return; }
    setEditingUser(null);
    window.setTimeout(() => void refreshAccess(), 1_000);
  };

  const webAccessFor = (user: SystemUser): AccessUser['web'] => {
    if (user.id === 'user-owner') return { status: 'active', lastLoginAt: user.lastActiveAt };
    return accessSnapshot?.users.find((item) => item.userId === user.id)?.web
      ?? { status: user.status === 'disabled' ? 'blocked' : 'not_issued' };
  };

  const telegramAccessFor = (user: SystemUser): AccessUser['telegram'] => accessSnapshot?.users
    .find((item) => item.userId === user.id)?.telegram
    ?? { status: 'not_connected' };

  const openProjectAccess = async (user: SystemUser, mode: 'issue' | 'manage') => {
    setAccessBusy({ userId: user.id, action: 'projects' });
    setAccessErrors((current) => ({ ...current, [user.id]: '' }));
    try {
      const response = await requestApi(
        `/api/access/users/${encodeURIComponent(user.id)}/projects?projectId=${encodeURIComponent(state.project.id)}`,
        { cache: 'no-store' },
      );
      const body = await response.json() as UserProjectAccessSnapshot & { ok?: boolean; error?: string };
      if (!response.ok || !body.ok || !Array.isArray(body.projects)) throw new Error(body.error || 'access_error');
      const alreadySelected = body.projects.filter((project) => project.selected).map((project) => project.id);
      const selected = mode === 'issue' && !body.accountActive && alreadySelected.length === 0
        ? body.projects.map((project) => project.id)
        : mode === 'issue' && body.accountActive
          ? [...new Set([...alreadySelected, state.project.id])]
          : alreadySelected;
      setProjectAccess({ user, mode, accountActive: body.accountActive, projects: body.projects, selected });
    } catch (error) {
      setAccessErrors((current) => ({
        ...current,
        [user.id]: accessErrorText(error instanceof Error ? error.message : ''),
      }));
    } finally {
      setAccessBusy(null);
    }
  };

  const saveProjectAccess = async () => {
    if (!projectAccess) return;
    if (projectAccess.mode === 'issue' && !projectAccess.selected.includes(state.project.id)) {
      setAccessErrors((current) => ({
        ...current,
        [projectAccess.user.id]: 'Оставьте текущий проект выбранным, чтобы выпустить ссылку активации.',
      }));
      return;
    }
    if (!projectAccess.selected.length && !window.confirm(`Закрыть ${projectAccess.user.name} доступ ко всем проектам?`)) return;
    setAccessBusy({ userId: projectAccess.user.id, action: 'projects' });
    setAccessErrors((current) => ({ ...current, [projectAccess.user.id]: '' }));
    try {
      const response = await requestApi(`/api/access/users/${encodeURIComponent(projectAccess.user.id)}/projects`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: state.project.id, projectIds: projectAccess.selected }),
      });
      const body = await response.json() as UserProjectAccessSnapshot & { ok?: boolean; error?: string; snapshot?: RemoteProjectSnapshot | null };
      if (!response.ok || !body.ok) throw new Error(body.error || 'access_error');
      if (body.snapshot?.projectId === state.project.id) applySnapshot(body.snapshot);
      const user = projectAccess.user;
      const shouldIssue = projectAccess.mode === 'issue';
      setProjectAccess(null);
      await refreshAccess();
      if (shouldIssue) await issueWebLink(user);
    } catch (error) {
      setAccessErrors((current) => ({
        ...current,
        [projectAccess.user.id]: accessErrorText(error instanceof Error ? error.message : ''),
      }));
    } finally {
      setAccessBusy(null);
    }
  };

  const issueWebLink = async (user: SystemUser, reset = false, retryOnce = false) => {
    setAccessBusy({ userId: user.id, action: reset ? 'reset' : 'invite' });
    setAccessErrors((current) => ({ ...current, [user.id]: '' }));
    try {
      const request = async () => {
        const response = await requestApi(reset ? '/api/access/web/reset' : '/api/access/web/invitations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: state.project.id, userId: user.id }),
        });
        const body = await response.json() as { ok?: boolean; url?: string; expiresAt?: string | null; login?: string; purpose?: 'activate' | 'reset' | 'existing'; existingAccount?: boolean; error?: string };
        return { response, body };
      };
      let result = await request();
      if (retryOnce && result.body.error === 'user_not_found') {
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        result = await request();
      }
      if (!result.response.ok || !result.body.ok || !result.body.url || !result.body.login || (!result.body.existingAccount && !result.body.expiresAt)) {
        throw new Error(result.body.error || 'access_error');
      }
      setAccessLink({
        userName: user.name,
        login: result.body.login,
        url: result.body.url,
        expiresAt: result.body.expiresAt ?? undefined,
        purpose: result.body.purpose ?? (reset ? 'reset' : 'activate'),
      });
      await refreshAccess();
    } catch (error) {
      setAccessErrors((current) => ({
        ...current,
        [user.id]: accessErrorText(error instanceof Error ? error.message : ''),
      }));
    } finally {
      setAccessBusy(null);
    }
  };

  const changeWebAccess = async (user: SystemUser, action: 'block' | 'unblock' | 'sessions/revoke') => {
    const question = action === 'block'
      ? `Заблокировать ${user.name}? Все веб-сессии завершатся сразу, Telegram-привязка сохранится.`
      : action === 'unblock'
        ? `Разблокировать веб-доступ для ${user.name}?`
        : `Завершить все веб-сессии пользователя ${user.name}?`;
    if (!window.confirm(question)) return;
    setAccessBusy({ userId: user.id, action });
    setAccessErrors((current) => ({ ...current, [user.id]: '' }));
    try {
      const response = await requestApi(`/api/access/users/${encodeURIComponent(user.id)}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: state.project.id }),
      });
      const body = await response.json() as { ok?: boolean; error?: string; status?: WebAccessStatus };
      if (!response.ok || !body.ok) throw new Error(body.error || 'access_error');
      await refreshAccess();
      if (isActive() && action !== 'sessions/revoke') window.location.reload();
    } catch (error) {
      setAccessErrors((current) => ({
        ...current,
        [user.id]: accessErrorText(error instanceof Error ? error.message : ''),
      }));
    } finally {
      setAccessBusy(null);
    }
  };

  const disconnectTelegram = async (user: SystemUser) => {
    if (!window.confirm(`Отключить Telegram пользователя ${user.name}? Веб-доступ и пароль не изменятся.`)) return;
    setAccessBusy({ userId: user.id, action: 'telegram-unlink' });
    setIntegrationMessage(`Отключаем Telegram пользователя ${user.name}…`);
    try {
      const response = await requestApi('/api/integrations/telegram/unlink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: state.project.id, userId: user.id }),
      });
      const body = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !body.ok) throw new Error(body.error || 'telegram_unlink_failed');
      setIntegrationMessage(`Telegram пользователя ${user.name} отключён. Веб-доступ сохранён.`);
      await refreshAccess();
    } catch {
      setIntegrationMessage('Не удалось отключить Telegram. Обновите страницу и повторите.');
    } finally {
      setAccessBusy(null);
    }
  };

  const webStatusView = (user: SystemUser) => {
    if (user.id === 'user-owner') return { label: 'Владелец', tone: 'blue' as const };
    if (accessSnapshot?.authMode === 'sites_sso') return { label: 'Через ChatGPT', tone: 'blue' as const };
    const web = webAccessFor(user);
    if (web.status === 'active') return { label: 'Активен', tone: 'positive' as const };
    if (web.status === 'pending') return { label: web.expiresAt ? `До ${new Date(web.expiresAt).toLocaleDateString('ru-RU')}` : 'Ожидает активации', tone: 'warning' as const };
    if (web.status === 'expired') return { label: 'Ссылка истекла', tone: 'warning' as const };
    if (web.status === 'blocked') return { label: 'Заблокирован', tone: 'danger' as const };
    return { label: 'Не выдан', tone: 'neutral' as const };
  };

  return { rosterExpected, setRosterExpected, showInvite, setShowInvite, invite, setInvite, editingUser, setEditingUser, accessSnapshot, accessBusy, accessErrors, accessLink, setAccessLink, projectAccess, setProjectAccess, inviteUser, saveUser, webAccessFor, telegramAccessFor, openProjectAccess, saveProjectAccess, issueWebLink, changeWebAccess, disconnectTelegram, webStatusView };
}
