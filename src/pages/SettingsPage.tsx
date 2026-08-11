import { useEffect, useState, type FormEvent } from 'react';
import {
  BellRing,
  Bot,
  Camera,
  Check,
  Copy,
  Globe2,
  KeyRound,
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
import type { AppState, DashboardWidget, NotificationSettings, SystemUser, UserRole } from '../types';
import { Field, Modal, SectionHeader, StatusBadge } from '../components/Ui';

type SettingsTab = 'access' | 'dashboard' | 'notifications' | 'integrations';
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
  camera: boolean;
  websiteForm: boolean;
  publicWebsiteForm: boolean;
};

const roleLabels: Record<UserRole, string> = { management: 'Управление', foreman: 'Прораб', client: 'Клиент (доступ отключён)' };
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

export function SettingsPage({ state, actor, currentUserEmail, onChange }: { state: AppState; actor: string; currentUserEmail: string; onChange: (next: AppState) => void }) {
  const [tab, setTab] = useState<SettingsTab>('access');
  const [showInvite, setShowInvite] = useState(false);
  const [invite, setInvite] = useState({ name: '', email: '', role: 'foreman' as UserRole, telegram: '' });
  const [editingUser, setEditingUser] = useState<SystemUser | null>(null);
  const [integrationStatus, setIntegrationStatus] = useState<IntegrationStatus | null>(null);
  const [integrationMessage, setIntegrationMessage] = useState('');
  const [accessLink, setAccessLink] = useState<{ userName: string; email: string; url: string; expiresAt: string } | null>(null);
  const [telegramLink, setTelegramLink] = useState<{ userName: string; url: string; expiresAt: string } | null>(null);

  const refreshIntegrationStatus = async () => {
    try {
      const response = await fetch('/api/integrations/status', { cache: 'no-store' });
      const body = await response.json();
      setIntegrationStatus(body.integrations ?? null);
    } catch {
      setIntegrationStatus(null);
    }
  };

  useEffect(() => {
    if (tab !== 'integrations' && tab !== 'notifications') return;
    void refreshIntegrationStatus();
  }, [tab]);

  const saveSettings = (settings: AppState['settings'], text: string) => onChange({
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

  const requestAccessLink = async (user: Pick<SystemUser, 'name' | 'email' | 'role'>) => {
    const response = await fetch('/api/access/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: state.project.id, name: user.name, email: user.email, role: user.role }),
    });
    const body = await response.json() as { ok?: boolean; error?: string; inviteUrl?: string; expiresAt?: string };
    if (!response.ok || !body.ok || !body.inviteUrl || !body.expiresAt) throw new Error(body.error || 'invite_failed');
    return { url: body.inviteUrl, expiresAt: body.expiresAt };
  };

  const inviteUser = async (event: FormEvent) => {
    event.preventDefault();
    if (!invite.name.trim() || !invite.email.trim()) return;
    const email = invite.email.trim().toLocaleLowerCase('en-US');
    if (state.settings.users.some((item) => item.email.toLocaleLowerCase('en-US') === email)) {
      setIntegrationMessage('Пользователь с такой почтой уже добавлен. Откройте его карточку для изменения доступа.');
      return;
    }
    setIntegrationMessage('Создаём персональный доступ…');
    try {
      const user: SystemUser = { id: uid('user'), name: invite.name.trim(), email, role: invite.role, telegram: invite.telegram.trim() || undefined, status: 'invited', invitedAt: new Date().toISOString(), inviteDelivery: 'manual' };
      const link = await requestAccessLink(user);
      saveSettings({ ...state.settings, users: [...state.settings.users, user] }, `Создан персональный доступ ИКИОМА ОС: ${user.name} · ${roleLabels[user.role]}`);
      setAccessLink({ userName: user.name, email: user.email, ...link });
      setIntegrationMessage(`Доступ для ${user.name} создан. Передайте ему одноразовую ссылку лично.`);
      setShowInvite(false);
      setInvite({ name: '', email: '', role: 'foreman', telegram: '' });
    } catch (error) {
      setIntegrationMessage(error instanceof Error && error.message === 'invalid_invite'
        ? 'Проверьте имя, почту и роль пользователя.'
        : 'Не удалось создать доступ. Обновите страницу и повторите.');
    }
  };

  const reissueAccessLink = async (user: SystemUser) => {
    setIntegrationMessage(`Создаём новую ссылку для ${user.name}…`);
    try {
      const link = await requestAccessLink(user);
      setAccessLink({ userName: user.name, email: user.email, ...link });
      setIntegrationMessage(`Новая ссылка для ${user.name} готова. Предыдущая ссылка больше не действует.`);
    } catch {
      setIntegrationMessage('Не удалось перевыпустить ссылку доступа. Повторите попытку.');
    }
  };

  const copyAccessLink = async () => {
    if (!accessLink) return;
    try {
      await navigator.clipboard.writeText(accessLink.url);
      setIntegrationMessage(`Ссылка для ${accessLink.userName} скопирована.`);
    } catch {
      setIntegrationMessage('Не удалось скопировать автоматически. Выделите ссылку и скопируйте вручную.');
    }
  };

  const saveUser = (event: FormEvent) => {
    event.preventDefault();
    if (!editingUser?.name.trim() || !editingUser.email.trim()) return;
    saveSettings({ ...state.settings, users: state.settings.users.map((user) => user.id === editingUser.id ? { ...editingUser, name: editingUser.name.trim(), email: editingUser.email.trim(), telegram: editingUser.telegram?.trim() || undefined } : user) }, `Обновлены роль и доступ пользователя ${editingUser.name}`);
    setEditingUser(null);
  };

  const testIntegration = async (channel: 'email' | 'telegram') => {
    setIntegrationMessage('Проверяем подключение…');
    try {
      const response = await fetch('/api/integrations/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, to: state.settings.users.find((user) => user.role === 'management')?.email, message: `ИКИОМА ОС: тест канала ${channel === 'email' ? 'Email' : 'Telegram'} для проекта ${state.project.code}` }) });
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
      const response = await fetch('/api/integrations/telegram/select', {
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
      const response = await fetch('/api/integrations/telegram/link', {
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

  const telegramCommand = integrationStatus?.telegramBotUsername ? `/start@${integrationStatus.telegramBotUsername}` : '/start';
  const telegramStatusLabel = integrationStatus?.telegramCommon
    ? integrationStatus.telegramCommonTitle || 'Общий чат подключён'
    : integrationStatus?.telegramIssue === 'invalid_token'
      ? 'Токен не принят'
      : integrationStatus?.telegramCandidates?.length
        ? 'Выберите общий чат'
        : integrationStatus?.telegramBot
          ? 'Бот подключён, ждём чат'
          : 'Нужен токен бота';

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
              <section className="panel settings-panel"><SectionHeader eyebrow="Команда" title="Пользователи и роли" action={<button type="button" className="button button--primary button--compact" onClick={() => { setIntegrationMessage(''); setShowInvite(true); }}><Plus size={16} /> Пригласить</button>} />
                <div className="user-list">{state.settings.users.map((user) => <article key={user.id} className="user-row"><span className="user-row__avatar">{user.name.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span><div className="user-row__identity"><strong>{user.name}</strong><small title={`${user.email}${user.telegram ? ` · ${user.telegram}` : ''}`}>{user.email}{user.telegram ? ` · ${user.telegram}` : ''}</small></div><div className="user-row__details"><span className="user-row__role"><StatusBadge label={roleLabels[user.role]} tone={user.role === 'management' ? 'blue' : 'neutral'} /></span><span className="user-row__status"><StatusBadge label={user.role === 'client' ? 'Доступ отключён' : user.telegramBoundAt ? 'Telegram подключён' : user.status === 'active' ? 'Активен' : user.inviteDelivery === 'manual' ? 'Ссылка создана' : user.status === 'invited' ? 'Доступ не выдан' : 'Отключён'} tone={user.role === 'client' ? 'neutral' : user.telegramBoundAt || user.status === 'active' ? 'positive' : user.status === 'invited' ? 'warning' : 'neutral'} /></span><small className="user-row__last">{user.email.toLocaleLowerCase('en-US') === currentUserEmail.toLocaleLowerCase('en-US') ? 'Сейчас в системе' : user.lastActiveAt ? formatDateTime(user.lastActiveAt) : 'Ещё не входил'}</small></div><span className="user-row__actions">{user.id !== 'user-owner' && <button type="button" aria-label={`Создать новую ссылку доступа для ${user.name}`} title="Новая ссылка доступа" disabled={user.status === 'disabled'} onClick={() => void reissueAccessLink(user)}><KeyRound size={16} /></button>}<button type="button" aria-label={`Подключить Telegram для ${user.name}`} title="Персональная Telegram-ссылка" disabled={user.status === 'disabled'} onClick={() => void createTelegramLink(user)}><Link2 size={16} /></button><button type="button" aria-label={`Редактировать ${user.name}`} onClick={() => setEditingUser({ ...user })}><Pencil size={16} /></button></span></article>)}</div>
                {integrationMessage && <div className="integration-result">{integrationMessage}</div>}
              </section>
              <section className="panel settings-panel"><SectionHeader eyebrow="Матрица" title="Что видит каждая роль" />
                <div className="permission-table permission-table--internal"><div className="permission-table__head"><strong>Раздел</strong><strong>Управление</strong><strong>Прораб</strong></div>{[
                  ['Финансы и маржа', true, false], ['Маркетинг и заявки', true, false], ['Все задачи / только свои', true, true], ['Этапы и график', true, true], ['Снабжение', true, true], ['Контроль качества', true, true], ['Настройки и доступы', true, false],
                ].map(([label, management, foreman]) => <div className="permission-table__row" key={String(label)}><span>{String(label)}</span>{[management, foreman].map((allowed, index) => <span key={index}>{allowed ? <Check size={17} /> : '—'}</span>)}</div>)}</div>
                <div className="settings-note"><LockKeyhole size={18} /><span>Вы указываете имя, почту-логин и роль. ИКИОМА ОС создаёт одноразовую ссылку без почтового сервиса: передайте её сотруднику лично, и он сам задаст пароль.</span></div>
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
                  <div><strong>Форма на сайте ИКИОМА</strong><p>Входящий обработчик готов, но внешний посетитель не увидит форму, пока весь сайт закрыт авторизацией.</p></div>
                  <StatusBadge label={integrationStatus?.publicWebsiteForm ? 'Принимает заявки' : 'Только внутри'} tone={integrationStatus?.publicWebsiteForm ? 'positive' : 'warning'} />
                </article>
                <article>
                  <span><Send size={21} /></span>
                  <div>
                    <strong>Telegram-бот и общий чат</strong>
                    <p>{integrationStatus?.telegramCommon
                      ? integrationStatus.telegramInbound
                        ? `Полевой штаб работает: изменения уходят в «${integrationStatus.telegramCommonTitle || 'общий чат'}», а команды, задачи и файлы принимаются обратно.`
                        : `Исходящие уведомления работают; входящие команды ещё не подключены.`
                      : `Добавьте бота в общий чат, отправьте там ${telegramCommand} — ИКИОМА ОС найдёт группу автоматически.`}</p>
                  </div>
                  <StatusBadge label={integrationStatus?.telegramInbound ? 'Полевой штаб готов' : telegramStatusLabel} tone={integrationStatus?.telegramInbound ? 'positive' : integrationStatus?.telegramIssue === 'invalid_token' ? 'warning' : 'neutral'} />
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
                      ? <button type="button" className="text-button integration-action" onClick={() => void refreshIntegrationStatus()}>Проверить ещё раз</button>
                      : null}
                </article>
                <article>
                  <span><Camera size={21} /></span>
                  <div><strong>Камера объекта</strong><p>Защищённая трансляция через совместимый RTSP/WebRTC-шлюз без хранения пароля камеры в проекте.</p></div>
                  <StatusBadge label={integrationStatus?.camera ? 'Подключена' : 'Ожидает оборудование'} tone={integrationStatus?.camera ? 'positive' : 'neutral'} />
                </article>
                <article>
                  <span><Mail size={21} /></span>
                  <div><strong>Email через Resend</strong><p>Необязательный канал будущих уведомлений. Доступы работают без него.</p></div>
                  <StatusBadge label={integrationStatus?.email ? 'Подключён' : 'Нужны API-ключ и отправитель'} tone={integrationStatus?.email ? 'positive' : 'neutral'} />
                  {integrationStatus?.email && <button type="button" className="text-button integration-action" onClick={() => void testIntegration('email')}>Отправить тест</button>}
                </article>
              </div>
              {integrationMessage && <div className="integration-result">{integrationMessage}</div>}
              <div className="settings-note"><ShieldCheck size={18} /><span>Токен бота хранится как закрытый серверный секрет. Общий чат фиксируется только после успешного проверочного сообщения; личный chat ID используется только для адресных задач.</span></div>
            </section>
          )}
        </div>
      </div>

      {showInvite && <Modal title="Создать доступ" subtitle="Укажите пользователя и роль. Система покажет одноразовую ссылку — почтовый сервис не нужен." onClose={() => setShowInvite(false)}><form className="modal-form" onSubmit={(event) => void inviteUser(event)}><div className="form-grid"><Field label="Имя"><input required value={invite.name} onChange={(event) => setInvite({ ...invite, name: event.target.value })} /></Field><Field label="Почта — логин для входа" hint="Письмо на неё не отправляется"><input required type="email" autoComplete="email" value={invite.email} onChange={(event) => setInvite({ ...invite, email: event.target.value })} /></Field></div><div className="form-grid"><Field label="Роль"><select value={invite.role} onChange={(event) => setInvite({ ...invite, role: event.target.value as UserRole })}><option value="management">Управление</option><option value="foreman">Прораб</option></select></Field><Field label="Telegram"><input value={invite.telegram} onChange={(event) => setInvite({ ...invite, telegram: event.target.value })} placeholder="@username, необязательно" /></Field></div><div className="settings-note"><KeyRound size={18} /><span>Ссылка действует 48 часов и используется один раз. Пользователь откроет её и самостоятельно задаст пароль.</span></div>{integrationMessage && <div className="integration-result">{integrationMessage}</div>}<div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setShowInvite(false)}>Отмена</button><button type="submit" className="button button--primary"><KeyRound size={17} /> Создать доступ</button></div></form></Modal>}
      {accessLink && <Modal title={`Доступ для ${accessLink.userName}`} subtitle={`Логин: ${accessLink.email}. Ссылка действует до ${formatDateTime(accessLink.expiresAt)}.`} onClose={() => setAccessLink(null)}><div className="access-link-card"><p>Передайте эту ссылку только выбранному сотруднику. После первого использования она автоматически перестанет работать.</p><input aria-label={`Одноразовая ссылка для ${accessLink.userName}`} readOnly value={accessLink.url} onFocus={(event) => event.currentTarget.select()} /><div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setAccessLink(null)}>Закрыть</button><button type="button" className="button button--primary" onClick={() => void copyAccessLink()}><Copy size={16} /> Скопировать ссылку</button></div></div></Modal>}
      {editingUser && <Modal title={`Редактировать: ${editingUser.name}`} subtitle="Изменения роли и статуса сразу сохранятся в настройках проекта." onClose={() => setEditingUser(null)}><form className="modal-form" onSubmit={saveUser}><div className="form-grid"><Field label="Имя"><input required value={editingUser.name} onChange={(event) => setEditingUser({ ...editingUser, name: event.target.value })} /></Field><Field label="Email"><input required type="email" value={editingUser.email} onChange={(event) => setEditingUser({ ...editingUser, email: event.target.value })} /></Field><Field label="Роль"><select value={editingUser.role} onChange={(event) => setEditingUser({ ...editingUser, role: event.target.value as UserRole })}><option value="management">Управление</option><option value="foreman">Прораб</option></select></Field><Field label="Статус"><select value={editingUser.status} onChange={(event) => setEditingUser({ ...editingUser, status: event.target.value as SystemUser['status'] })}><option value="active">Активен</option><option value="invited">Доступ не выдан</option><option value="disabled">Отключён</option></select></Field><Field label="Telegram"><input value={editingUser.telegram ?? ''} onChange={(event) => setEditingUser({ ...editingUser, telegram: event.target.value })} placeholder="@username" /></Field></div><div className="settings-note"><Link2 size={18} /><span>{editingUser.telegramBoundAt ? 'Telegram уже связан с этим профилем.' : 'Для связи Telegram используйте кнопку с цепочкой в списке пользователей.'}</span></div><div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setEditingUser(null)}>Отмена</button><button type="submit" className="button button--primary">Сохранить</button></div></form></Modal>}
      {telegramLink && <Modal title={`Telegram для ${telegramLink.userName}`} subtitle={`Персональная одноразовая ссылка действует до ${formatDateTime(telegramLink.expiresAt)}.`} onClose={() => setTelegramLink(null)}><div className="telegram-link-card"><p>Отправьте эту ссылку именно выбранному сотруднику. После нажатия «Запустить» его Telegram автоматически свяжется с профилем в ИКИОМА ОС.</p><input readOnly value={telegramLink.url} onFocus={(event) => event.currentTarget.select()} /><div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setTelegramLink(null)}>Закрыть</button><button type="button" className="button button--primary" onClick={() => { void navigator.clipboard.writeText(telegramLink.url); setIntegrationMessage('Ссылка скопирована.'); }}><Link2 size={16} /> Скопировать ссылку</button></div></div></Modal>}
    </div>
  );
}
