import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronRight,
  CirclePause,
  ClipboardList,
  Clock3,
  History,
  Link2,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  UserRound,
  UsersRound,
} from 'lucide-react';
import { addTaskComment, changeTaskStatus, isTaskClosed, isTaskOverdue, saveTask as saveTaskChange } from '../domain/index';
import { formatDate, formatDateTime } from '../presentation/formatting';
import { taskPriorityLabel, taskStatusLabel } from '../presentation/status-labels';
import { commitStateChange, createMutationContext, type StateChangeSink } from '../application';
import { runtimeIdGenerator, systemClock, uid } from '../infrastructure/runtime';
import type {
  AppState,
  AuthenticatedUser,
  ProjectTask,
  TaskPriority,
  TaskStatus,
  UserRole,
} from '../entities/index';
import type { PageId } from '../presentation/navigation';
import { Field, Modal, SectionHeader, StatusBadge } from '../components/Ui';

type TaskScope = 'all' | 'mine' | 'today' | 'overdue' | 'review' | 'done';
type TaskView = 'tasks' | 'people';

const today = () => new Date().toISOString().slice(0, 10);
const activeStatuses: TaskStatus[] = ['todo', 'in_progress', 'waiting', 'review'];
const priorityWeight: Record<TaskPriority, number> = { critical: 4, high: 3, normal: 2, low: 1 };
const roleLabels: Record<UserRole, string> = { management: 'Управление', foreman: 'Прораб', client: 'Клиент' };

const statusTone = (status: TaskStatus): 'neutral' | 'positive' | 'warning' | 'danger' | 'blue' => {
  if (status === 'done') return 'positive';
  if (status === 'in_progress' || status === 'review') return 'blue';
  if (status === 'waiting') return 'warning';
  if (status === 'canceled') return 'neutral';
  return 'neutral';
};

const priorityTone = (priority: TaskPriority): 'neutral' | 'warning' | 'danger' | 'blue' => {
  if (priority === 'critical') return 'danger';
  if (priority === 'high') return 'warning';
  if (priority === 'normal') return 'blue';
  return 'neutral';
};

const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((part) => part[0]).slice(0, 2).join('').toUpperCase();

const lateDays = (dueDate: string) => Math.max(1, Math.ceil((new Date(`${today()}T12:00:00Z`).getTime() - new Date(`${dueDate}T12:00:00Z`).getTime()) / 86_400_000));

const emptyForm = (assigneeId = '') => ({
  title: '',
  description: '',
  priority: 'normal' as TaskPriority,
  assigneeId,
  reviewerId: '',
  dueDate: today(),
  stageId: '',
  counterpartyId: '',
  procurementItemId: '',
  checkpointId: '',
});

