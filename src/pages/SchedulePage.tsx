import { createScheduleCommands } from '../application';
import { runtimeIdGenerator, systemClock } from '../infrastructure/runtime';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  CircleDot,
  Clock3,
  HardHat,
  Link2,
  ListTodo,
  LockKeyhole,
  PackageSearch,
  Pencil,
  Play,
  RotateCcw,
  Send,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { formatDate, money, paidAmountFor, progressTotals, stageFinanceTotals, stageStatusLabel, uid } from '../domain';
import { addDaysKey, mondayOf, projectWeekNumber, projectWeekRange, stageWeekRange } from '../projectWeek';
import type { AppState, ProjectTask, StageStatus, UserRole } from '../entities/index';
import { Field, Modal, ProgressBar, SectionHeader, StatusBadge } from '../components/Ui';
import { CounterpartyModal } from '../components/CounterpartyModal';

const statusTone = (status: StageStatus): 'neutral' | 'positive' | 'warning' | 'danger' | 'blue' => {
  if (status === 'accepted') return 'positive';
  if (status === 'in_progress' || status === 'awaiting_inspection') return 'blue';
  if (status === 'blocked' || status === 'rework') return 'danger';
  if (status === 'ready') return 'warning';
  return 'neutral';
};

const taskTemplates: Record<string, string[]> = {
  prebuild: ['Проверить границы, оси и отметки участка', 'Подготовить подъезд и временные сети', 'Зафиксировать готовность участка к старту'],
  foundation: ['Выполнить разбивку фундамента', 'Выполнить монтаж фундамента по проекту', 'Проверить отметки и геометрию фундамента'],
  floor: ['Смонтировать нижнюю обвязку', 'Смонтировать перекрытие', 'Проверить плоскость и диагонали перекрытия'],
  sip: ['Смонтировать наружные SIP-стены', 'Смонтировать внутренние стены и несущие узлы', 'Проверить геометрию и проёмы SIP-контура'],
  roof: ['Собрать несущую систему кровли', 'Выполнить гидроизоляцию и кровельное покрытие', 'Проверить примыкания и водоотведение'],
  openings: ['Проверить размеры проёмов', 'Смонтировать окна и входные двери', 'Проверить монтажные швы и работу створок'],
  facade: ['Подготовить защитный контур фасада', 'Выполнить фасадные работы', 'Проверить узлы, примыкания и внешний вид'],
  electric: ['Разметить и проложить кабельные трассы', 'Собрать щит и оконечные точки', 'Провести измерения и проверку электрики'],
  engineering: ['Смонтировать воду и канализацию', 'Смонтировать отопление и вентиляцию', 'Провести опрессовку и испытания инженерных систем'],
  rough: ['Подготовить поверхности и инженерные выводы', 'Выполнить черновые отделочные работы', 'Проверить геометрию и готовность к чистовой отделке'],
  finish: ['Выполнить чистовую отделку поверхностей', 'Установить чистовые элементы и оборудование', 'Провести итоговую проверку отделки'],
  commissioning: ['Проверить работу инженерных систем', 'Составить и закрыть дефектную ведомость', 'Зафиксировать результаты пусконаладки'],
  handover: ['Провести финальный осмотр дома', 'Собрать акты, инструкции и комплект документов', 'Передать объект и зафиксировать итоговую приёмку'],
};

const taskDone = (task: ProjectTask) => ['done', 'canceled'].includes(task.status);

