import { useSession } from './presentation/useSession';
import { useWorkspaceProject } from './presentation/useWorkspaceProject';
import { CreateProjectDialog } from './presentation/CreateProjectDialog';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { WorkspacePages } from './presentation/WorkspacePages';
import {
  AlertTriangle,
  Bell,
  CalendarRange,
  ChevronDown,
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
  LogOut,
  Settings2,
  ShieldCheck,
  UserRound,
  UsersRound,
  WalletCards,
  X,
} from 'lucide-react';
import { AppInstall } from './components/AppInstall';
import { HelpCenter } from './components/HelpCenter';
import { QuestionRegistry } from './components/QuestionRegistry';
import { Modal, StatusBadge } from './components/Ui';
import type { UserRole } from './entities/index';
import { allowedPages, pageLabels, workspacePath, type PageId } from './presentation/navigation';
import type { SyncPhase } from './useProjectState';
import { isTaskOverdue, projectProgressTotals } from './domain/index';

const roleLabels: Record<UserRole, string> = {
  management: 'Управление',
  foreman: 'Прораб',
  client: 'Клиент',
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
  const todayKey = new Date().toISOString().slice(0, 10);
  const location = useLocation();
  const changeLocation = useNavigate();
  const { session, role, sessionError } = useSession();
  const { state, updateState, sync, localCache, conflict, retry, useServerVersion, keepLocalVersion, applyServerSnapshot, reconcileServerSnapshot, projects, createProject, route, page } = useWorkspaceProject(session, role);
  const focusEntityId = route.entityId;
  const [mobileMenu, setMobileMenu] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [questionsOpen, setQuestionsOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);

  useEffect(() => {
    setMobileMenu(false);
    setProfileOpen(false);
    document.title = `${pageLabels[page]} · ИКИОМА ОС`;
    document.getElementById('workspace-page')?.focus();
  }, [location.key, page]);

  const navigation = useMemo(() => {
    if (role === 'client') return fullNavigation.filter((item) => item.id === 'client');
    if (role === 'foreman') return fullNavigation.filter((item) => ['overview', 'project', 'tasks', 'schedule', 'procurement', 'quality'].includes(item.id));
    return fullNavigation.filter((item) => item.id !== 'settings' && item.id !== 'client');
  }, [role]);

  const notificationCount = useMemo(() => {
    const overdue = role === 'client' ? 0 : state.tasks.filter((task) => isTaskOverdue(task, todayKey)).length;
    const quality = state.checkpoints.filter((item) => item.status === 'rework').length;
    const supply = role === 'client' ? 0 : state.procurement.filter((item) => item.risk).length;
    const schedule = role === 'client' ? 0 : state.stages.filter((item) => ['blocked', 'rework', 'awaiting_inspection'].includes(item.status)).length;
    const leads = role === 'management' ? state.leads.filter((item) => item.stage === 'new').length : 0;
    return overdue + quality + supply + schedule + leads;
  }, [role, state.checkpoints, state.leads, state.procurement, state.stages, state.tasks, todayKey]);

  const navigate = (nextPage: PageId, entityId?: string) => {
    setProfileOpen(false);
    setMobileMenu(false);
    if (allowedPages(role).includes(nextPage)) {
      void changeLocation(workspacePath(state.project.id, nextPage, entityId));
    }
  };


  if (!session) {
    return <div className="session-gate"><span><ShieldCheck size={28} /></span><h1>{sessionError ? 'Доступ не назначен' : 'Проверяем рабочий доступ'}</h1><p>{sessionError || 'ИКИОМА ОС определяет ваш аккаунт и роль в проектах.'}</p>{sessionError && <button type="button" className="button button--primary" onClick={() => window.location.reload()}>Повторить</button>}</div>;
  }

  return (
    <div className={`app-shell ${page === 'overview' ? 'app-shell--overview' : ''} ${sidebarCollapsed ? 'app-shell--collapsed' : ''}`}>
      {mobileMenu && <button className="mobile-scrim" type="button" aria-label="Закрыть меню" onClick={() => setMobileMenu(false)} />}
      <aside className={`sidebar ${mobileMenu ? 'sidebar--open' : ''}`}>
        <div className="sidebar__brand">
          <span className="brand-mark" aria-hidden="true"><img src="/brand/ikioma-mark-20261019.png" alt="" width="27" height="32" /></span>
          <span className="brand-copy"><strong>ИКИОМА <span>ОС</span></strong></span>
          <button type="button" className="sidebar__mobile-close" onClick={() => setMobileMenu(false)} aria-label="Закрыть меню"><X size={19} /></button>
        </div>

        <button className="project-switcher" data-tour="project-switcher" type="button" onClick={() => setProjectOpen(true)}>
          <span className="project-switcher__icon"><House size={19} /></span>
          <span><small>{state.project.code}</small><strong>{state.project.name}</strong>
            {state.project.status !== 'workspace' && <small className="project-switcher__progress" title="Выполнение внесённых этапов и задач ППР, не готовность всего дома">ППР · {state.stages.length ? `${projectProgressTotals(state).physical}%` : '—'}</small>}
          </span>
          <ChevronDown size={15} />
        </button>

        <nav className="sidebar__nav" aria-label="Основная навигация">
          <small className="sidebar__label">{role === 'client' ? 'Мой дом' : 'Проект'}</small>
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <Link to={workspacePath(state.project.id, item.id)} key={item.id} data-tour={`nav-${item.id}`} className={page === item.id ? 'active' : ''} aria-current={page === item.id ? 'page' : undefined} title={item.label}>
                <Icon size={19} strokeWidth={1.6} /><span>{item.label}</span>
                {item.id === 'quality' && state.checkpoints.some((checkpoint) => checkpoint.status === 'rework') && <i className="nav-alert" />}
                {item.id === 'tasks' && state.tasks.some((task) => isTaskOverdue(task, todayKey)) && <i className="nav-alert" />}
              </Link>
            );
          })}
        </nav>

        {role === 'management' && <div className="sidebar__footer"><Link to={workspacePath(state.project.id, 'settings')} data-tour="nav-settings" title="Настройки" className={page === 'settings' ? 'active' : ''} aria-current={page === 'settings' ? 'page' : undefined}><Settings2 size={18} /><span>Настройки</span></Link></div>}
        <AppInstall />
        <button type="button" className="sidebar-toggle" onClick={() => setSidebarCollapsed((value) => !value)} aria-label={sidebarCollapsed ? 'Развернуть меню' : 'Свернуть меню'} aria-expanded={!sidebarCollapsed} title={sidebarCollapsed ? 'Развернуть меню' : 'Свернуть меню'}><PanelLeftClose size={18} strokeWidth={1.6} /><span>Свернуть меню</span></button>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className="topbar__left">
            <button type="button" className="mobile-menu-button" onClick={() => setMobileMenu(true)} aria-label="Открыть меню"><Menu size={21} /></button>
            <div className="mobile-app-title"><img src="/brand/ikioma-mark-20261019.png" alt="" width="20" height="24" /><span><strong>ИКИОМА</strong><small>{pageLabels[page]}</small></span></div>
            <div className="breadcrumbs"><span>{state.project.code}</span><i>/</i><strong>{pageLabels[page]}</strong></div>
          </div>
          <div className="topbar__right">
            <button
              type="button"
              className={`sync-chip sync-chip--${sync.phase}`}
              onClick={sync.phase === 'offline' ? retry : undefined}
              aria-label={sync.message ?? syncLabels[sync.phase]}
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
            {localCache.phase === 'failed' && (
              <div className="local-cache-alert" role="status" aria-live="assertive" title={localCache.message}>
                <AlertTriangle size={16} />
                <span><strong>Локальная копия не сохранена</strong><small>{sync.phase === 'offline' ? 'не закрывайте вкладку' : 'серверная копия работает'}</small></span>
              </div>
            )}
            <span className="session-role"><ShieldCheck size={15} /> {roleLabels[role]}</span>
            <button type="button" className="notification-button" aria-label={`Уведомления: ${notificationCount}`} onClick={() => setNotificationsOpen(true)}><Bell size={19} />{notificationCount > 0 && <i />}</button>
            <div className="profile-menu">
              <button type="button" className="user-chip" data-tour="profile-menu" aria-haspopup="menu" aria-expanded={profileOpen} onClick={() => setProfileOpen((value) => !value)}>
                <span>{initials(session.name)}</span><div><strong>{session.name}</strong><small>{session.email}</small></div><ChevronDown size={15} />
              </button>
              {profileOpen && <div className="profile-menu__dropdown" role="menu">
                <div><strong>{session.name}</strong><small>{session.email}</small><span>{roleLabels[role]}</span></div>
                {role === 'management' && <button type="button" role="menuitem" onClick={() => navigate('settings')}><Settings2 size={17} /> Настройки</button>}
                <form action="/api/auth/logout" method="post"><button type="submit" role="menuitem"><LogOut size={17} /> Выйти из аккаунта</button></form>
              </div>}
            </div>
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
        <main className="page-container" id="workspace-page" tabIndex={-1}>
          {!route.valid ? <div className="task-empty" role="alert"><strong>Раздел не найден</strong><button type="button" className="button button--primary" onClick={() => navigate(role === 'client' ? 'client' : 'overview')}>На главную</button></div>
            : !allowedPages(role).includes(page) ? <div role="status">Открываем доступный раздел…</div>
            : route.projectId && route.projectId !== state.project.id ? <div className="task-empty" role="status" aria-live="polite"><strong>{sync.phase === 'loading' ? 'Загружаем проект…' : 'Не удалось открыть проект'}</strong>{sync.phase !== 'loading' && <><p>{sync.message || 'Проверьте доступ к проекту или подключение к сети.'}</p><button type="button" className="button button--primary" onClick={() => navigate(role === 'client' ? 'client' : 'overview')}>К текущему проекту</button></>}</div>
            : location.pathname === '/' ? <div role="status">Открываем раздел…</div>
            : <WorkspacePages key={`${state.project.id}:${page}`} state={state} session={session} role={role} focusEntityId={focusEntityId} updateState={updateState} navigate={navigate} applyServerSnapshot={applyServerSnapshot} reconcileServerSnapshot={reconcileServerSnapshot} openQuestions={() => setQuestionsOpen(true)} openProjects={() => setCreateProjectOpen(true)} />}
        </main>
      </div>

      <nav className="mobile-bottom-nav" aria-label="Разделы приложения">
        {navigation.slice(0, role === 'management' ? 5 : 4).map((item) => {
          const Icon = item.icon;
          return <Link to={workspacePath(state.project.id, item.id)} key={item.id} className={page === item.id ? 'active' : ''} aria-current={page === item.id ? 'page' : undefined}><Icon size={20} /><span>{item.label.split(' ')[0]}</span></Link>;
        })}
      </nav>

      {notificationsOpen && (
        <Modal title="Центр уведомлений" subtitle="Каждое событие открывает конкретную задачу, этап, закупку или карточку." onClose={() => setNotificationsOpen(false)}>
          <div className="notification-list">
            {role !== 'client' && state.tasks.filter((task) => isTaskOverdue(task, todayKey)).slice(0, 3).map((task) => <button type="button" key={task.id} onClick={() => { setNotificationsOpen(false); navigate('tasks', task.id); }}><span><ListTodo size={18} /></span><div><strong>{task.title}</strong><small>{task.assigneeName} · срок {new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(new Date(task.dueDate))}</small></div><StatusBadge label="Просрочено" tone="danger" /></button>)}
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
          <div className="project-picker__list" data-tour="project-list">{projects.map((project) => <button type="button" key={project.id} className={project.id === state.project.id ? 'project-picker__item project-picker__item--active' : 'project-picker__item'} onClick={() => { setProjectOpen(false); void changeLocation(workspacePath(project.id, page)); }}><span><House size={20} /></span><div><small>{project.code}{project.id === state.project.id ? ' · активный проект' : ''}</small><strong>{project.name}</strong><p>{project.model} · {project.area} м²</p></div><StatusBadge label={project.id === state.project.id ? 'Выбран' : 'Открыть'} tone={project.id === state.project.id ? 'positive' : 'neutral'} /></button>)}</div>
          <button type="button" data-tour="new-project" className="project-picker__add" onClick={() => {
            setProjectOpen(false);
            setCreateProjectOpen(true);
          }}><Plus size={18} /> Добавить новый дом <small>проект, график и стартовая смета</small></button>
        </Modal>
      )}

      {createProjectOpen && <CreateProjectDialog nextCode={`H-${String(projects.filter(project => project.id !== 'workspace-initial').length + 1).padStart(3, '0')}`} state={state} actor={session.name} onClose={() => setCreateProjectOpen(false)} onCreate={async next => { setCreateProjectOpen(false); setProjectOpen(false); void changeLocation(workspacePath(next.project.id, 'overview')); await createProject(next); }} />}

      {role === 'management' && questionsOpen && <QuestionRegistry key={state.project.id} projectId={state.project.id} currentPage={page} onClose={() => setQuestionsOpen(false)} />}
      {role === 'management' && <HelpCenter onOpenQuestions={() => setQuestionsOpen(true)} projectId={state.project.id} currentPage={page} onNavigate={navigate} onOpenProjects={() => setProjectOpen(true)} onCloseProjects={() => setProjectOpen(false)} />}
    </div>
  );
}

export default App;