export function TasksPage({
  state,
  role,
  session,
  focusId,
  onChange,
  onNavigate,
}: {
  state: AppState;
  role: UserRole;
  session: AuthenticatedUser;
  focusId?: string | null;
  onChange: StateChangeSink;
  onNavigate: (page: PageId, entityId?: string) => void;
}) {
  const internalUsers = state.settings.users.filter((user) => user.role !== 'client' && user.status !== 'disabled');
  const currentUser = internalUsers.find((user) => user.id === session.id)
    ?? internalUsers.find((user) => user.name === session.name)
    ?? internalUsers.find((user) => user.role === role && user.status === 'active')
    ?? internalUsers[0];
  const actor = session.name;
  const visibleTasks = role === 'management'
    ? state.tasks
    : state.tasks.filter((task) => task.assigneeId === session.id || task.assigneeName === session.name);

  const [view, setView] = useState<TaskView>('tasks');
  const [scope, setScope] = useState<TaskScope>(role === 'management' ? 'all' : 'mine');
  const [search, setSearch] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(() => emptyForm(currentUser?.id));
  const [comment, setComment] = useState('');
  const [completionNote, setCompletionNote] = useState('');

  const todayKey = today();
  useEffect(() => {
    if (focusId && visibleTasks.some((task) => task.id === focusId)) {
      setSelectedId(focusId);
      setView('tasks');
    }
  }, [focusId, visibleTasks]);

  const openTasks = visibleTasks.filter((task) => !isTaskClosed(task.status));
  const overdueTasks = openTasks.filter((task) => isTaskOverdue(task, todayKey));
  const todayTasks = openTasks.filter((task) => task.dueDate === todayKey);
  const reviewTasks = openTasks.filter((task) => task.status === 'review');

  const filteredTasks = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('ru');
    return [...visibleTasks]
      .filter((task) => {
        if (scope === 'mine' && task.assigneeId !== currentUser?.id && task.assigneeName !== currentUser?.name) return false;
        if (scope === 'today' && task.dueDate !== todayKey) return false;
        if (scope === 'overdue' && !isTaskOverdue(task, todayKey)) return false;
        if (scope === 'review' && task.status !== 'review') return false;
        if (scope === 'done' && task.status !== 'done') return false;
        if (assigneeFilter && task.assigneeId !== assigneeFilter) return false;
        if (!query) return true;
        const stage = state.stages.find((item) => item.id === task.stageId)?.name ?? '';
        return [task.title, task.description, task.assigneeName, stage].some((value) => value?.toLocaleLowerCase('ru').includes(query));
      })
      .sort((a, b) => {
        const aClosed = isTaskClosed(a.status) ? 1 : 0;
        const bClosed = isTaskClosed(b.status) ? 1 : 0;
        if (aClosed !== bClosed) return aClosed - bClosed;
        const aOverdue = isTaskOverdue(a, todayKey) ? 1 : 0;
        const bOverdue = isTaskOverdue(b, todayKey) ? 1 : 0;
        if (aOverdue !== bOverdue) return bOverdue - aOverdue;
        if (priorityWeight[a.priority] !== priorityWeight[b.priority]) return priorityWeight[b.priority] - priorityWeight[a.priority];
        return a.dueDate.localeCompare(b.dueDate);
      });
  }, [assigneeFilter, currentUser?.id, currentUser?.name, scope, search, state.stages, todayKey, visibleTasks]);

  const selected = visibleTasks.find((task) => task.id === selectedId) ?? null;

  const openCreate = () => {
    if (role !== 'management') return;
    setEditingId(null);
    setForm(emptyForm(currentUser?.id ?? internalUsers[0]?.id));
    setShowForm(true);
  };

  const openEdit = (task: ProjectTask) => {
    if (role !== 'management') return;
    setSelectedId(null);
    setEditingId(task.id);
    setForm({
      title: task.title,
      description: task.description ?? '',
      priority: task.priority,
      assigneeId: task.assigneeId,
      reviewerId: task.reviewerId ?? '',
      dueDate: task.dueDate,
      stageId: task.stageId ?? '',
      counterpartyId: task.counterpartyId ?? '',
      procurementItemId: task.procurementItemId ?? '',
      checkpointId: task.checkpointId ?? '',
    });
    setShowForm(true);
  };

  const saveTask = (event: FormEvent) => {
    event.preventDefault();
    if (role !== 'management') return;
    const assignee = internalUsers.find((user) => user.id === form.assigneeId);
    if (!form.title.trim() || !assignee || !form.dueDate) return;
    const reviewer = internalUsers.find((user) => user.id === form.reviewerId);
    const timestamp = new Date().toISOString();

    if (!editingId) {
      const task: ProjectTask = {
        id: uid('task'),
        title: form.title.trim(),
        description: form.description.trim() || undefined,
        status: 'todo',
        priority: form.priority,
        assigneeId: assignee.id,
        assigneeName: assignee.name,
        reviewerId: reviewer?.id,
        reviewerName: reviewer?.name,
        createdBy: actor,
        createdAt: timestamp,
        updatedAt: timestamp,
        dueDate: form.dueDate,
        originalDueDate: form.dueDate,
        stageId: form.stageId || undefined,
        counterpartyId: form.counterpartyId || undefined,
        procurementItemId: form.procurementItemId || undefined,
        checkpointId: form.checkpointId || undefined,
        rescheduleCount: 0,
        history: [{ id: uid('task-history'), timestamp, actor, kind: 'created', text: `Создал задачу и назначил ${assignee.name}` }],
      };
      commitStateChange(saveTaskChange(state, { task, isNew: true }, createMutationContext(actor, systemClock, runtimeIdGenerator)), onChange);
    } else {
      const previous = state.tasks.find((task) => task.id === editingId);
      if (!previous) return;
      const changes = [];
      if (previous.assigneeId !== assignee.id) changes.push({ id: uid('task-history'), timestamp, actor, kind: 'assignee' as const, text: `Ответственный изменён: ${previous.assigneeName} → ${assignee.name}` });
      if (previous.dueDate !== form.dueDate) changes.push({ id: uid('task-history'), timestamp, actor, kind: 'due_date' as const, text: `Срок изменён: ${formatDate(previous.dueDate, true)} → ${formatDate(form.dueDate, true)}` });
      if (previous.title !== form.title.trim() || previous.description !== (form.description.trim() || undefined) || previous.priority !== form.priority) changes.push({ id: uid('task-history'), timestamp, actor, kind: 'edited' as const, text: 'Обновлены содержание или приоритет задачи' });
      const task: ProjectTask = {
        ...previous,
        title: form.title.trim(),
        description: form.description.trim() || undefined,
        priority: form.priority,
        assigneeId: assignee.id,
        assigneeName: assignee.name,
        reviewerId: reviewer?.id,
        reviewerName: reviewer?.name,
        dueDate: form.dueDate,
        stageId: form.stageId || undefined,
        counterpartyId: form.counterpartyId || undefined,
        procurementItemId: form.procurementItemId || undefined,
        checkpointId: form.checkpointId || undefined,
        updatedAt: timestamp,
        rescheduleCount: previous.rescheduleCount + (previous.dueDate !== form.dueDate ? 1 : 0),
        history: [...changes, ...previous.history],
      };
      commitStateChange(saveTaskChange(state, { task, isNew: false }, createMutationContext(actor, systemClock, runtimeIdGenerator)), onChange);
    }
    setShowForm(false);
    setEditingId(null);
  };

  const changeStatus = (task: ProjectTask, status: TaskStatus, text: string, extra: Partial<ProjectTask> = {}) => {
    commitStateChange(changeTaskStatus(
      state,
      { taskId: task.id, status, text, extra },
      createMutationContext(actor, systemClock, runtimeIdGenerator),
    ), onChange);
    setComment('');
    setCompletionNote('');
  };

  const addComment = (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !comment.trim()) return;
    commitStateChange(addTaskComment(state, { taskId: selected.id, text: comment.trim() }, createMutationContext(actor, systemClock, runtimeIdGenerator)), onChange);
    setComment('');
  };

  const relatedStage = selected ? state.stages.find((item) => item.id === selected.stageId) : undefined;
  const relatedCounterparty = selected ? state.counterparties.find((item) => item.id === selected.counterpartyId) : undefined;
  const relatedProcurement = selected ? state.procurement.find((item) => item.id === selected.procurementItemId) : undefined;
  const relatedCheckpoint = selected ? state.checkpoints.find((item) => item.id === selected.checkpointId) : undefined;

  const scopes: Array<{ id: TaskScope; label: string; count?: number }> = [
    { id: 'all', label: 'Все', count: visibleTasks.length },
    { id: 'mine', label: 'Мои' },
    { id: 'today', label: 'Сегодня', count: todayTasks.length },
    { id: 'overdue', label: 'Просроченные', count: overdueTasks.length },
    { id: 'review', label: 'На проверке', count: reviewTasks.length },
    { id: 'done', label: 'Выполненные' },
  ];

  return (
    <div className="page-stack">
      <section className="page-title-row">
        <div>
          <span className="eyebrow">Внутренняя работа команды</span>
          <h1>Задачи и ответственность</h1>
          <p>Один ответственный, понятный срок, связь с проектом и полная история изменений.</p>
        </div>
        {role === 'management' && <button type="button" data-tour="task-add" className="button button--primary" onClick={openCreate}><Plus size={17} /> Новая задача</button>}
      </section>

      <section className="task-metric-grid">
        <button type="button" onClick={() => { setView('tasks'); setScope('all'); }}><span><ClipboardList size={19} /></span><small>Активные</small><strong>{openTasks.length}</strong><p>{openTasks.filter((task) => task.status === 'in_progress').length} сейчас в работе</p></button>
        <button type="button" className={overdueTasks.length ? 'task-metric--danger' : ''} onClick={() => { setView('tasks'); setScope('overdue'); }}><span><AlertTriangle size={19} /></span><small>Просрочены</small><strong>{overdueTasks.length}</strong><p>{overdueTasks.length ? 'нужна новая дата или действие' : 'сроки под контролем'}</p></button>
        <button type="button" onClick={() => { setView('tasks'); setScope('today'); }}><span><CalendarClock size={19} /></span><small>Срок сегодня</small><strong>{todayTasks.length}</strong><p>{todayTasks.filter((task) => task.status === 'review').length} ожидают проверки</p></button>
        <button type="button" onClick={() => { setView('tasks'); setScope('review'); }}><span><ShieldCheck size={19} /></span><small>На проверке</small><strong>{reviewTasks.length}</strong><p>не закрываются без результата</p></button>
      </section>

      <section className="panel task-workspace" data-tour="task-workspace">
        <div className="task-workspace__head">
          <div className="task-view-switch">
            <button type="button" className={view === 'tasks' ? 'active' : ''} onClick={() => setView('tasks')}><ClipboardList size={17} /> Задачи</button>
            {role === 'management' && <button type="button" className={view === 'people' ? 'active' : ''} onClick={() => setView('people')}><UsersRound size={17} /> Ответственные</button>}
          </div>
          {view === 'tasks' && <div className="task-search"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Найти задачу, этап или человека" /></div>}
        </div>

        {view === 'tasks' ? (
          <>
            <div className="task-filters">
              <div className="task-filter-chips">{scopes.filter((item) => role === 'management' || item.id !== 'all').map((item) => <button type="button" key={item.id} className={scope === item.id ? 'active' : ''} onClick={() => setScope(item.id)}>{item.label}{typeof item.count === 'number' && <span>{item.count}</span>}</button>)}</div>
              {role === 'management' && <select aria-label="Ответственный" value={assigneeFilter} onChange={(event) => setAssigneeFilter(event.target.value)}>
                <option value="">Все ответственные</option>
                {internalUsers.map((user) => <option value={user.id} key={user.id}>{user.name}</option>)}
              </select>}
            </div>

            <div className="task-list">
              {filteredTasks.map((task) => {
                const stage = state.stages.find((item) => item.id === task.stageId);
                const overdue = isTaskOverdue(task, todayKey);
                return (
                  <button type="button" key={task.id} className={`task-row ${overdue ? 'task-row--overdue' : ''}`} onClick={() => { setSelectedId(task.id); setComment(''); setCompletionNote(task.completionNote ?? ''); }}>
                    <span className={`task-row__state task-row__state--${task.status}`}>{task.status === 'done' ? <Check size={17} /> : task.status === 'waiting' ? <CirclePause size={17} /> : task.status === 'review' ? <ShieldCheck size={17} /> : task.status === 'in_progress' ? <Play size={16} /> : <ClipboardList size={16} />}</span>
                    <span className="task-row__main"><strong>{task.title}</strong><small>{stage ? stage.name : 'Общая задача'}{task.rescheduleCount ? ` · переносов: ${task.rescheduleCount}` : ''}</small></span>
                    <StatusBadge label={taskPriorityLabel[task.priority]} tone={priorityTone(task.priority)} />
                    <span className="task-row__person"><i>{initials(task.assigneeName)}</i><span><small>Ответственный</small><strong>{task.assigneeName}</strong></span></span>
                    <span className={overdue ? 'task-row__date task-row__date--danger' : 'task-row__date'}><small>{overdue ? `Просрочено на ${lateDays(task.dueDate)} дн.` : task.dueDate === todayKey ? 'Срок сегодня' : 'Срок'}</small><strong>{formatDate(task.dueDate, true)}</strong></span>
                    <StatusBadge label={taskStatusLabel[task.status]} tone={statusTone(task.status)} />
                    <ChevronRight size={17} />
                  </button>
                );
              })}
              {!filteredTasks.length && <div className="task-empty"><CheckCircle2 size={28} /><strong>В этом фильтре задач нет</strong><p>Измените фильтр или создайте новую задачу.</p></div>}
            </div>
          </>
        ) : (
          <div className="responsibility-grid">
            {internalUsers.map((user) => {
              const assigned = state.tasks.filter((task) => task.assigneeId === user.id);
              const active = assigned.filter((task) => activeStatuses.includes(task.status));
              const overdue = assigned.filter((task) => isTaskOverdue(task, todayKey));
              const done = assigned.filter((task) => task.status === 'done');
              const nextTask = [...active].sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
              return (
                <button type="button" key={user.id} className="responsibility-card" onClick={() => { setAssigneeFilter(user.id); setScope('all'); setView('tasks'); }}>
                  <span className="responsibility-card__avatar">{initials(user.name)}</span>
                  <span className="responsibility-card__identity"><strong>{user.name}</strong><small>{roleLabels[user.role]} · {user.status === 'active' ? 'активен' : 'доступ ещё не выдан'}</small></span>
                  <span className="responsibility-card__metrics"><span><small>Активные</small><strong>{active.length}</strong></span><span className={overdue.length ? 'danger-text' : ''}><small>Просрочены</small><strong>{overdue.length}</strong></span><span><small>Выполнено</small><strong>{done.length}</strong></span></span>
                  <span className="responsibility-card__next"><Clock3 size={15} /><span><small>Ближайшая задача</small><strong>{nextTask ? `${formatDate(nextTask.dueDate)} · ${nextTask.title}` : 'Нет активных задач'}</strong></span></span>
                  <ArrowRight size={18} />
                </button>
              );
            })}
          </div>
        )}
      </section>

      {showForm && (
        <Modal wide title={editingId ? 'Редактировать задачу' : 'Новая задача'} subtitle="Ответственный и срок обязательны. Остальные связи добавляйте только когда они действительно нужны." onClose={() => setShowForm(false)}>
          <form className="modal-form" onSubmit={saveTask}>
            <Field label="Задача"><input required value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="Что должно быть сделано и проверено" /></Field>
            <Field label="Описание / ожидаемый результат"><textarea rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="Критерий готовности, документы или фото" /></Field>
            <div className="form-grid">
              <Field label="Ответственный"><select required value={form.assigneeId} onChange={(event) => setForm({ ...form, assigneeId: event.target.value })}><option value="">Выберите</option>{internalUsers.map((user) => <option value={user.id} key={user.id}>{user.name}</option>)}</select></Field>
              <Field label="Проверяет"><select value={form.reviewerId} onChange={(event) => setForm({ ...form, reviewerId: event.target.value })}><option value="">Без отдельной проверки</option>{internalUsers.map((user) => <option value={user.id} key={user.id}>{user.name}</option>)}</select></Field>
              <Field label="Срок"><input required type="date" value={form.dueDate} onChange={(event) => setForm({ ...form, dueDate: event.target.value })} /></Field>
              <Field label="Приоритет"><select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value as TaskPriority })}><option value="low">Низкий</option><option value="normal">Обычный</option><option value="high">Высокий</option><option value="critical">Критичный</option></select></Field>
            </div>
            <div className="task-form-links">
              <strong><Link2 size={16} /> Связать с работой</strong>
              <div className="form-grid">
                <Field label="Этап"><select value={form.stageId} onChange={(event) => setForm({ ...form, stageId: event.target.value, procurementItemId: '', checkpointId: '' })}><option value="">Без этапа</option>{state.stages.map((stage) => <option value={stage.id} key={stage.id}>{stage.order}. {stage.name}</option>)}</select></Field>
                <Field label="Контрагент"><select value={form.counterpartyId} onChange={(event) => setForm({ ...form, counterpartyId: event.target.value })}><option value="">Без контрагента</option>{state.counterparties.filter((item) => item.type !== 'client').map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field>
                <Field label="Закупка"><select value={form.procurementItemId} onChange={(event) => setForm({ ...form, procurementItemId: event.target.value })}><option value="">Без закупки</option>{state.procurement.filter((item) => !form.stageId || item.stageId === form.stageId).map((item) => <option value={item.id} key={item.id}>{item.item}</option>)}</select></Field>
                <Field label="Проверка качества"><select value={form.checkpointId} onChange={(event) => setForm({ ...form, checkpointId: event.target.value })}><option value="">Без проверки</option>{state.checkpoints.filter((item) => !form.stageId || item.stageId === form.stageId).map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select></Field>
              </div>
            </div>
            <div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setShowForm(false)}>Отмена</button><button type="submit" className="button button--primary">{editingId ? 'Сохранить изменения' : 'Создать задачу'}</button></div>
          </form>
        </Modal>
      )}

      {selected && (
        <Modal wide title={selected.title} subtitle={`${state.project.code} · создана ${formatDateTime(selected.createdAt)}`} onClose={() => setSelectedId(null)}>
          <div className="task-detail">
            <div className="task-detail__summary">
              <div><small>Статус</small><StatusBadge label={taskStatusLabel[selected.status]} tone={statusTone(selected.status)} /></div>
              <div><small>Ответственный</small><strong>{selected.assigneeName}</strong></div>
              <div><small>Срок</small><strong className={isTaskOverdue(selected, todayKey) ? 'danger-text' : ''}>{formatDate(selected.dueDate, true)}</strong></div>
              <div><small>Переносы</small><strong>{selected.rescheduleCount}</strong></div>
            </div>

            {selected.description && <section className="task-detail__description"><small>Ожидаемый результат</small><p>{selected.description}</p></section>}

            {(relatedStage || relatedCounterparty || relatedProcurement || relatedCheckpoint) && <div className="task-related">
              {relatedStage && <button type="button" onClick={() => { setSelectedId(null); onNavigate('schedule', relatedStage.id); }}><CalendarClock size={16} /><span><small>Этап</small><strong>{relatedStage.name}</strong></span><ChevronRight size={16} /></button>}
              {relatedCounterparty && <button type="button" onClick={() => { setSelectedId(null); onNavigate('counterparties', relatedCounterparty.id); }}><UserRound size={16} /><span><small>Контрагент</small><strong>{relatedCounterparty.name}</strong></span><ChevronRight size={16} /></button>}
              {relatedProcurement && <button type="button" onClick={() => { setSelectedId(null); onNavigate('procurement', relatedProcurement.id); }}><Link2 size={16} /><span><small>Закупка</small><strong>{relatedProcurement.item}</strong></span><ChevronRight size={16} /></button>}
              {relatedCheckpoint && <button type="button" onClick={() => { setSelectedId(null); onNavigate('quality', relatedCheckpoint.id); }}><ShieldCheck size={16} /><span><small>Проверка</small><strong>{relatedCheckpoint.title}</strong></span><ChevronRight size={16} /></button>}
            </div>}

            {selected.blockerReason && <div className="task-blocker"><CirclePause size={18} /><span><strong>Задача в ожидании</strong><p>{selected.blockerReason}</p></span></div>}
            {selected.completionNote && <div className="task-result"><CheckCircle2 size={18} /><span><strong>Результат выполнения</strong><p>{selected.completionNote}</p></span></div>}

            <div className="task-detail__actions">
              {role === 'management' && <button type="button" className="button button--secondary" onClick={() => openEdit(selected)}><Pencil size={16} /> Редактировать</button>}
              {selected.status === 'todo' && <button type="button" className="button button--primary" onClick={() => changeStatus(selected, 'in_progress', 'Задача взята в работу')}><Play size={16} /> Начать</button>}
              {selected.status === 'in_progress' && <button type="button" className="button button--secondary" disabled={!comment.trim()} onClick={() => changeStatus(selected, 'waiting', `Задача поставлена в ожидание: ${comment.trim()}`, { blockerReason: comment.trim() })}><CirclePause size={16} /> В ожидание</button>}
              {selected.status === 'in_progress' && <button type="button" className="button button--primary" onClick={() => changeStatus(selected, selected.reviewerId ? 'review' : 'done', selected.reviewerId ? 'Результат отправлен на проверку' : 'Задача выполнена', selected.reviewerId ? {} : { completionNote: completionNote.trim() || 'Выполнено ответственным' })}><ShieldCheck size={16} /> {selected.reviewerId ? 'На проверку' : 'Выполнить'}</button>}
              {selected.status === 'waiting' && <button type="button" className="button button--primary" onClick={() => changeStatus(selected, 'in_progress', 'Работа по задаче возобновлена', { blockerReason: undefined })}><Play size={16} /> Возобновить</button>}
              {selected.status === 'review' && <button type="button" className="button button--secondary" onClick={() => changeStatus(selected, 'in_progress', 'Задача возвращена в работу')}><RotateCcw size={16} /> Вернуть в работу</button>}
              {selected.status === 'done' && role === 'management' && <button type="button" className="button button--secondary" onClick={() => changeStatus(selected, 'in_progress', 'Задача открыта повторно', { completionNote: undefined })}><RotateCcw size={16} /> Открыть снова</button>}
            </div>

            {selected.status === 'review' && (role === 'management' || !selected.reviewerId) && <div className="task-completion"><Field label="Подтверждённый результат" hint="Без результата задача не считается закрытой"><textarea rows={2} value={completionNote} onChange={(event) => setCompletionNote(event.target.value)} placeholder="Что сделано, принято и где лежит подтверждение" /></Field><button type="button" className="button button--primary" disabled={!completionNote.trim()} onClick={() => changeStatus(selected, 'done', 'Задача принята и выполнена', { completionNote: completionNote.trim() })}><Check size={16} /> Принять и закрыть</button></div>}

            <div className="task-history-layout">
              <section>
                <SectionHeader eyebrow="Аудит" title="История задачи" action={<History size={18} />} />
                <div className="task-history">
                  {selected.history.map((event) => <article key={event.id}><span className={`task-history__marker task-history__marker--${event.kind}`} /> <div><strong>{event.text}</strong><p>{event.actor} · {formatDateTime(event.timestamp)}</p></div></article>)}
                </div>
              </section>
              <section>
                <SectionHeader eyebrow="Команда" title="Комментарий" action={<MessageSquare size={18} />} />
                <form className="task-comment-form" onSubmit={addComment}><textarea rows={4} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Факт, препятствие, договорённость или следующий шаг" /><button type="submit" className="button button--secondary" disabled={!comment.trim()}>Добавить в историю</button></form>
              </section>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
