import { requestApi } from '../infrastructure/api-http';
import { createSettingsCommands } from '../application';
import { runtimeIdGenerator, systemClock } from '../infrastructure/runtime';
import { useEffect, useState, type FormEvent } from 'react';
import {
  BellRing,
  Bot,
  Camera,
  Check,
  FolderKanban,
  Globe2,
  LayoutDashboard,
  Link2,
  LockKeyhole,
  Mail,
  Plus,
  Pencil,
  Send,
  Settings2,
  ShieldCheck,
  UserCog,
} from 'lucide-react';
import { formatDateTime, uid } from '../domain';
import type { AppState, DashboardWidget, NotificationSettings, SystemUser, UserRole } from '../entities/index';
import type { RemoteSnapshot } from '../storage';
import { Field, Modal, SectionHeader, StatusBadge } from '../components/Ui';

type SettingsTab = 'access' | 'dashboard' | 'notifications' | 'integrations';
type WebAccessStatus = 'not_issued' | 'pending' | 'active' | 'expired' | 'blocked';
type AccessUser = {
  userId: string;
  web: { status: WebAccessStatus; invitedAt?: string; expiresAt?: string; activatedAt?: string; lastLoginAt?: string };
  telegram: { status: 'connected' | 'not_connected'; boundAt?: string; username?: string };
};
type AccessSnapshot = { authMode: 'local_password' | 'sites_sso'; users: AccessUser[] };
type UserProjectAccess = {
  id: string;
  code: string;
  name: string;
  selected: boolean;
  status: WebAccessStatus;
  role: UserRole;
};
type UserProjectAccessSnapshot = { accountActive: boolean; projects: UserProjectAccess[] };
type TelegramCandidate = { id: string; title: string; type: string };
type IntegrationStatus = {
  email: boolean;
  telegram: boolean;
  telegramBot?: boolean;
  telegramBotUsername?: string;
  telegramCommon?: boolean;
  telegramCommonTitle?: string;
  telegramCandidates?: TelegramCandidate[];
  telegramIssue?: string;
  telegramInbound?: boolean;
  telegramBoundUsers?: number;
  telegramPendingMessages?: number;
  telegramDeadMessages?: number;
  telegramLastDeliveryError?: string;
  camera: boolean;
  websiteForm: boolean;
  publicWebsiteForm: boolean;
};

const roleLabels: Record<UserRole, string> = { management: 'Управление', foreman: 'Прораб', client: 'Клиент' };
const widgetLabels: Record<DashboardWidget, { title: string; text: string }> = {
  project: { title: 'Карточка проекта', text: 'Дом, адрес и быстрые действия' },
  progress: { title: 'Физический прогресс', text: 'Факт и принятый объём работ' },
  finance: { title: 'Экономика проекта', text: 'План, факт и прогноз маржи' },
  decisions: { title: 'Требует решения', text: 'Блокеры, риски и ответы клиента' },
  cashflow: { title: 'Денежный поток', text: 'Поступления и выплаты по неделям' },
  quality: { title: 'Контроль качества', text: 'Проверки и скрытые работы' },
  supply: { title: 'Ближайшие поставки', text: 'Закупки и риски сроков' },
  tasks: { title: 'Задачи команды', text: 'Ответственные, сроки и просрочки' },
  activity: { title: 'Журнал проекта', text: 'Последние изменения участников' },
};
const eventLabels: Record<keyof NotificationSettings['events'], { title: string; text: string }> = {
  financeApproval: { title: 'Согласование оплаты', text: 'Расход готов к приёмке или оплате' },
  supplyRisk: { title: 'Риск поставки', text: 'Срок, цена или поставщик требуют внимания' },
  qualityRework: { title: 'Возврат на доработку', text: 'Технадзор отклонил работу' },
  leadWithoutAction: { title: 'Заявка без действия', text: 'Менеджер пропустил следующий контакт' },
  scheduleDelay: { title: 'Отклонение от графика', text: 'Прогноз этапа вышел за план' },
  taskAssigned: { title: 'Новая задача', text: 'Назначен ответственный или задача передана другому' },
  taskOverdue: { title: 'Просрочка задачи', text: 'Срок прошёл, а задача не закрыта' },
  projectActivity: { title: 'Все изменения проекта', text: 'Отправлять изменения объекта в общий Telegram-чат' },
};

function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: () => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" disabled={disabled} aria-checked={checked} aria-label={label} className={checked ? 'toggle toggle--on' : 'toggle'} onClick={onChange}><span /></button>;
}

