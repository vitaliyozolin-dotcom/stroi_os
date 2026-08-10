import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Bell,
  CalendarRange,
  ChevronDown,
  ClipboardCheck,
  Cloud,
  CloudOff,
  House,
  FolderKanban,
  LayoutDashboard,
  ListTodo,
  LoaderCircle,
  Menu,
  Megaphone,
  PackageSearch,
  PanelLeftClose,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  UserRound,
  UsersRound,
  WalletCards,
  X,
} from 'lucide-react';
import { ClientPage } from './pages/ClientPage';
import { FinancePage } from './pages/FinancePage';
import { MarketingPage } from './pages/MarketingPage';
import { OverviewPage } from './pages/OverviewPage';
import { ProcurementPage } from './pages/ProcurementPage';
import { QualityPage } from './pages/QualityPage';
import { SchedulePage } from './pages/SchedulePage';
import { SettingsPage } from './pages/SettingsPage';
import { CounterpartiesPage } from './pages/CounterpartiesPage';
import { TasksPage } from './pages/TasksPage';
import { ProjectPage } from './pages/ProjectPage';
import { HelpCenter } from './components/HelpCenter';
import { AuthGate } from './components/AuthGate';
import { Field, Modal, StatusBadge } from './components/Ui';
import type { AuthenticatedUser, PageId, UserRole } from './types';
import { useProjectState, type SyncPhase } from './useProjectState';
import { createProjectState } from './seed';
import { isTaskOverdue } from './domain';

const roleLabels: Record<UserRole, string> = {
  management: 'Управление',
  foreman: 'Прораб',
  client: 'Клиент',
};

const pageLabels: Record<PageId, string> = {
  overview: 'Главная',
  project: 'Карточка проекта',
  tasks: 'Задачи',
  marketing: 'Маркетинг',
  counterparties: 'Подрядчики и поставщики',
  finance: 'Финансы',
  schedule: 'График работ',
  procurement: 'Снабжение',
  quality: 'Контроль качества',
  client: 'Кабинет клиента',
  settings: 'Настройки',
};

const fullNavigation: Array<{ id: PageId; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: 'Главная', icon: LayoutDashboard },
  { id: 'project', label: 'Карточка проекта', icon: FolderKanban },
  { id: 'tasks', label: 'Задачи', icon: ListTodo },
  { id: 'marketing', label: 'Маркетинг и заявки', icon: Megaphone },
  { id: 'finance', label: 'Деньги', icon: WalletCards },
  { id: 'schedule', label: 'Этапы и график', icon: CalendarRange },
  { id: 'procurement', label: 'Снабжение', icon: PackageSearch },
  { id: 'counterparties', label: 'Подрядчики и поставщики', icon: UsersRound },
  { id: 'quality', label: 'Качество', icon: ShieldCheck },
  { id: 'client', label: 'Кабинет клиента', icon: UserRound },
];

const syncLabels: Record<SyncPhase, string> = {
  loading: 'Подключаем базу',
  saved: 'Сохранено',
  saving: 'Сохраняем',
  offline: 'Нет связи',
  conflict: 'Есть конфликт',
};

const shortTime = (value?: string) => {
  if (!value) return 'облачное хранение';
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
};

const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((part) => part[0]).slice(0, 2).join('').toLocaleUpperCase('ru');