export function SchedulePage({ state, role, actor, focusId, onChange }: { state: AppState; role: UserRole; actor: string; focusId?: string | null; onChange: (next: AppState) => void }) {
  const saveChange = createScheduleCommands(state, actor, systemClock, runtimeIdGenerator, onChange);
  const defaultStage = state.stages.find((stage) => ['in_progress', 'rework', 'awaiting_inspection', 'blocked'].includes(stage.status)) ?? state.stages[0];
  const [selectedId, setSelectedId] = useState(defaultStage?.id ?? '');
  const [counterpartyId, setCounterpartyId] = useState<string | null>(null);
  const [editingDates, setEditingDates] = useState(false);
  const [dateForm, setDateForm] = useState({ planStart: '', planEnd: '', forecastEnd: '', dependencyId: '', responsibleId: '' });
  const selected = state.stages.find((stage) => stage.id === selectedId) ?? defaultStage!;
  useEffect(() => {
    if (focusId && state.stages.some((stage) => stage.id === focusId)) setSelectedId(focusId);
  }, [focusId, state.stages]);
  const selectedCounterparty = state.counterparties.find((item) => item.id === selected.responsibleId)
    ?? state.counterparties.find((item) => item.name.trim().toLocaleLowerCase('ru') === selected.responsible.trim().toLocaleLowerCase('ru'));
  const progress = progressTotals(state);
  const checkpoints = state.checkpoints.filter((item) => item.stageId === selected.id);
  const stageTasks = state.tasks.filter((item) => item.stageId === selected.id);
  const openStageTasks = stageTasks.filter((item) => !taskDone(item));
  const unacceptedCheckpoints = checkpoints.filter((item) => item.status !== 'accepted');
  const stageFinance = state.financeEntries.filter((item) => item.stageId === selected.id);
  const stageProcurement = state.procurement.filter((item) => item.stageId === selected.id);
  const stageDocuments = state.documents.filter((item) => item.stageId === selected.id);
  const stageFinancialTotals = stageFinanceTotals(state, selected.id);
  const selectedWeeks = stageWeekRange(state.project.startDate, selected.planStart, selected.planEnd);
  const todayKey = new Date().toISOString().slice(0, 10);
  const currentWeek = projectWeekRange(state.project.startDate, todayKey);
  const projectStarted = todayKey >= state.project.startDate;

  const gantt = useMemo(() => {
    const parse = (value: string) => new Date(`${value}T12:00:00Z`).getTime();
    const dates = state.stages.flatMap((stage) => [stage.planStart, stage.planEnd, stage.forecastEnd]).filter(Boolean).map(parse).filter(Number.isFinite);
    const projectStart = parse(state.project.startDate);
    const projectEnd = parse(state.project.targetDate);
    const minTime = Math.min(...dates, projectStart);
    const maxTime = Math.max(...dates, projectEnd);
    const dayMs = 86_400_000;
    const minKey = new Date(minTime).toISOString().slice(0, 10);
    const maxKey = new Date(maxTime).toISOString().slice(0, 10);
    const startKey = addDaysKey(mondayOf(minKey), -7);
    const endKey = addDaysKey(mondayOf(maxKey), 13);
    const startTime = parse(startKey);
    const endTime = parse(endKey);
    const totalDays = Math.max(28, Math.ceil((endTime - startTime) / dayMs) + 1);
    const dayWidth = totalDays > 210 ? 7 : totalDays > 140 ? 10 : totalDays > 90 ? 14 : 22;
    const offset = (value: string) => Math.max(0, Math.round((parse(value) - startTime) / dayMs));
    const width = Math.max(1, totalDays * dayWidth);
    const ticks = Array.from({ length: Math.ceil(totalDays / 7) }, (_, index) => {
      const date = addDaysKey(startKey, index * 7);
      const week = projectWeekNumber(state.project.startDate, date);
      return {
        left: index * 7 * dayWidth,
        date,
        week,
        label: new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(new Date(`${date}T12:00:00Z`)),
      };
    });
    const todayOffset = Math.round((parse(todayKey) - startTime) / dayMs);
    const currentWeekOffset = Math.round((parse(currentWeek.start) - startTime) / dayMs);
    return { dayMs, dayWidth, offset, totalDays, width, ticks, todayOffset, currentWeekOffset };
  }, [currentWeek.start, state.project.startDate, state.project.targetDate, state.stages, todayKey]);

  const openDateEdit = () => {
    const dependencyStage = state.stages.find((stage) => stage.id === selected.dependencyId)
      ?? state.stages.find((stage) => stage.name === selected.dependency || stage.shortName === selected.dependency);
    setDateForm({ planStart: selected.planStart, planEnd: selected.planEnd, forecastEnd: selected.forecastEnd, dependencyId: dependencyStage?.id ?? '', responsibleId: selected.responsibleId ?? '' });
    setEditingDates(true);
  };

  const saveDates = (event: FormEvent) => {
    event.preventDefault();
    if (!dateForm.planStart || dateForm.planEnd < dateForm.planStart || dateForm.forecastEnd < dateForm.planStart) return;
    const dependency = state.stages.find((stage) => stage.id === dateForm.dependencyId);
    const responsible = state.counterparties.find((item) => item.id === dateForm.responsibleId);
    saveChange({
      ...state,
      stages: state.stages.map((stage) => stage.id === selected.id ? {
        ...stage,
        planStart: dateForm.planStart,
        planEnd: dateForm.planEnd,
        forecastEnd: dateForm.forecastEnd,
        dependencyId: dependency?.id,
        dependency: dependency?.name,
        responsibleId: responsible?.id,
        responsible: responsible?.name ?? 'Не назначен',
      } : stage),
      activity: [{ id: uid('activity'), timestamp: new Date().toISOString(), actor, text: `Обновлён график этапа «${selected.name}»`, tone: dateForm.forecastEnd > dateForm.planEnd ? 'warning' : 'neutral' }, ...state.activity],
    });
    setEditingDates(false);
  };

  const buildTasksForStage = () => {
    if (stageTasks.length) return state.tasks;
    const assignee = state.settings.users.find((user) => user.role === 'foreman' && user.status === 'active')
      ?? state.settings.users.find((user) => user.role === 'management' && user.status === 'active');
    const createdAt = new Date().toISOString();
    const titles = taskTemplates[selected.id] ?? [`Выполнить работы этапа «${selected.name}»`, `Проверить и подготовить этап «${selected.name}» к приёмке`];
    const created = titles.map((title, index): ProjectTask => ({
      id: uid('task'),
      title,
      description: `Автоматическая задача этапа «${selected.name}». Результат должен быть подтверждён до передачи этапа на проверку.`,
      status: 'todo',
      priority: index === titles.length - 1 ? 'high' : 'normal',
      assigneeId: assignee?.id ?? 'user-owner',
      assigneeName: assignee?.name ?? actor,
      createdBy: 'ИКИОМА ОС',
      createdAt,
      updatedAt: createdAt,
      dueDate: selected.planEnd,
      originalDueDate: selected.planEnd,
      stageId: selected.id,
      rescheduleCount: 0,
      history: [{ id: uid('history'), timestamp: createdAt, actor: 'ИКИОМА ОС', kind: 'created', text: `Создана автоматически при старте этапа «${selected.name}»` }],
    }));
    return [...created, ...state.tasks];
  };

  const moveStage = (status: StageStatus, progressValue: number, text: string) => {
    const acceptedIndex = state.stages.findIndex((stage) => stage.id === selected.id);
    const nextStages = state.stages.map((stage, index) => {
      if (stage.id === selected.id) return { ...stage, status, progress: progressValue, actualEnd: status === 'accepted' ? new Date().toISOString().slice(0, 10) : stage.actualEnd, blocker: status === 'accepted' ? undefined : stage.blocker };
      if (status === 'accepted' && index === acceptedIndex + 1 && stage.status === 'not_ready') return { ...stage, status: 'ready' as StageStatus };
      return stage;
    });
    saveChange({
      ...state,
      stages: nextStages,
      tasks: status === 'in_progress' && selected.status === 'ready' ? buildTasksForStage() : state.tasks,
      activity: [{ id: uid('activity'), timestamp: new Date().toISOString(), actor, text, tone: status === 'rework' || status === 'blocked' ? 'warning' : status === 'accepted' ? 'positive' : 'neutral' }, ...state.activity],
    });
  };

  const clearBlocker = () => {
    saveChange({
      ...state,
      stages: state.stages.map((stage) => stage.id === selected.id ? { ...stage, blocker: undefined } : stage),
      activity: [{ id: uid('activity'), timestamp: new Date().toISOString(), actor, text: `Устранено препятствие: ${selected.shortName}`, tone: 'positive' }, ...state.activity],
    });
  };

  const renderActions = () => {
    if (role === 'client' || selected.status === 'accepted' || selected.status === 'not_ready') return null;
    if (selected.status === 'ready') return <button className="button button--primary" type="button" onClick={() => moveStage('in_progress', 5, `Начат этап «${selected.name}»`)}><Play size={17} /> Начать этап</button>;
    if (selected.status === 'in_progress' || selected.status === 'rework') return (
      <button className="button button--primary" disabled={Boolean(selected.blocker) || openStageTasks.length > 0} type="button" onClick={() => moveStage('awaiting_inspection', 90, `Этап «${selected.name}» отправлен на проверку`)}><Send size={17} /> Отправить на проверку</button>
    );
    if (selected.status === 'blocked') return <button className="button button--primary" type="button" onClick={() => moveStage('in_progress', Math.max(selected.progress, 10), `Работы по этапу «${selected.name}» возобновлены`)}><Play size={17} /> Возобновить</button>;
    if (selected.status === 'awaiting_inspection' && role === 'management') return (
      <div className="action-pair"><button className="button button--danger-soft" type="button" onClick={() => moveStage('rework', 75, `Этап «${selected.name}» возвращён на доработку`)}><RotateCcw size={17} /> На доработку</button><button className="button button--primary" disabled={openStageTasks.length > 0 || unacceptedCheckpoints.length > 0} type="button" onClick={() => moveStage('accepted', 100, `Этап «${selected.name}» принят`)}><Check size={17} /> Принять этап</button></div>
    );
    return null;
  };

  return (
    <div className="page-stack">
      <section className="page-title-row">
        <div>
          <span className="eyebrow">Производственный план · 13 этапов</span>
          <h1>График и готовность работ</h1>
          <p>{projectStarted && currentWeek.number > 0 ? `Сейчас идёт ${currentWeek.number}-я неделя проекта · ${formatDate(currentWeek.start)} — ${formatDate(currentWeek.end)}` : `Проект ещё не начался · старт ${formatDate(state.project.startDate, true)}`}</p>
        </div>
        <div className="schedule-summary">
          <span><strong>{progress.physical}%</strong> физически</span>
          <ArrowRight size={18} />
          <span><strong>{progress.accepted}%</strong> принято</span>
        </div>
      </section>

      <section className="panel gantt-panel">
        <SectionHeader eyebrow="Диаграмма Ганта · недели с понедельника" title="Начало, окончание и последовательность" action={<div className="gantt-legend"><span><i className="gantt-legend__plan" /> план</span><span><i className="gantt-legend__forecast" /> прогноз</span><span><i className="gantt-legend__today" /> сегодня</span></div>} />
        <div className="gantt-scroll">
          <div className="gantt-chart" style={{ width: `${250 + gantt.width}px` }}>
            <div className="gantt-header">
              <div className="gantt-header__label">Этап / последовательность</div>
              <div className="gantt-header__timeline" style={{ width: `${gantt.width}px`, backgroundSize: `${gantt.dayWidth * 7}px 100%` }}>
                {projectStarted && gantt.currentWeekOffset >= 0 && gantt.currentWeekOffset <= gantt.totalDays && <i aria-hidden="true" style={{ position: 'absolute', left: `${gantt.currentWeekOffset * gantt.dayWidth}px`, top: 0, bottom: 0, width: `${gantt.dayWidth * 7}px`, background: 'rgba(42, 113, 82, .07)', pointerEvents: 'none' }} />}
                {gantt.ticks.map((tick) => <span key={tick.left} style={{ left: `${tick.left}px`, fontWeight: tick.date === currentWeek.start ? 800 : undefined }}>{tick.week > 0 ? `Нед. ${tick.week} · ` : ''}{tick.label}</span>)}
              </div>
            </div>
            {state.stages.map((stage) => {
              const left = gantt.offset(stage.planStart) * gantt.dayWidth;
              const planDays = Math.max(1, gantt.offset(stage.planEnd) - gantt.offset(stage.planStart) + 1);
              const forecastDays = Math.max(planDays, gantt.offset(stage.forecastEnd) - gantt.offset(stage.planStart) + 1);
              return (
                <button type="button" className={stage.id === selected.id ? 'gantt-row gantt-row--selected' : 'gantt-row'} key={stage.id} onClick={() => setSelectedId(stage.id)}>
                  <span className="gantt-row__label"><i>{String(stage.order).padStart(2, '0')}</i><span><strong>{stage.shortName}</strong><small>{stage.dependency ? `после: ${stage.dependency}` : 'начало цепочки'}</small></span></span>
                  <span className="gantt-row__timeline" style={{ width: `${gantt.width}px`, backgroundSize: `${gantt.dayWidth * 7}px 100%` }}>
                    {projectStarted && gantt.currentWeekOffset >= 0 && gantt.currentWeekOffset <= gantt.totalDays && <i aria-hidden="true" style={{ position: 'absolute', left: `${gantt.currentWeekOffset * gantt.dayWidth}px`, top: 0, bottom: 0, width: `${gantt.dayWidth * 7}px`, background: 'rgba(42, 113, 82, .045)', pointerEvents: 'none' }} />}
                    {gantt.todayOffset >= 0 && gantt.todayOffset <= gantt.totalDays && <i className="gantt-today-line" style={{ left: `${gantt.todayOffset * gantt.dayWidth}px` }} />}
                    {forecastDays > planDays && <i className="gantt-forecast-bar" style={{ left: `${left}px`, width: `${forecastDays * gantt.dayWidth}px` }} />}
                    <i className={`gantt-plan-bar gantt-plan-bar--${stage.status}`} style={{ left: `${left}px`, width: `${planDays * gantt.dayWidth}px` }}><span>{stage.progress}%</span></i>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <p className="gantt-hint">Каждая крупная отсечка — понедельник. Подсвечена текущая неделя проекта, отдельная линия показывает сегодняшний день.</p>
      </section>

      <section className="schedule-layout">
        <article className="panel stage-list-panel">
          <SectionHeader eyebrow="План / факт" title="Этапы дома" />
          <div className="stage-list">
            {state.stages.map((stage, index) => {
              const weeks = stageWeekRange(state.project.startDate, stage.planStart, stage.planEnd);
              return (
              <button type="button" className={`stage-row ${stage.id === selected.id ? 'stage-row--selected' : ''}`} key={stage.id} onClick={() => setSelectedId(stage.id)}>
                <span className={`stage-row__marker stage-row__marker--${stage.status}`}>{stage.status === 'accepted' ? <Check size={15} /> : stage.order}</span>
                <span className="stage-row__line" aria-hidden="true" />
                <span className="stage-row__body">
                  <span className="stage-row__title"><strong>{stage.name}</strong><StatusBadge label={stageStatusLabel[stage.status]} tone={statusTone(stage.status)} /></span>
                  <span className="stage-row__dates">{formatDate(stage.planStart)} — {formatDate(stage.planEnd)}<i>Нед. {weeks.start}{weeks.end !== weeks.start ? `–${weeks.end}` : ''} · прогноз {formatDate(stage.forecastEnd)}</i></span>
                  {(stage.progress > 0 || stage.status === 'accepted') && <ProgressBar value={stage.progress} tone={stage.status === 'rework' ? 'red' : 'green'} />}
                </span>
                <ChevronRight className="stage-row__chevron" size={17} />
                {index === state.stages.length - 1 && <span className="stage-row__line-end" />}
              </button>
            );})}
          </div>
        </article>

        <aside className="stage-detail-column">
          <article className="panel stage-detail">
            <div className="stage-detail__head">
              <span className="stage-detail__number">Этап {String(selected.order).padStart(2, '0')} · нед. {selectedWeeks.start}{selectedWeeks.end !== selectedWeeks.start ? `–${selectedWeeks.end}` : ''}</span>
              <StatusBadge label={stageStatusLabel[selected.status]} tone={statusTone(selected.status)} />
            </div>
            <h2>{selected.name}</h2>
            <div className="stage-detail__progress"><ProgressBar value={selected.progress} tone={selected.status === 'rework' ? 'red' : 'green'} /><strong>{selected.progress}%</strong></div>
            <div className="stage-facts">
              <div><CalendarDays size={18} /><span><small>План</small><strong>{formatDate(selected.planStart)} — {formatDate(selected.planEnd)}</strong></span></div>
              <div><Clock3 size={18} /><span><small>Прогноз окончания</small><strong>{formatDate(selected.forecastEnd, true)}</strong></span></div>
              <div><UserRound size={18} /><span><small>Ответственный</small>{selectedCounterparty ? <button type="button" className="entity-link entity-link--compact" onClick={() => setCounterpartyId(selectedCounterparty.id)}>{selected.responsible}</button> : <strong>{selected.responsible}</strong>}</span></div>
              <div><CircleDot size={18} /><span><small>Вес в готовности</small><strong>{selected.weight}% проекта</strong></span></div>
            </div>
            {selected.dependency && <div className="dependency-note"><Link2 size={18} /><span><small>Зависимость</small><strong>{selected.dependency}</strong></span></div>}
            {selected.blocker && (
              <div className="blocker-note">
                <AlertTriangle size={19} />
                <div><strong>Есть препятствие</strong><p>{selected.blocker}</p>{role !== 'client' && <button type="button" className="text-button text-button--danger" onClick={clearBlocker}>Отметить устранённым</button>}</div>
              </div>
            )}
            {(openStageTasks.length > 0 || unacceptedCheckpoints.length > 0) && selected.status !== 'not_ready' && selected.status !== 'ready' && <div className="blocker-note"><LockKeyhole size={19} /><div><strong>Этап ещё нельзя закрыть</strong><p>{[openStageTasks.length ? `${openStageTasks.length} задач не завершено` : '', unacceptedCheckpoints.length ? `${unacceptedCheckpoints.length} контрольных точек не принято` : ''].filter(Boolean).join(' · ')}</p></div></div>}
            <div className="stage-detail__actions">{renderActions()}</div>
            {role === 'management' && <button type="button" className="button button--secondary stage-date-edit" onClick={openDateEdit}><Pencil size={16} /> Изменить даты и зависимость</button>}
          </article>

          <article className="panel stage-gates">
            <SectionHeader eyebrow="Работа этапа" title="Подэтапы и задачи" action={<span className="count-badge">{stageTasks.filter(taskDone).length}/{stageTasks.length}</span>} />
            {stageTasks.length ? <div className="gate-list">{stageTasks.map((task) => <div key={task.id}><span className={`gate-list__icon gate-list__icon--${taskDone(task) ? 'accepted' : task.status === 'waiting' ? 'rework' : 'pending'}`}>{taskDone(task) ? <CheckCircle2 size={17} /> : <ListTodo size={17} />}</span><span><strong>{task.title}</strong><small>{task.assigneeName} · срок {formatDate(task.dueDate, true)} · {taskDone(task) ? 'выполнено' : task.status === 'in_progress' ? 'в работе' : task.status === 'review' ? 'на проверке' : task.status === 'waiting' ? 'есть препятствие' : 'запланировано'}</small></span></div>)}</div> : <div className="locked-gate"><ListTodo size={22} /><p>При запуске этапа ИКИОМА ОС автоматически создаст типовые задачи и привяжет их к этому этапу.</p></div>}
          </article>

          <article className="panel stage-gates">
            <SectionHeader eyebrow="Экономика этапа" title="План, обязательства и факт" action={<CircleDollarSign size={19} />} />
            <div className="stage-facts">
              <div><CircleDollarSign size={18} /><span><small>План затрат</small><strong>{money(stageFinancialTotals.plan)}</strong></span></div>
              <div><Clock3 size={18} /><span><small>Прогноз затрат</small><strong>{money(stageFinancialTotals.forecast)}</strong></span></div>
              <div><ListTodo size={18} /><span><small>Обязательства</small><strong>{money(stageFinancialTotals.committed)}</strong></span></div>
              <div><CheckCircle2 size={18} /><span><small>Принято / оплачено</small><strong>{money(stageFinancialTotals.accepted)} / {money(stageFinancialTotals.paid)}</strong></span></div>
            </div>
            {(stageFinancialTotals.billed > 0 || stageFinancialTotals.received > 0) && <div className="dependency-note"><CircleDollarSign size={18} /><span><small>Доход по этапу</small><strong>{money(stageFinancialTotals.billed)} начислено · {money(stageFinancialTotals.received)} получено</strong></span></div>}
            {stageFinance.length ? <div className="gate-list">{stageFinance.slice(0, 5).map((item) => <div key={item.id}><span className={`gate-list__icon gate-list__icon--${item.status === 'paid' ? 'accepted' : 'pending'}`}><CircleDollarSign size={17} /></span><span><strong>{item.description}</strong><small>{item.kind === 'income' ? 'Доход' : 'Расход'} · {money(item.amount)} · оплачено {money(paidAmountFor(item))}</small></span></div>)}</div> : <div className="locked-gate"><CircleDollarSign size={22} /><p>Финансовые операции этапа появятся здесь после создания обязательств или платежей.</p></div>}
          </article>

          <article className="panel stage-gates">
            <SectionHeader eyebrow="Готовность ресурсов" title="Снабжение и документы" action={<span className="count-badge">{stageProcurement.length + stageDocuments.length}</span>} />
            <div className="gate-list">
              {stageProcurement.slice(0, 4).map((item) => <div key={item.id}><span className={`gate-list__icon gate-list__icon--${['accepted', 'issued'].includes(item.status) ? 'accepted' : item.risk ? 'rework' : 'pending'}`}><PackageSearch size={17} /></span><span><strong>{item.item}</strong><small>Нужно к {formatDate(item.neededBy, true)} · {item.risk ? `риск: ${item.risk}` : item.status}</small></span></div>)}
              {stageDocuments.slice(0, 4).map((item) => <div key={item.id}><span className={`gate-list__icon gate-list__icon--${item.status === 'signed' ? 'accepted' : 'pending'}`}><ShieldCheck size={17} /></span><span><strong>{item.name}</strong><small>{item.type} · {item.status === 'signed' ? 'подписан' : 'актуальный'}</small></span></div>)}
              {!stageProcurement.length && !stageDocuments.length && <div className="locked-gate"><PackageSearch size={22} /><p>Связанные закупки и документы появятся здесь автоматически по `stageId`.</p></div>}
            </div>
          </article>

          <article className="panel stage-gates">
            <SectionHeader eyebrow="Условия закрытия" title="Контрольные точки" action={<span className="count-badge">{checkpoints.length}</span>} />
            {checkpoints.length ? (
              <div className="gate-list">
                {checkpoints.map((item) => (
                  <div key={item.id}>
                    <span className={`gate-list__icon gate-list__icon--${item.status}`}>{item.status === 'accepted' ? <CheckCircle2 size={17} /> : item.status === 'rework' ? <AlertTriangle size={17} /> : <ShieldCheck size={17} />}</span>
                    <span><strong>{item.title}</strong><small>{item.zone} · {item.photos.length}/{item.requiredShots.length} фото</small></span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="locked-gate"><LockKeyhole size={22} /><p>Контрольные точки будут созданы из шаблона перед началом этапа.</p></div>
            )}
          </article>

          <article className="process-rule-card">
            <HardHat size={20} />
            <div><strong>Этап — единая точка управления</strong><p>Сроки, задачи, снабжение, документы, контроль качества и деньги собираются по одному `stageId`. Закрыть этап с незавершёнными задачами или непринятыми контрольными точками нельзя.</p></div>
          </article>
        </aside>
      </section>
      {counterpartyId && <CounterpartyModal state={state} counterpartyId={counterpartyId} onClose={() => setCounterpartyId(null)} />}
      {editingDates && <Modal title={`График: ${selected.shortName}`} subtitle="План фиксирует базовый срок, прогноз показывает текущую ожидаемую дату." onClose={() => setEditingDates(false)}><form className="modal-form" onSubmit={saveDates}><div className="form-grid"><Field label="Начало"><input required type="date" value={dateForm.planStart} onChange={(event) => setDateForm({ ...dateForm, planStart: event.target.value })} /></Field><Field label="Плановое окончание"><input required type="date" min={dateForm.planStart} value={dateForm.planEnd} onChange={(event) => setDateForm({ ...dateForm, planEnd: event.target.value })} /></Field><Field label="Прогноз окончания"><input required type="date" min={dateForm.planStart} value={dateForm.forecastEnd} onChange={(event) => setDateForm({ ...dateForm, forecastEnd: event.target.value })} /></Field><Field label="Предшествующий этап"><select value={dateForm.dependencyId} onChange={(event) => setDateForm({ ...dateForm, dependencyId: event.target.value })}><option value="">Нет зависимости</option>{state.stages.filter((stage) => stage.id !== selected.id && stage.order < selected.order).map((stage) => <option value={stage.id} key={stage.id}>{stage.order}. {stage.name}</option>)}</select></Field><Field label="Подрядчик / ответственный"><select value={dateForm.responsibleId} onChange={(event) => setDateForm({ ...dateForm, responsibleId: event.target.value })}><option value="">Не назначен</option>{state.counterparties.filter((item) => ['contractor', 'service'].includes(item.type) && item.status !== 'blocked').map((item) => <option value={item.id} key={item.id}>{item.name}{item.specialty ? ` · ${item.specialty}` : ''}</option>)}</select></Field></div><div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setEditingDates(false)}>Отмена</button><button type="submit" className="button button--primary">Сохранить график</button></div></form></Modal>}
    </div>
  );
}