export function SettingsPage({ state, actor, canManageAccess, onChange, onServerSnapshot }: { state: AppState; actor: string; canManageAccess: boolean; onChange: (next: AppState) => void; onServerSnapshot: (snapshot: RemoteSnapshot) => void }) {
  const saveChange = createSettingsCommands(state, actor, systemClock, runtimeIdGenerator, onChange);
  const [tab, setTab] = useState<SettingsTab>('access');
  const [showInvite, setShowInvite] = useState(false);
  const [invite, setInvite] = useState({ name: '', email: '', role: 'foreman' as UserRole, telegram: '' });
  const [editingUser, setEditingUser] = useState<SystemUser | null>(null);
  const [integrationStatus, setIntegrationStatus] = useState<IntegrationStatus | null>(null);
  const [integrationMessage, setIntegrationMessage] = useState('');
  const [integrationChecking, setIntegrationChecking] = useState(false);
  const [telegramLink, setTelegramLink] = useState<{ userName: string; url: string; expiresAt: string } | null>(null);
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

  const refreshIntegrationStatus = async (): Promise<IntegrationStatus | null> => {
    try {
      const response = await requestApi('/api/integrations/status', { cache: 'no-store' });
      const body = await response.json() as { integrations?: IntegrationStatus };
      const nextStatus = response.ok ? body.integrations ?? null : null;
      setIntegrationStatus(nextStatus);
      return nextStatus;
    } catch {
      setIntegrationStatus(null);
      return null;
    }
  };

  const recheckTelegram = async () => {
    setIntegrationChecking(true);
    setIntegrationMessage('Ищем сообщение от бота в Telegram-группе…');
    const status = await refreshIntegrationStatus();
    const command = status?.telegramBotUsername ? `/start@${status.telegramBotUsername}` : '/start@ikioma_bot';
    if (!status) {
      setIntegrationMessage('Не удалось связаться с сервером ИКИОМА ОС. Обновите страницу и повторите.');
    } else if (status.telegramCommon) {
      setIntegrationMessage(`Общий чат «${status.telegramCommonTitle || 'ИкиОМА'}» подключён. Проверочное сообщение отправлено ботом.`);
    } else if (status.telegramCandidates?.length) {
      setIntegrationMessage('Бот увидел несколько групп. Выберите нужный чат в карточке Telegram.');
    } else {
      setIntegrationMessage(`Группа пока не найдена. Отправьте ${command} в группе «ИкиОМА», затем нажмите кнопку ещё раз.`);
    }
    setIntegrationChecking(false);
  };

  useEffect(() => {
    if (tab !== 'integrations' && tab !== 'notifications') return;
    void refreshIntegrationStatus();
  }, [tab]);

  useEffect(() => {
    if (tab !== 'access') return;
    void refreshAccess();
  }, [tab, state.project.id, state.settings.users.length]);

  const saveSettings = (settings: AppState['settings'], text: string) => saveChange({
    ...state,
    settings,
    activity: [{ id: uid('activity'), timestamp: new Date().toISOString(), actor, text, tone: 'neutral' }, ...state.activity],
  });

  const toggleWidget = (widget: DashboardWidget) => {
    const current = state.settings.dashboardWidgets;
    const dashboardWidgets = current.includes(widget) ? current.filter((item) => item !== widget) : [...current, widget];
    saveSettings({ ...state.settings, dashboardWidgets }, `Настроен главный дашборд: ${widgetLabels[widget].title}`);
  };

  const toggleChannel = (channel: keyof NotificationSettings['channels']) => saveSettings({
    ...state.settings,
    notifications: { ...state.settings.notifications, channels: { ...state.settings.notifications.channels, [channel]: !state.settings.notifications.channels[channel] } },
  }, `Канал уведомлений «${channel}» ${state.settings.notifications.channels[channel] ? 'выключен' : 'включён'}`);

  const toggleEvent = (event: keyof NotificationSettings['events']) => saveSettings({
    ...state.settings,
    notifications: { ...state.settings.notifications, events: { ...state.settings.notifications.events, [event]: !state.settings.notifications.events[event] } },
  }, `Правило уведомлений «${eventLabels[event].title}» обновлено`);

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
        const body = await response.json() as { ok?: boolean; error?: string; user?: SystemUser; snapshot?: RemoteSnapshot };
        if (!(response.status === 404 && body.error === 'not_found')) {
          if (!response.ok || !body.ok || !body.user || !body.snapshot) throw new Error(body.error || 'access_error');
          onServerSnapshot(body.snapshot);
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
    const user: SystemUser = { id: uid('user'), name: invite.name.trim(), email: invite.email.trim(), role: invite.role, telegram: invite.telegram.trim() || undefined, status: 'active', invitedAt: new Date().toISOString(), inviteDelivery: 'draft' };
    saveSettings({ ...state.settings, users: [...state.settings.users, user] }, `Добавлен участник ${user.name} · ${roleLabels[user.role]}. Доступ ещё не отправлен`);
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
        const body = await response.json() as { ok?: boolean; error?: string; snapshot?: RemoteSnapshot };
        if (!(response.status === 404 && body.error === 'not_found')) {
          if (!response.ok || !body.ok || !body.snapshot) throw new Error(body.error || 'access_error');
          onServerSnapshot(body.snapshot);
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
    saveSettings({ ...state.settings, users: state.settings.users.map((user) => user.id === editingUser.id ? { ...editingUser, name: editingUser.name.trim(), email: editingUser.email.trim(), telegram: editingUser.telegram?.trim() || undefined } : user) }, `Обновлены роль и доступ пользователя ${editingUser.name}`);
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
      const body = await response.json() as UserProjectAccessSnapshot & { ok?: boolean; error?: string; snapshot?: RemoteSnapshot | null };
      if (!response.ok || !body.ok) throw new Error(body.error || 'access_error');
      if (body.snapshot?.projectId === state.project.id) onServerSnapshot(body.snapshot);
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
      if (action !== 'sessions/revoke') window.location.reload();
    } catch (error) {
      setAccessErrors((current) => ({
        ...current,
        [user.id]: accessErrorText(error instanceof Error ? error.message : ''),
      }));
    } finally {
      setAccessBusy(null);
    }
  };

  const testIntegration = async (channel: 'email' | 'telegram') => {
    setIntegrationMessage('Проверяем подключение…');
    try {
      const response = await requestApi('/api/integrations/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, to: state.settings.users.find((user) => user.role === 'management')?.email, message: `ИКИОМА ОС: тест канала ${channel === 'email' ? 'Email' : 'Telegram'} для проекта ${state.project.code}` }) });
      const body = await response.json();
      setIntegrationMessage(response.ok && body.ok
        ? `Тест ${channel === 'email' ? 'Email' : 'Telegram'} отправлен.`
        : body.error === 'email_not_configured'
          ? 'Email ещё не подключён: нужен ключ Resend и подтверждённый адрес отправителя.'
          : ['telegram_not_configured', 'chat_not_found'].includes(body.error)
            ? 'Бот пока не видит общий чат. Отправьте в группе команду запуска и нажмите «Проверить ещё раз».'
            : body.error === 'chat_ambiguous'
              ? 'Бот видит несколько групп. Выберите нужный общий чат ниже.'
              : body.error === 'invalid_token'
                ? 'Telegram не принял токен бота.'
                : 'Провайдер не принял тест. Проверьте подключение и права бота.');
    } catch { setIntegrationMessage('Сервер проверки временно недоступен.'); }
  };

  const selectTelegramChat = async (candidate: TelegramCandidate) => {
    setIntegrationMessage(`Подключаем чат «${candidate.title}»…`);
    try {
      const response = await requestApi('/api/integrations/telegram/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: candidate.id }),
      });
      const body = await response.json();
      if (!response.ok || !body.ok) {
        setIntegrationMessage(body.error === 'send_failed'
          ? 'Бот видит чат, но не может отправлять сообщения. Проверьте, что он остаётся участником группы.'
          : 'Не удалось подключить этот чат. Отправьте в группе новую команду и повторите.');
        return;
      }
      setIntegrationMessage(`Общий чат «${body.chat?.title ?? candidate.title}» подключён. Проверочное сообщение отправлено.`);
      await refreshIntegrationStatus();
    } catch {
      setIntegrationMessage('Сервер проверки временно недоступен.');
    }
  };

  const createTelegramLink = async (user: SystemUser) => {
    setIntegrationMessage(`Готовим персональную Telegram-ссылку для ${user.name}…`);
    try {
      const response = await requestApi('/api/integrations/telegram/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: state.project.id, userId: user.id }),
      });
      const body = await response.json() as { ok?: boolean; url?: string; expiresAt?: string; error?: string };
      if (!response.ok || !body.ok || !body.url || !body.expiresAt) {
        setIntegrationMessage(body.error === 'telegram_not_configured'
          ? 'Сначала завершите подключение Telegram-бота.'
          : 'Не удалось выпустить ссылку. Обновите страницу и повторите.');
        return;
      }
      setTelegramLink({ userName: user.name, url: body.url, expiresAt: body.expiresAt });
      setIntegrationMessage(`Ссылка для ${user.name} готова и действует 24 часа.`);
    } catch {
      setIntegrationMessage('Сервер Telegram-привязки временно недоступен.');
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

  const telegramCommand = integrationStatus?.telegramBotUsername ? `/start@${integrationStatus.telegramBotUsername}` : '/start';
  const telegramHeadquartersReady = Boolean(integrationStatus?.telegramCommon && integrationStatus?.telegramInbound);
  const telegramStatusLabel = integrationStatus?.telegramCommon
    ? integrationStatus.telegramCommonTitle || 'Общий чат подключён'
    : integrationStatus?.telegramIssue === 'invalid_token'
      ? 'Токен не принят'
      : integrationStatus?.telegramCandidates?.length
        ? 'Выберите общий чат'
        : integrationStatus?.telegramBot
          ? 'Бот подключён, ждём чат'
          : 'Нужен токен бота';

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

  const tabs: Array<{ id: SettingsTab; label: string; icon: typeof Settings2 }> = [
    { id: 'access', label: 'Доступы', icon: UserCog },
    { id: 'dashboard', label: 'Главный экран', icon: LayoutDashboard },
    { id: 'notifications', label: 'Уведомления', icon: BellRing },
    { id: 'integrations', label: 'Интеграции', icon: Bot },
  ];

  return (
    <div className="page-stack">
      <section className="page-title-row">
        <div><span className="eyebrow">Администрирование</span><h1>Настройки системы</h1><p>Роли и доступы, состав главного экрана, правила уведомлений и внешние подключения.</p></div>
      </section>

      <div className="settings-layout">
        <aside className="settings-tabs">{tabs.map((item) => { const Icon = item.icon; return <button type="button" key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}><Icon size={18} /><span>{item.label}</span></button>; })}</aside>
        <div className="settings-content">
          {tab === 'access' && (
            <>
              <section className="panel settings-panel"><SectionHeader eyebrow="Команда" title="Пользователи и роли" action={<button type="button" className="button button--primary button--compact" disabled={!canManageAccess} title={canManageAccess ? '' : 'Добавлять пользователей может только владелец'} onClick={() => setShowInvite(true)}><Plus size={16} /> Добавить</button>} />
                <div className="user-list">
                  <div className="user-list__head"><span>Пользователь</span><span>Роль</span><span>Веб-доступ</span><span>Telegram</span><span>Последний вход</span><span>Действия</span></div>
                  {state.settings.users.map((user) => {
                    const web = webAccessFor(user);
                    const telegram = telegramAccessFor(user);
                    const webView = webStatusView(user);
                    const busy = accessBusy?.userId === user.id;
                    const localAccess = canManageAccess && accessSnapshot?.authMode !== 'sites_sso' && user.id !== 'user-owner';
                    return <article key={user.id} className="user-row">
                      <span className="user-row__avatar">{user.name.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span>
                      <div className="user-row__identity"><strong>{user.name}</strong><small>{user.email}</small></div>
                      <span className="user-row__role"><StatusBadge label={roleLabels[user.role]} tone={user.role === 'management' ? 'blue' : 'neutral'} /></span>
                      <span className="user-row__web"><StatusBadge label={webView.label} tone={webView.tone} /></span>
                      <span className="user-row__telegram"><StatusBadge label={telegram.status === 'connected' ? 'Подключён' : 'Не подключён'} tone={telegram.status === 'connected' ? 'positive' : 'neutral'} /></span>
                      <small className="user-row__last">{web.lastLoginAt ? formatDateTime(web.lastLoginAt) : 'Ещё не входил'}</small>
                      <span className="user-row__actions access-actions">
                        {localAccess && ['not_issued', 'expired'].includes(web.status) && <button type="button" disabled={busy} onClick={() => void openProjectAccess(user, 'issue')}>{web.status === 'expired' ? 'Новая ссылка' : 'Выдать доступ'}</button>}
                        {localAccess && web.status === 'pending' && <button type="button" disabled={busy} onClick={() => void issueWebLink(user)}>Перевыпустить</button>}
                        {localAccess && ['pending', 'active', 'blocked'].includes(web.status) && <button type="button" disabled={busy} onClick={() => void openProjectAccess(user, 'manage')}>Проекты</button>}
                        {localAccess && web.status === 'active' && <button type="button" disabled={busy} onClick={() => void issueWebLink(user, true)}>Сбросить пароль</button>}
                        {localAccess && web.status === 'active' && <button type="button" disabled={busy} onClick={() => void changeWebAccess(user, 'sessions/revoke')}>Завершить сессии</button>}
                        {localAccess && web.status === 'active' && <button type="button" className="danger" disabled={busy} onClick={() => void changeWebAccess(user, 'block')}>Заблокировать</button>}
                        {localAccess && web.status === 'blocked' && <button type="button" disabled={busy} onClick={() => void changeWebAccess(user, 'unblock')}>Разблокировать</button>}
                        {canManageAccess && telegram.status === 'not_connected' && <button type="button" disabled={busy || user.status === 'disabled'} onClick={() => void createTelegramLink(user)}>Подключить Telegram</button>}
                        {canManageAccess && telegram.status === 'connected' && <button type="button" className="danger" disabled={busy} onClick={() => void disconnectTelegram(user)}>Отключить Telegram</button>}
                        <button type="button" aria-label={`Редактировать ${user.name}`} disabled={!canManageAccess || busy || user.id === 'user-owner'} onClick={() => setEditingUser({ ...user })}><Pencil size={15} /></button>
                      </span>
                      {accessErrors[user.id] && <small className="access-inline-error" role="status" aria-live="polite">{accessErrors[user.id]}</small>}
                    </article>;
                  })}
                </div>
                {integrationMessage && <div className="integration-result" role="status" aria-live="polite">{integrationMessage}</div>}
                {!canManageAccess && <div className="settings-note"><ShieldCheck size={18} /><span>Выдавать, блокировать и сбрасывать веб-доступ может только владелец системы.</span></div>}
              </section>
              <section className="panel settings-panel"><SectionHeader eyebrow="Матрица" title="Что видит каждая роль" />
                <div className="permission-table"><div className="permission-table__head"><strong>Раздел</strong><strong>Управление</strong><strong>Прораб</strong><strong>Клиент</strong></div>{[
                  ['Финансы и маржа', true, false, false], ['Маркетинг и заявки', true, false, false], ['Все задачи / только свои', true, true, false], ['Этапы и график', true, true, true], ['Снабжение', true, true, false], ['Контроль качества', true, true, true], ['Настройки и доступы', true, false, false],
                ].map(([label, management, foreman, client]) => <div className="permission-table__row" key={String(label)}><span>{String(label)}</span>{[management, foreman, client].map((allowed, index) => <span key={index}>{allowed ? <Check size={17} /> : '—'}</span>)}</div>)}</div>
                <div className="settings-note"><LockKeyhole size={18} /><span>{accessSnapshot?.authMode === 'sites_sso' ? 'На резервном стенде вход выполняется через аккаунт ChatGPT, а список разрешённых email управляется владельцем сайта.' : 'Email — это логин сотрудника. Владелец выдаёт одноразовую ссылку на 7 дней; человек сам задаёт пароль. Telegram подключается отдельно и не даёт веб-доступ.'}</span></div>
              </section>
            </>
          )}

          {tab === 'dashboard' && <section className="panel settings-panel"><SectionHeader eyebrow="Персонализация" title="Блоки главного экрана" /><div className="settings-list">{(Object.keys(widgetLabels) as DashboardWidget[]).map((widget) => <div className="settings-list__row" key={widget}><span><strong>{widgetLabels[widget].title}</strong><small>{widgetLabels[widget].text}</small></span><Toggle label={widgetLabels[widget].title} checked={state.settings.dashboardWidgets.includes(widget)} onChange={() => toggleWidget(widget)} /></div>)}</div></section>}

          {tab === 'notifications' && (
            <>
              <section className="panel settings-panel"><SectionHeader eyebrow="Каналы" title="Куда отправлять" /><div className="channel-grid"><article><span><Mail size={20} /></span><div><strong>Email</strong><small>{integrationStatus?.email ? 'Сводки и критичные события' : 'Сначала подключите Resend'}</small></div><Toggle label="Email" disabled={!integrationStatus?.email} checked={Boolean(integrationStatus?.email && state.settings.notifications.channels.email)} onChange={() => toggleChannel('email')} /></article><article><span><Send size={20} /></span><div><strong>Telegram</strong><small>{integrationStatus?.telegramCommon ? `${integrationStatus.telegramCommonTitle || 'Общий чат'} · личных адресатов: ${integrationStatus.telegramBoundUsers ?? state.settings.users.filter((user) => user.telegramChatId).length}` : 'Сначала подключите бота и общий чат'}</small></div><Toggle label="Telegram" disabled={!integrationStatus?.telegramCommon} checked={Boolean(integrationStatus?.telegramCommon && state.settings.notifications.channels.telegram)} onChange={() => toggleChannel('telegram')} /></article><article><span><Globe2 size={20} /></span><div><strong>В браузере</strong><small>Центр уведомлений ИКИОМА ОС</small></div><Toggle label="В браузере" checked={state.settings.notifications.channels.browser} onChange={() => toggleChannel('browser')} /></article></div></section>
              <section className="panel settings-panel"><SectionHeader eyebrow="Правила" title="О каких событиях сообщать" /><div className="settings-list">{(Object.keys(eventLabels) as Array<keyof NotificationSettings['events']>).map((event) => <div className="settings-list__row" key={event}><span><strong>{eventLabels[event].title}</strong><small>{eventLabels[event].text}</small></span><Toggle label={eventLabels[event].title} checked={state.settings.notifications.events[event]} onChange={() => toggleEvent(event)} /></div>)}</div></section>
            </>
          )}

          {tab === 'integrations' && (
            <section className="panel settings-panel">
              <SectionHeader eyebrow="Подключения" title="Источники данных и уведомлений" />
              <div className="integration-grid">
                <article>
                  <span><Globe2 size={21} /></span>
                  <div><strong>Формы на ikioma.ru</strong><p>Заявки с публичного сайта поступают в отдельную воронку ИКИОМА и сохраняются с точным временем отправки.</p></div>
                  <StatusBadge label={integrationStatus?.publicWebsiteForm ? 'Принимает заявки' : 'Только внутри'} tone={integrationStatus?.publicWebsiteForm ? 'positive' : 'warning'} />
                </article>
                <article>
                  <span><Send size={21} /></span>
                  <div>
                    <strong>Telegram-бот и общий чат</strong>
                    <p>{integrationStatus?.telegramCommon
                      ? integrationStatus.telegramInbound
                        ? `Полевой штаб работает: изменения уходят в «${integrationStatus.telegramCommonTitle || 'общий чат'}», а команды, задачи и файлы принимаются обратно.${integrationStatus.telegramDeadMessages ? ` Требуют проверки: ${integrationStatus.telegramDeadMessages}.` : integrationStatus.telegramPendingMessages ? ` В очереди доставки: ${integrationStatus.telegramPendingMessages}.` : ' Очередь доставки пуста.'}`
                        : `Исходящие уведомления работают; входящие команды ещё не подключены.`
                      : `Добавьте бота в общий чат, отправьте там ${telegramCommand} — ИКИОМА ОС найдёт группу автоматически.`}</p>
                  </div>
                  <StatusBadge label={telegramHeadquartersReady ? 'Полевой штаб готов' : telegramStatusLabel} tone={telegramHeadquartersReady ? 'positive' : integrationStatus?.telegramIssue === 'invalid_token' ? 'warning' : 'neutral'} />
                  {integrationStatus?.telegramCandidates?.length ? (
                    <div className="telegram-chat-options">
                      <small>Бот видит несколько групп. Какая из них общая?</small>
                      {integrationStatus.telegramCandidates.map((candidate) => (
                        <button type="button" className="text-button" key={candidate.id} onClick={() => void selectTelegramChat(candidate)}>
                          Подключить «{candidate.title}»
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {integrationStatus?.telegramCommon
                    ? <button type="button" className="text-button integration-action" onClick={() => void testIntegration('telegram')}>Отправить тест в общий чат</button>
                    : integrationStatus?.telegramBot
                      ? <button type="button" className="text-button integration-action" disabled={integrationChecking} onClick={() => void recheckTelegram()}>{integrationChecking ? 'Проверяем…' : 'Проверить ещё раз'}</button>
                      : null}
                </article>
                <article>
                  <span><Camera size={21} /></span>
                  <div><strong>Камера объекта</strong><p>Защищённая трансляция через совместимый RTSP/WebRTC-шлюз без хранения пароля камеры в проекте.</p></div>
                  <StatusBadge label={integrationStatus?.camera ? 'Подключена' : 'Ожидает оборудование'} tone={integrationStatus?.camera ? 'positive' : 'neutral'} />
                </article>
                <article>
                  <span><Mail size={21} /></span>
                  <div><strong>Email через Resend</strong><p>Уведомления и будущие приглашения пользователей.</p></div>
                  <StatusBadge label={integrationStatus?.email ? 'Подключён' : 'Нужны API-ключ и отправитель'} tone={integrationStatus?.email ? 'positive' : 'neutral'} />
                  {integrationStatus?.email && <button type="button" className="text-button integration-action" onClick={() => void testIntegration('email')}>Отправить тест</button>}
                </article>
              </div>
              {integrationMessage && <div className="integration-result" role="status" aria-live="polite">{integrationMessage}</div>}
              <div className="settings-note"><ShieldCheck size={18} /><span>Токен бота хранится как закрытый серверный секрет. Общий чат фиксируется только после успешного проверочного сообщения; личный chat ID используется только для адресных задач. Чтобы бот получал обычные обращения @ikioma_bot в группе, отключите Group Privacy через @BotFather → /setprivacy → Disable и заново добавьте бота в группу.</span></div>
            </section>
          )}
        </div>
      </div>

      {showInvite && <Modal title="Добавить пользователя" subtitle={accessSnapshot?.authMode === 'sites_sso' ? 'Создадим профиль. Вход на резервный стенд управляется защищённым списком сайта.' : 'Email станет логином. После сохранения система выпустит одноразовую ссылку для установки пароля.'} onClose={() => setShowInvite(false)}><form className="modal-form" onSubmit={inviteUser}><div className="form-grid"><Field label="Имя"><input required value={invite.name} onChange={(event) => setInvite({ ...invite, name: event.target.value })} /></Field><Field label="Email — логин"><input required type="email" value={invite.email} onChange={(event) => setInvite({ ...invite, email: event.target.value })} /></Field></div><div className="form-grid"><Field label="Роль"><select value={invite.role} onChange={(event) => setInvite({ ...invite, role: event.target.value as UserRole })}><option value="management">Управление</option><option value="foreman">Прораб</option><option value="client">Клиент</option></select></Field><Field label="Telegram"><input value={invite.telegram} onChange={(event) => setInvite({ ...invite, telegram: event.target.value })} placeholder="@username, необязательно" /></Field></div>{accessErrors.new && <div className="access-inline-error" role="alert">{accessErrors.new}</div>}<div className="settings-note"><Link2 size={18} /><span>{accessSnapshot?.authMode === 'sites_sso' ? 'Веб-доступ и Telegram — разные подключения. Добавьте email в защищённый доступ сайта; Telegram можно связать после создания профиля.' : 'Веб-доступ и Telegram — разные подключения. Сотрудник сам задаст пароль по ссылке; Telegram можно связать после создания профиля.'}</span></div><div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setShowInvite(false)}>Отмена</button><button type="submit" className="button button--primary" disabled={accessBusy?.userId === 'new'}><Plus size={17} /> {accessSnapshot?.authMode === 'sites_sso' ? 'Создать профиль' : 'Создать и выдать доступ'}</button></div></form></Modal>}
      {editingUser && <Modal title={`Редактировать: ${editingUser.name}`} subtitle="Email является логином. При его смене потребуется выпустить новую ссылку активации." onClose={() => setEditingUser(null)}><form className="modal-form" onSubmit={saveUser}><div className="form-grid"><Field label="Имя"><input required value={editingUser.name} onChange={(event) => setEditingUser({ ...editingUser, name: event.target.value })} /></Field><Field label="Email — логин"><input required type="email" value={editingUser.email} onChange={(event) => setEditingUser({ ...editingUser, email: event.target.value })} /></Field><Field label="Роль"><select value={editingUser.role} onChange={(event) => setEditingUser({ ...editingUser, role: event.target.value as UserRole })}><option value="management">Управление</option><option value="foreman">Прораб</option><option value="client">Клиент</option></select></Field><Field label="Telegram"><input value={editingUser.telegram ?? ''} onChange={(event) => setEditingUser({ ...editingUser, telegram: event.target.value })} placeholder="@username" /></Field></div><div className="settings-note"><Link2 size={18} /><span>Блокировка и разблокировка выполняются отдельными кнопками в списке, чтобы веб-сессии отзывались на сервере.</span></div><div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setEditingUser(null)}>Отмена</button><button type="submit" className="button button--primary" disabled={accessBusy?.userId === editingUser.id}>Сохранить</button></div></form></Modal>}
      {projectAccess && <Modal
        title={`Проекты: ${projectAccess.user.name}`}
        subtitle={projectAccess.mode === 'issue'
          ? projectAccess.accountActive
            ? 'Пароль уже создан. Добавьте нужные проекты — сотрудник войдёт с прежним логином и паролем.'
            : 'При первой выдаче выбраны все существующие проекты. Ненужные можно снять сейчас или позже.'
          : 'Отметьте проекты, которые сотрудник должен видеть. Снятые проекты закрываются сразу.'}
        onClose={() => setProjectAccess(null)}
      >
        <div className="project-access-list">
          {projectAccess.projects.map((project) => {
            const checked = projectAccess.selected.includes(project.id);
            const currentProjectRequired = projectAccess.mode === 'issue' && project.id === state.project.id;
            return <label key={project.id} className={checked ? 'project-access-item project-access-item--selected' : 'project-access-item'}>
              <input
                type="checkbox"
                checked={checked}
                disabled={currentProjectRequired}
                onChange={() => setProjectAccess((current) => current ? {
                  ...current,
                  selected: checked
                    ? current.selected.filter((id) => id !== project.id)
                    : [...current.selected, project.id],
                } : current)}
              />
              <span className="project-access-item__icon"><FolderKanban size={18} /></span>
              <span className="project-access-item__copy"><strong>{project.code} · {project.name}</strong><small>{roleLabels[project.role]}{project.id === state.project.id ? ' · текущий проект' : ''}</small></span>
              <StatusBadge label={checked ? 'Доступ есть' : 'Нет доступа'} tone={checked ? 'positive' : 'neutral'} />
            </label>;
          })}
        </div>
        <div className="settings-note"><ShieldCheck size={18} /><span>Новые проекты не добавляются автоматически. Их можно выдать позже здесь же. Telegram-привязка от выбора проектов не меняется.</span></div>
        {accessErrors[projectAccess.user.id] && <div className="access-inline-error" role="alert">{accessErrors[projectAccess.user.id]}</div>}
        <div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setProjectAccess(null)}>Отмена</button><button type="button" className="button button--primary" disabled={accessBusy?.userId === projectAccess.user.id} onClick={() => void saveProjectAccess()}><Check size={17} /> {projectAccess.mode === 'issue' ? 'Выдать и получить ссылку' : 'Сохранить доступы'}</button></div>
      </Modal>}
      {accessLink && <Modal title={`${accessLink.purpose === 'reset' ? 'Сброс пароля' : 'Доступ'} для ${accessLink.userName}`} subtitle={accessLink.purpose === 'existing' ? 'У пользователя уже есть пароль ИКИОМА ОС; доступ к этому проекту добавлен.' : `Одноразовая ссылка действует до ${formatDateTime(accessLink.expiresAt ?? '')}.`} onClose={() => setAccessLink(null)}><div className="telegram-link-card access-link-card"><p>{accessLink.purpose === 'existing' ? 'Отправьте человеку ссылку на вход. Он использует прежний пароль и свой email.' : 'Отправьте ссылку именно выбранному человеку. Он задаст пароль и войдёт в ИКИОМА ОС по своему email.'}</p><Field label="Логин"><input readOnly value={accessLink.login} onFocus={(event) => event.currentTarget.select()} /></Field><Field label={accessLink.purpose === 'existing' ? 'Ссылка на вход' : 'Ссылка активации'}><input readOnly value={accessLink.url} onFocus={(event) => event.currentTarget.select()} /></Field><div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setAccessLink(null)}>Закрыть</button><button type="button" className="button button--primary" onClick={() => { void navigator.clipboard.writeText(accessLink.url); }}><Link2 size={16} /> Скопировать ссылку</button></div></div></Modal>}
      {telegramLink && <Modal title={`Telegram для ${telegramLink.userName}`} subtitle={`Персональная одноразовая ссылка действует до ${formatDateTime(telegramLink.expiresAt)}.`} onClose={() => setTelegramLink(null)}><div className="telegram-link-card"><p>Отправьте эту ссылку именно выбранному сотруднику. После нажатия «Запустить» его Telegram автоматически свяжется с профилем в ИКИОМА ОС.</p><input readOnly value={telegramLink.url} onFocus={(event) => event.currentTarget.select()} /><div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setTelegramLink(null)}>Закрыть</button><button type="button" className="button button--primary" onClick={() => { void navigator.clipboard.writeText(telegramLink.url); setIntegrationMessage('Ссылка скопирована.'); }}><Link2 size={16} /> Скопировать ссылку</button></div></div></Modal>}
    </div>
  );
}