function App() {
  const [role, setRole] = useState<UserRole>('client');
  const [page, setPage] = useState<PageId>('overview');
  const [session, setSession] = useState<AuthenticatedUser | null>(null);
  const [sessionError, setSessionError] = useState('');
  const [focusEntityId, setFocusEntityId] = useState<string | null>(null);
  const deepLinkApplied = useRef(false);
  const {
    state,
    updateState,
    sync,
    conflict,
    retry,
    useServerVersion,
    keepLocalVersion,
    projects,
    switchProject,
    createProject,
  } = useProjectState(role, session?.name ?? 'Виталий Озолин');
  const [mobileMenu, setMobileMenu] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [projectForm, setProjectForm] = useState({ code: 'H-001', name: '', address: '', model: '', area: '', clientNames: '', contractValue: '', targetCost: '', startDate: new Date().toISOString().slice(0, 10), targetDate: '', foreman: state.project.foreman, source: '' });

  useEffect(() => {
    let active = true;
    void fetch('/api/session', { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json() as { user?: AuthenticatedUser; error?: string };
        if (!response.ok || !body.user) throw new Error(body.error ?? 'session_unavailable');
        if (!active) return;
        setSession(body.user);
        setRole(body.user.role);
        const params = new URLSearchParams(window.location.search);
        const requestedPage = params.get('page') as PageId | null;
        const requestedProject = params.get('projectId');
        const allowed = body.user.role === 'client'
          ? ['client']
          : body.user.role === 'foreman'
            ? ['overview', 'project', 'tasks', 'schedule', 'procurement', 'quality']
            : Object.keys(pageLabels);
        setPage(requestedPage && allowed.includes(requestedPage) ? requestedPage : body.user.role === 'client' ? 'client' : 'overview');
        setFocusEntityId(params.get('entity'));
        if (!deepLinkApplied.current && requestedProject && requestedProject !== state.project.id) {
          deepLinkApplied.current = true;
          await switchProject(requestedProject);
        }
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
          setPage('overview');
          return;
        }
        setSessionError(error instanceof Error && error.message === 'access_not_assigned'
          ? 'Ваш аккаунт разрешён на сайте, но роль в проекте ещё не назначена.'
          : 'Не удалось подтвердить рабочий доступ. Обновите страницу или обратитесь к владельцу.');
      });
    return () => { active = false; };
  }, []);

  const navigation = useMemo(() => {
    if (role === 'client') return fullNavigation.filter((item) => item.id === 'client');
    if (role === 'foreman') return fullNavigation.filter((item) => ['overview', 'project', 'tasks', 'schedule', 'procurement', 'quality'].includes(item.id));
    return fullNavigation.filter((item) => item.id !== 'settings');
  }, [role]);

  const notificationCount = useMemo(() => {
    const overdue = role === 'client' ? 0 : state.tasks.filter((task) => isTaskOverdue(task)).length;
    const quality = state.checkpoints.filter((item) => item.status === 'rework').length;
    const supply = role === 'client' ? 0 : state.procurement.filter((item) => item.risk).length;
    const schedule = role === 'client' ? 0 : state.stages.filter((item) => ['blocked', 'rework', 'awaiting_inspection'].includes(item.status)).length;
    const leads = role === 'management' ? state.leads.filter((item) => item.stage === 'new').length : 0;
    return overdue + quality + supply + schedule + leads;
  }, [role, state.checkpoints, state.leads, state.procurement, state.stages, state.tasks]);

  const navigate = (nextPage: PageId, entityId?: string) => {
    setPage(nextPage);
    setFocusEntityId(entityId ?? null);
    setMobileMenu(false);
    const url = new URL(window.location.href);
    url.searchParams.set('projectId', state.project.id);
    url.searchParams.set('page', nextPage);
    if (entityId) url.searchParams.set('entity', entityId);
    else url.searchParams.delete('entity');
    window.history.replaceState({}, '', url);
  };

  const content = (() => {
    switch (page) {
      case 'project': return <ProjectPage state={state} session={session!} focusId={focusEntityId} onChange={updateState} onNavigate={navigate} />;
      case 'tasks': return <TasksPage state={state} role={role} session={session!} focusId={focusEntityId} onChange={updateState} onNavigate={navigate} />;
      case 'marketing': return <MarketingPage state={state} actor={session?.name ?? 'Пользователь'} focusId={focusEntityId} onChange={updateState} />;
      case 'counterparties': return <CounterpartiesPage state={state} actor={session?.name ?? 'Пользователь'} focusId={focusEntityId} onChange={updateState} />;
      case 'finance': return <FinancePage state={state} actor={session?.name ?? 'Пользователь'} focusId={focusEntityId} onChange={updateState} onNavigate={navigate} />;
      case 'schedule': return <SchedulePage state={state} role={role} actor={session?.name ?? 'Пользователь'} focusId={focusEntityId} onChange={updateState} />;
      case 'procurement': return <ProcurementPage state={state} role={role} actor={session?.name ?? 'Пользователь'} focusId={focusEntityId} onChange={updateState} />;
      case 'quality': return <QualityPage state={state} role={role} actor={session?.name ?? 'Пользователь'} focusId={focusEntityId} onChange={updateState} />;
      case 'client': return <ClientPage state={state} onChange={updateState} />;
      case 'settings': return <SettingsPage state={state} actor={session?.name ?? 'Владелец'} onChange={updateState} />;
      default: return <OverviewPage state={state} role={role} onNavigate={navigate} onOpenProjects={() => setCreateProjectOpen(true)} />;
    }
  })();

  const submitProject = async (event: FormEvent) => {
    event.preventDefault();
    const area = Number(projectForm.area);
    const contractValue = Number(projectForm.contractValue);
    const targetCost = Number(projectForm.targetCost);
    if (!projectForm.code.trim() || !projectForm.name.trim() || !projectForm.targetDate || area <= 0 || targetCost < 0) return;
    const next = createProjectState(state, { ...projectForm, area, contractValue, targetCost, actor: session?.name ?? 'Виталий Озолин' });
    setCreateProjectOpen(false);
    setProjectOpen(false);
    setPage('overview');
    await createProject(next);
  };

  if (!session) {
    if (!sessionError && !new URLSearchParams(window.location.search).get('invite')) return <div className="session-gate"><span><ShieldCheck size={28} /></span><h1>Проверяем рабочий доступ</h1><p>ИКИОМА ОС определяет ваш аккаунт и роль в проектах.</p></div>;
    return <AuthGate sessionError={sessionError} />;
  }

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'app-shell--collapsed' : ''}`}>
      {mobileMenu && <button className="mobile-scrim" type="button" aria-label="Закрыть меню" onClick={() => setMobileMenu(false)} />}
      <aside className={`sidebar ${mobileMenu ? 'sidebar--open' : ''}`}>
        <div className="sidebar__brand">
          <span className="brand-mark"><img src="/favicon.svg" alt="" /></span>
          <span className="brand-copy"><strong>ИКИОМА <span>ОС</span></strong><small>операционная система</small></span>
          <button type="button" className="sidebar__mobile-close" onClick={() => setMobileMenu(false)} aria-label="Закрыть меню"><X size={19} /></button>
        </div>

        <button className="project-switcher" data-tour="project-switcher" type="button" onClick={() => setProjectOpen(true)}>
          <span className="project-switcher__icon"><House size={19} /></span>
          <span><small>{state.project.code}</small><strong>{state.project.name}</strong></span>
          <ChevronDown size={15} />
        </button>

        <nav className="sidebar__nav" aria-label="Основная навигация">
          <small className="sidebar__label">{role === 'client' ? 'Мой дом' : 'Управление проектом'}</small>
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <button type="button" key={item.id} className={page === item.id ? 'active' : ''} onClick={() => navigate(item.id)} title={item.label}>
                <Icon size={19} /><span>{item.label}</span>
                {item.id === 'quality' && state.checkpoints.some((checkpoint) => checkpoint.status === 'rework') && <i className="nav-alert" />}
                {item.id === 'tasks' && state.tasks.some((task) => isTaskOverdue(task)) && <i className="nav-alert" />}
              </button>
            );
          })}
        </nav>

        <div className="sidebar__spacer" />
        {role !== 'client' && (
          <div className="sidebar__standard">
            <span><ClipboardCheck size={18} /></span>
            <div><strong>Стандарт стройки v1.0</strong><small>13 этапов · 7 кадров</small></div>
          </div>
        )}
        {role === 'management' && <div className="sidebar__footer"><button type="button" title="Настройки" className={page === 'settings' ? 'active' : ''} onClick={() => navigate('settings')}><Settings2 size={18} /><span>Настройки</span></button></div>}
        <button type="button" className="sidebar-collapse" onClick={() => setSidebarCollapsed((value) => !value)} aria-label="Свернуть боковую панель"><PanelLeftClose size={17} /></button>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className="topbar__left">
            <button type="button" className="mobile-menu-button" onClick={() => setMobileMenu(true)} aria-label="Открыть меню"><Menu size={21} /></button>
            <div className="breadcrumbs"><span>{state.project.code}</span><i>/</i><strong>{pageLabels[page]}</strong></div>
          </div>
          <div className="topbar__right">
            <button
              type="button"
              className={`sync-chip sync-chip--${sync.phase}`}
              onClick={sync.phase === 'offline' ? retry : undefined}
              title={sync.message ?? `${syncLabels[sync.phase]} · ревизия ${sync.revision}`}
            >
              {sync.phase === 'loading' || sync.phase === 'saving'
                ? <LoaderCircle className="spin" size={17} />
                : sync.phase === 'offline'
                  ? <CloudOff size={17} />
                  : sync.phase === 'conflict'
                    ? <AlertTriangle size={17} />
                    : <Cloud size={17} />}
              <span><strong>{syncLabels[sync.phase]}</strong><small>{sync.phase === 'offline' ? 'нажмите повторить' : `рев. ${sync.revision} · ${shortTime(sync.updatedAt)}`}</small></span>
              {sync.phase === 'offline' && <RefreshCw size={14} />}
            </button>
            <span className="session-role"><ShieldCheck size={15} /> {roleLabels[role]}</span>
            <button type="button" className="notification-button" aria-label={`Уведомления: ${notificationCount}`} onClick={() => setNotificationsOpen(true)}><Bell size={19} />{notificationCount > 0 && <i />}</button>
            <div className="user-chip"><span>{initials(session.name)}</span><div><strong>{session.name}</strong><small>{session.email}</small></div></div>
          </div>
        </header>
        {conflict && (
          <section className="sync-conflict" role="alert">
            <span><AlertTriangle size={20} /></span>
            <div>
              <strong>Данные изменились на другом устройстве</strong>
              <p>Серверная версия: рев. {conflict.revision}, {conflict.updatedBy}, {shortTime(conflict.updatedAt)}. Выберите, какую версию оставить.</p>
            </div>
            <div className="sync-conflict__actions">
              <button type="button" className="button button--secondary" onClick={useServerVersion}>Загрузить серверную</button>
              <button type="button" className="button button--primary" onClick={keepLocalVersion}>Оставить мою</button>
            </div>
          </section>
        )}
        <main className="page-container">{content}</main>
      </div>

      <nav className="mobile-bottom-nav">
        {navigation.slice(0, role === 'management' ? 5 : 4).map((item) => {
          const Icon = item.icon;
          return <button type="button" key={item.id} className={page === item.id ? 'active' : ''} onClick={() => navigate(item.id)}><Icon size={20} /><span>{item.label.split(' ')[0]}</span></button>;
        })}
      </nav>

      {notificationsOpen && (
        <Modal title="Центр уведомлений" subtitle="Каждое событие открывает конкретную задачу, этап, закупку или карточку." onClose={() => setNotificationsOpen(false)}>
          <div className="notification-list">
            {role !== 'client' && state.tasks.filter((task) => isTaskOverdue(task)).slice(0, 3).map((task) => <button type="button" key={task.id} onClick={() => { setNotificationsOpen(false); navigate('tasks', task.id); }}><span><ListTodo size={18} /></span><div><strong>{task.title}</strong><small>{task.assigneeName} · срок {new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(new Date(task.dueDate))}</small></div><StatusBadge label="Просрочено" tone="danger" /></button>)}
            {state.checkpoints.filter((item) => item.status === 'rework').map((item) => <button type="button" key={item.id} onClick={() => { setNotificationsOpen(false); navigate('quality', item.id); }}><span><AlertTriangle size={18} /></span><div><strong>{item.title}</strong><small>Контроль качества · требуется доработка</small></div><StatusBadge label="Важно" tone="danger" /></button>)}
            {role !== 'client' && state.stages.filter((item) => ['blocked', 'rework', 'awaiting_inspection'].includes(item.status)).map((item) => <button type="button" key={item.id} onClick={() => { setNotificationsOpen(false); navigate('schedule', item.id); }}><span><CalendarRange size={18} /></span><div><strong>{item.name}</strong><small>{item.status === 'blocked' ? item.blocker ?? 'Этап заблокирован' : item.status === 'rework' ? 'Этап возвращён на доработку' : 'Этап ожидает приёмки'}</small></div><StatusBadge label={item.status === 'awaiting_inspection' ? 'Проверить' : 'График'} tone={item.status === 'awaiting_inspection' ? 'blue' : 'danger'} /></button>)}
            {role !== 'client' && state.procurement.filter((item) => item.risk).map((item) => <button type="button" key={item.id} onClick={() => { setNotificationsOpen(false); navigate('procurement', item.id); }}><span><PackageSearch size={18} /></span><div><strong>{item.item}</strong><small>{item.risk}</small></div><StatusBadge label="Риск" tone="warning" /></button>)}
            {role === 'management' && state.leads.filter((item) => item.stage === 'new').slice(0, 2).map((item) => <button type="button" key={item.id} onClick={() => { setNotificationsOpen(false); navigate('marketing', item.id); }}><span><Megaphone size={18} /></span><div><strong>Новая заявка: {item.name}</strong><small>{item.nextAction}</small></div><StatusBadge label="CRM" tone="blue" /></button>)}
            {notificationCount === 0 && <div className="task-empty"><Bell size={27} /><strong>Новых уведомлений нет</strong><p>События проекта появятся здесь и откроются сразу в нужной карточке.</p></div>}
          </div>
        </Modal>
      )}

      {projectOpen && (
        <Modal title="Проекты" subtitle="Переключайтесь между домами или создайте новый проект по стартовому шаблону." onClose={() => setProjectOpen(false)}>
          {role !== 'client' && <button type="button" className="project-picker__open-card" onClick={() => { setProjectOpen(false); navigate('project'); }}><FolderKanban size={18} /><span><strong>Открыть карточку текущего проекта</strong><small>Реквизиты объекта, команда и документы</small></span></button>}
          <div className="project-picker__list" data-tour="project-list">{projects.map((project) => <button type="button" key={project.id} className={project.id === state.project.id ? 'project-picker__item project-picker__item--active' : 'project-picker__item'} onClick={() => { setProjectOpen(false); void switchProject(project.id); }}><span><House size={20} /></span><div><small>{project.code}{project.id === state.project.id ? ' · активный проект' : ''}</small><strong>{project.name}</strong><p>{project.model} · {project.area} м²</p></div><StatusBadge label={project.id === state.project.id ? 'Выбран' : 'Открыть'} tone={project.id === state.project.id ? 'positive' : 'neutral'} /></button>)}</div>
          <button type="button" data-tour="new-project" className="project-picker__add" onClick={() => {
            const realProjectCount = projects.filter((project) => project.id !== 'workspace-initial').length;
            setProjectOpen(false);
            setProjectForm({
              code: `H-${String(realProjectCount + 1).padStart(3, '0')}`,
              name: '',
              clientNames: '',
              address: '',
              model: '',
              area: '',
              contractValue: '',
              targetCost: '',
              startDate: new Date().toISOString().slice(0, 10),
              targetDate: '',
              foreman: state.project.foreman,
              source: '',
            });
            setCreateProjectOpen(true);
          }}><Plus size={18} /> Добавить новый дом <small>проект, график и стартовая смета</small></button>
        </Modal>
      )}

      {createProjectOpen && <Modal wide title="Новый строительный проект" subtitle="Сначала основные параметры и сроки. Неизвестные финансовые цифры можно оставить пустыми и заполнить после сметы." onClose={() => setCreateProjectOpen(false)}><form className="modal-form" onSubmit={submitProject}><div className="form-grid"><Field label="Код проекта"><input required value={projectForm.code} onChange={(event) => setProjectForm({ ...projectForm, code: event.target.value })} placeholder="H-001" /></Field><Field label="Название"><input required value={projectForm.name} onChange={(event) => setProjectForm({ ...projectForm, name: event.target.value })} placeholder="Рабочее название объекта" /></Field><Field label="Клиент"><input value={projectForm.clientNames} onChange={(event) => setProjectForm({ ...projectForm, clientNames: event.target.value })} /></Field><Field label="Адрес"><input value={projectForm.address} onChange={(event) => setProjectForm({ ...projectForm, address: event.target.value })} /></Field></div><div className="form-grid"><Field label="Модель / технология"><input value={projectForm.model} onChange={(event) => setProjectForm({ ...projectForm, model: event.target.value })} /></Field><Field label="Площадь, м²"><input required min="1" type="number" inputMode="decimal" value={projectForm.area} onChange={(event) => setProjectForm({ ...projectForm, area: event.target.value })} /></Field><Field label="Стоимость договора, ₽" hint="Можно заполнить позже"><input min="0" type="number" inputMode="numeric" value={projectForm.contractValue} onChange={(event) => setProjectForm({ ...projectForm, contractValue: event.target.value })} /></Field><Field label="Плановая себестоимость, ₽" hint="Можно заполнить после сметы"><input min="0" type="number" inputMode="numeric" value={projectForm.targetCost} onChange={(event) => setProjectForm({ ...projectForm, targetCost: event.target.value })} /></Field></div><div className="form-grid"><Field label="Начало"><input required type="date" value={projectForm.startDate} onChange={(event) => setProjectForm({ ...projectForm, startDate: event.target.value })} /></Field><Field label="Плановая сдача"><input required type="date" value={projectForm.targetDate} onChange={(event) => setProjectForm({ ...projectForm, targetDate: event.target.value })} /></Field><Field label="Прораб"><input value={projectForm.foreman} onChange={(event) => setProjectForm({ ...projectForm, foreman: event.target.value })} /></Field><Field label="Основание проекта"><input value={projectForm.source} onChange={(event) => setProjectForm({ ...projectForm, source: event.target.value })} placeholder="Договор, заявка или внутреннее решение" /></Field></div><div className="form-warning"><ClipboardCheck size={18} /><span>ИКИОМА ОС создаст 13 этапов. Если указана плановая себестоимость, она предварительно распределится по пакетам; до подтверждения это будет черновик.</span></div><div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setCreateProjectOpen(false)}>Отмена</button><button type="submit" className="button button--primary"><Plus size={17} /> Создать проект</button></div></form></Modal>}

      {role === 'management' && <HelpCenter onNavigate={navigate} onOpenProjects={() => setProjectOpen(true)} />}
    </div>
  );
}

export default App;
