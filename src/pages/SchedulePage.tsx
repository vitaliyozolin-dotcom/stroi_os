import { BaselinePanel, planShiftLabel } from '../components/BaselinePanel';
import { StageControlModal } from '../components/StageControlModal';
import { SiteProgress } from '../components/SiteProgress';
import { ScheduleReconciliation } from '../components/ScheduleReconciliation';
import { automaticSchedule } from '../../sites/lib/automatic-schedule.js';
import { useScheduleToday } from '../components/ProjectScheduleDates';
import type { StageAction } from '../application/stage-control';
import { planDays as baselineDays } from '../../sites/lib/plan-baseline.js';
import { planToday } from '../../sites/lib/plan-baseline.js';
import { createScheduleCommands } from '../application';
import { runtimeIdGenerator, systemClock, uid } from '../infrastructure/runtime';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  AlertTriangle,
  CalendarDays,
  Check,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
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
  X,
} from 'lucide-react';
import { paidAmountFor, projectProgressTotals as progressTotals, stageFinanceTotals } from '../domain/index';
import { formatDate, money } from '../presentation/formatting';
import { stageStatusLabel } from '../presentation/status-labels';
import { projectWeekRange } from '../projectWeek';
import { ScheduleTimeline, scheduleStageTitle, scheduleDisplayRow } from '../components/ScheduleTimeline';
import './schedule-page.css';
import type { AppState, ProjectTask, StageStatus, UserRole } from '../entities/index';
import { EmptyState, Field, Modal, ProgressBar, StatusBadge } from '../components/Ui';
import { CounterpartyModal } from '../components/CounterpartyModal';

const statusTone = (status: StageStatus): 'neutral' | 'positive' | 'warning' | 'danger' | 'blue' => {
  if (status === 'accepted') return 'positive';
  if (status === 'in_progress' || status === 'awaiting_inspection') return 'blue';
  if (status === 'blocked' || status === 'rework') return 'danger';
  if (status === 'ready') return 'warning';
  return 'neutral';
};

const taskDone = (task: ProjectTask) => ['done', 'canceled'].includes(task.status);

type SchedulePageProps = { state: AppState; role: UserRole; actor: string; userId?: string; focusId?: string | null; onChange: (next: AppState) => void };

export function SchedulePage(props: SchedulePageProps) {
  if (!props.state.stages.length) return <div className="page-stack"><BaselinePanel state={props.state} role={props.role} actor={props.actor} onChange={props.onChange} /><EmptyState icon={CalendarDays} title="График пока не составлен" text="После добавления этапов здесь появятся исходные и действующие сроки." /></div>;
  return <ScheduleWithStages key={props.state.project.id} {...props} />;
}

function ScheduleWithStages({ state, role, actor, userId, focusId, onChange }: SchedulePageProps) {
  const saveChange = createScheduleCommands(state, actor, systemClock, runtimeIdGenerator, onChange);
  const defaultStage = state.stages.find((stage) => ['in_progress', 'rework', 'awaiting_inspection', 'blocked'].includes(stage.status)) ?? state.stages.find((stage) => stage.status !== 'accepted') ?? state.stages[0];
  const [selectedId, setSelectedId] = useState(defaultStage?.id ?? '');
  const [detailOpen, setDetailOpen] = useState(false);
  const [counterpartyId, setCounterpartyId] = useState<string | null>(null);
  const [editingDates, setEditingDates] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [stageAction, setStageAction] = useState<StageAction | null>(null);
  const [dateError, setDateError] = useState('');
  const [dateForm, setDateForm] = useState({ planStart: '', planEnd: '', forecastEnd: '', dependencyId: '', responsibleId: '', reason: '' });
  const selected = state.stages.find((stage) => stage.id === selectedId) ?? defaultStage!;
  const todayKey = useScheduleToday();
  const forecast = useMemo(() => automaticSchedule(state, todayKey), [state, todayKey]);
  const calculated = scheduleDisplayRow(selected, forecast);
  const handledFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!focusId) { handledFocus.current = null; return; }
    if (handledFocus.current !== focusId && state.stages.some((stage) => stage.id === focusId)) { handledFocus.current = focusId; setSelectedId(focusId); setDetailOpen(true); }
  }, [focusId, state.stages]);
  const selectedCounterparty = state.counterparties.find((item) => item.id === selected.responsibleId)
    ?? state.counterparties.find((item) => item.name.trim().toLocaleLowerCase('ru') === selected.responsible.trim().toLocaleLowerCase('ru'));
  const progress = progressTotals(state);
  const checkpoints = state.checkpoints.filter((item) => item.stageId === selected.id);
  const stageTasks = state.tasks.filter((item) => item.stageId === selected.id);
  const openStageTasks = stageTasks.filter((item) => item.id !== `auto-stage-${selected.id}` && !taskDone(item));
  const unacceptedCheckpoints = checkpoints.filter((item) => item.status !== 'accepted');
  const stageFinance = state.financeEntries.filter((item) => item.stageId === selected.id);
  const stageProcurement = state.procurement.filter((item) => item.stageId === selected.id);
  const stageDocuments = state.documents.filter((item) => item.stageId === selected.id);
  const stageFinancialTotals = stageFinanceTotals(state, selected.id);
  const currentWeek = projectWeekRange(state.project.startDate, todayKey);
  const projectStarted = todayKey >= state.project.startDate;

  const openStage = (id: string) => { setSelectedId(id); setDetailOpen(true); };

  const openDateEdit = () => {
    const dependencyStage = state.stages.find((stage) => stage.id === selected.dependencyId)
      ?? state.stages.find((stage) => stage.name === selected.dependency || stage.shortName === selected.dependency);
    setDateForm({ planStart: selected.planStart, planEnd: selected.planEnd, forecastEnd: selected.forecastEnd, dependencyId: dependencyStage?.id ?? '', responsibleId: selected.responsibleId ?? '', reason: '' });
    setDateError('');
    setEditingDates(true);
  };

  const saveDates = (event: FormEvent) => {
    event.preventDefault();
    if (!dateForm.planStart || dateForm.planEnd < dateForm.planStart || dateForm.forecastEnd < dateForm.planStart) return;
    if ((dateForm.planStart !== selected.planStart || dateForm.planEnd !== selected.planEnd || dateForm.forecastEnd !== selected.forecastEnd) && !dateForm.reason.trim()) { setDateError('Укажите причину изменения срока.'); return; }
    const dependency = state.stages.find((stage) => stage.id === dateForm.dependencyId);
    const responsible = state.counterparties.find((item) => item.id === dateForm.responsibleId);
    saveChange({
      ...state,
      stages: state.stages.map((stage) => stage.id === selected.id ? {
        ...stage,
        planChangeReason: dateForm.reason.trim(),
        forecastReason: dateForm.reason.trim(),
        planStart: dateForm.planStart,
        planEnd: dateForm.planEnd,
        forecastEnd: dateForm.forecastEnd,
        dependencyId: stage.schedule ? stage.dependencyId : dependency?.id,
        dependency: stage.schedule ? stage.dependency : dependency?.name,
        responsibleId: responsible?.id,
        responsible: responsible?.name ?? 'Не назначен',
      } : stage),
      activity: [{ id: uid('activity'), timestamp: new Date().toISOString(), actor, text: `Обновлён график этапа «${selected.name}»`, tone: dateForm.forecastEnd > dateForm.planEnd ? 'warning' : 'neutral' }, ...state.activity],
    });
    setEditingDates(false);
  };

  const moveStage = (status: StageStatus, _progressValue: number, _text: string) => {
    setStageAction(status === 'in_progress' ? 'start' : status === 'accepted' ? 'accept' : status === 'rework' ? 'rework' : 'complete');
  };

  const clearBlocker = () => setStageAction('start');

  const renderActions = () => {
    if (role === 'client' || selected.status === 'accepted' || role !== 'management' && selected.schedule && selected.schedule.reporterId !== userId) return null;
    if (role === 'management' && userId === 'owner' && selected.schedule?.kind !== 'summary') return <div className="action-pair"><button className="button button--secondary" type="button" onClick={() => setStageAction(selected.status === 'awaiting_inspection' ? 'rework' : 'start')}>{selected.status === 'awaiting_inspection' ? 'На доработку' : 'В работе'}</button><button className="button button--primary" type="button" onClick={() => setStageAction('owner_accept')}><Check size={17} /> Готово</button></div>;
    if (selected.status === 'ready' || selected.status === 'not_ready') return <button className="button button--primary" type="button" onClick={() => setStageAction('start')}><Play size={17} /> Зафиксировать начало</button>;
    if (selected.status === 'in_progress' || selected.status === 'rework') return (
      <button className="button button--primary" type="button" onClick={() => setStageAction('complete')}><Send size={17} /> Зафиксировать выполнение</button>
    );
    if (selected.status === 'blocked') return <button className="button button--primary" type="button" onClick={() => moveStage('in_progress', Math.max(selected.progress, 10), `Работы по этапу «${selected.name}» возобновлены`)}><Play size={17} /> Возобновить</button>;
    if (selected.status === 'awaiting_inspection' && role === 'management') return (
      <div className="action-pair"><button className="button button--danger-soft" type="button" onClick={() => moveStage('rework', 75, `Этап «${selected.name}» возвращён на доработку`)}><RotateCcw size={17} /> На доработку</button><button className="button button--primary" type="button" onClick={() => moveStage('accepted', 100, `Этап «${selected.name}» принят`)}><Check size={17} /> Принять этап</button></div>
    );
    return null;
  };

  return (
    <div className="page-stack schedule-workspace">
      {stageAction && <StageControlModal state={state} stageId={selected.id} action={stageAction} role={role} actor={actor} userId={userId} onChange={saveChange} onClose={() => setStageAction(null)} />}
      {reviewing && <ScheduleReconciliation state={state} role={role} actor={actor} userId={userId} initialId={selected.id} onChange={saveChange} onClose={() => setReviewing(false)} />}
      <section className="schedule-heading">
        <div><span className="eyebrow">Производственный план</span><h1>Этапы и график</h1><p>{projectStarted && currentWeek.number > 0 ? `${currentWeek.number}-я неделя · ${formatDate(currentWeek.start)} — ${formatDate(currentWeek.end)}` : `Начало проекта · ${formatDate(state.project.startDate, true)}`}</p></div>
        <div className="schedule-heading__progress"><strong>{progress.physical}%</strong><span>выполнение ППР</span></div>
      </section>
      <section className="schedule-workspace-brief" aria-label="Основные сроки ППР">
        <div><span>Исходный ППР</span><strong>{forecast.baselineEnd ? formatDate(forecast.baselineEnd, true) : 'Не указан'}</strong></div>
        <div><span>{forecast.kind === 'actual' ? 'ППР выполнен' : forecast.kind === 'observed' ? 'Подтверждено к дате' : 'Прогноз по ППР'}</span><strong>{forecast.end ? formatDate(forecast.end, true) : 'Нужны сроки'}</strong><small>{forecast.kind === 'estimated' ? 'Предварительный' : forecast.kind === 'observed' ? 'Точная дата неизвестна' : forecast.kind === 'confirmed' ? 'По уточнённым остаткам' : ''}</small></div>
        <div><span>{['actual', 'observed'].includes(forecast.kind) ? 'Отклонение от ППР' : 'Прогноз отклонения'}</span><strong>{forecast.kind === 'observed' || forecast.baselineShift === null ? '—' : `${forecast.baselineShift > 0 ? '+' : ''}${forecast.baselineShift} дн.`}</strong></div>
        <div><span>Сдача по договору</span><strong>{state.project.targetDate ? formatDate(state.project.targetDate, true) : 'Не указана'}</strong></div>
      </section>
      {forecast.unmappedWork.length > 0 && <div className="schedule-scope" role="note"><AlertTriangle size={18} /><div><strong>Прогноз сдачи дома пока неполный</strong><p>В сроки ППР ещё не включены: {forecast.unmappedWork.join(', ').toLocaleLowerCase('ru')}.</p></div></div>}
      {!forecast.end && forecast.issues.length > 0 && <div className="schedule-scope" role="note"><AlertTriangle size={18} /><div><strong>Для прогноза нужны уточнения</strong><p>{forecast.issues[0].message}</p></div></div>}
      <ScheduleTimeline state={state} today={todayKey} onSelect={openStage} />
      <details className="schedule-reference"><summary>Исходный план и настройки ППР</summary><div className="schedule-reference__body"><BaselinePanel state={state} role={role} actor={actor} onChange={saveChange} />{role !== 'client' && <button type="button" className="button button--secondary" onClick={() => setReviewing(true)}>Сверить состав работ и зависимости</button>}<details><summary>Как рассчитан прогноз</summary><p>Прогноз учитывает внесённые этапы, их длительность и зависимости. Без свежего остатка используется полная длительность этапа из ППР; дата может сдвигаться с наступлением нового дня.</p>{forecast.notes.map(note => <p key={note}>{note}</p>)}{forecast.issues.map((issue, index) => <p key={index}>{issue.message}</p>)}</details></div></details>
      <details className="schedule-reference"><summary>Состояние объекта и история наблюдений</summary><div className="schedule-reference__body"><SiteProgress state={state} role={role} onChange={onChange} /></div></details>
      {detailOpen && !stageAction && !reviewing && !editingDates && !counterpartyId && <StageDrawer title={scheduleStageTitle(selected)} onClose={() => setDetailOpen(false)}>
          <article className="panel stage-detail">
            <div className="stage-detail__head">
              <span className="stage-detail__number">Этап {selected.order}</span>
              <StatusBadge label={stageStatusLabel[selected.status]} tone={statusTone(selected.status)} />
            </div>
            <div className="stage-detail__progress"><ProgressBar value={selected.progress} tone={selected.status === 'rework' ? 'red' : 'green'} /><strong>{selected.progress}%</strong></div>
            <div className="stage-facts">
              <div><Clock3 size={18} /><span><small>{calculated.basis}</small><strong>{calculated.end ? formatDate(calculated.end, true) : '—'}</strong></span></div>
              <div><UserRound size={18} /><span><small>Ответственный</small>{selectedCounterparty ? <button type="button" className="entity-link entity-link--compact" onClick={() => setCounterpartyId(selectedCounterparty.id)}>{selected.responsible}</button> : <strong>{selected.responsible}</strong>}</span></div>
            </div>
            <details className="stage-disclosure"><summary>Плановые даты и переносы</summary><div className="stage-facts">
              <div><CalendarDays size={18} /><span><small>План 0 этапа</small><strong>{selected.baseline ? `${selected.baseline.start ? formatDate(selected.baseline.start) : '—'} — ${formatDate(selected.baseline.end)}` : 'Не зафиксирован'}</strong></span></div>
              <div><Clock3 size={18} /><span><small>Перенос окончания к Плану 0</small><strong>{planShiftLabel(baselineDays(selected.planEnd, selected.baseline?.end))}</strong></span></div>
              <div><CalendarDays size={18} /><span><small>Действующий план</small><strong>{formatDate(selected.planStart)} — {formatDate(selected.planEnd)}</strong></span></div>
            </div></details>
            {selected.schedule && selected.schedule.dependencies.length > 0 && <div className="dependency-note"><Link2 size={18} /><span><small>Начинается после</small><strong>{selected.schedule.dependencies.map(link => { const previous = state.stages.find(stage => stage.id === link.stageId); return `${previous ? scheduleStageTitle(previous) : 'Неизвестный этап'}${link.lagDays ? ` + ${link.lagDays} дн.` : ''}`; }).join(' · ')}</strong></span></div>}
            {!selected.schedule && selected.dependency && <div className="dependency-note"><Link2 size={18} /><span><small>Зависимость</small><strong>{selected.dependency}</strong></span></div>}
            {selected.blocker && (
              <div className="blocker-note">
                <AlertTriangle size={19} />
                <div><strong>Есть препятствие</strong><p>{selected.blocker}</p>{role !== 'client' && <button type="button" className="text-button text-button--danger" onClick={clearBlocker}>Отметить устранённым</button>}</div>
              </div>
            )}
            {selected.ownerAcceptance && <p className="muted">Принято владельцем: {selected.ownerAcceptance.by || selected.acceptedBy}{selected.ownerAcceptance.at ? ' · ' + formatDate(planToday(new Date(selected.ownerAcceptance.at))) : ''}.{!selected.completedOn && ' Точная дата выполнения неизвестна.'}</p>}
            {(openStageTasks.length > 0 || unacceptedCheckpoints.length > 0) && !['not_ready', 'ready', 'accepted'].includes(selected.status) && !(role === 'management' && userId === 'owner' && selected.schedule?.kind !== 'summary') && <div className="blocker-note"><LockKeyhole size={19} /><div><strong>Этап ещё нельзя закрыть</strong><p>{[openStageTasks.length ? `${openStageTasks.length} задач не завершено` : '', unacceptedCheckpoints.length ? `${unacceptedCheckpoints.length} контрольных точек не принято` : ''].filter(Boolean).join(' · ')}</p></div></div>}
            <div className="stage-detail__actions">{renderActions()}</div>
            {selected.schedule && (role === 'management' || role === 'foreman' && Boolean(userId && selected.schedule.reporterId === userId)) && !['accepted', 'awaiting_inspection'].includes(selected.status) && <button type="button" className="button button--secondary stage-date-edit" onClick={() => setReviewing(true)}>Уточнить остаток и прогноз</button>}
            {role === 'management' && <button type="button" className="button button--secondary stage-date-edit" onClick={openDateEdit}><Pencil size={16} /> Изменить план и оценку срока</button>}
          </article>

          {(stageTasks.length > 0) && <details className="stage-disclosure"><summary>Задачи · {stageTasks.filter(taskDone).length}/{stageTasks.length}</summary><div className="stage-disclosure__body">
            {stageTasks.length ? <div className="gate-list">{stageTasks.map((task) => <div key={task.id}><span className={`gate-list__icon gate-list__icon--${taskDone(task) ? 'accepted' : task.status === 'waiting' ? 'rework' : 'pending'}`}>{taskDone(task) ? <CheckCircle2 size={17} /> : <ListTodo size={17} />}</span><span><strong>{task.title}</strong><small>{task.assigneeName} · срок {formatDate(task.dueDate, true)} · {taskDone(task) ? 'выполнено' : task.status === 'in_progress' ? 'в работе' : task.status === 'review' ? 'на проверке' : task.status === 'waiting' ? 'есть препятствие' : 'запланировано'}</small></span></div>)}</div> : <div className="locked-gate"><ListTodo size={22} /><p>Задачи связываются с этапом в разделе «Задачи». При старте сохраняются существующие контрольные точки.</p></div>}
          </div></details>}

          {(stageFinance.length > 0 || stageFinancialTotals.plan > 0 || stageFinancialTotals.forecast > 0) && <details className="stage-disclosure"><summary>Расходы и бюджет</summary><div className="stage-disclosure__body">
            <div className="stage-facts">
              <div><CircleDollarSign size={18} /><span><small>План затрат</small><strong>{money(stageFinancialTotals.plan)}</strong></span></div>
              <div><Clock3 size={18} /><span><small>Прогноз затрат</small><strong>{money(stageFinancialTotals.forecast)}</strong></span></div>
              <div><ListTodo size={18} /><span><small>Обязательства</small><strong>{money(stageFinancialTotals.committed)}</strong></span></div>
              <div><CheckCircle2 size={18} /><span><small>Принято / оплачено</small><strong>{money(stageFinancialTotals.accepted)} / {money(stageFinancialTotals.paid)}</strong></span></div>
            </div>
            {(stageFinancialTotals.billed > 0 || stageFinancialTotals.received > 0) && <div className="dependency-note"><CircleDollarSign size={18} /><span><small>Доход по этапу</small><strong>{money(stageFinancialTotals.billed)} начислено · {money(stageFinancialTotals.received)} получено</strong></span></div>}
            {stageFinance.length ? <div className="gate-list">{stageFinance.slice(0, 5).map((item) => <div key={item.id}><span className={`gate-list__icon gate-list__icon--${item.status === 'paid' ? 'accepted' : 'pending'}`}><CircleDollarSign size={17} /></span><span><strong>{item.description}</strong><small>{item.kind === 'income' ? 'Доход' : 'Расход'} · {money(item.amount)} · оплачено {money(paidAmountFor(item))}</small></span></div>)}</div> : <div className="locked-gate"><CircleDollarSign size={22} /><p>Финансовые операции этапа появятся здесь после создания обязательств или платежей.</p></div>}
          </div></details>}

          {(stageProcurement.length + stageDocuments.length > 0) && <details className="stage-disclosure"><summary>Снабжение и документы · {stageProcurement.length + stageDocuments.length}</summary><div className="stage-disclosure__body">
            <div className="gate-list">
              {stageProcurement.slice(0, 4).map((item) => <div key={item.id}><span className={`gate-list__icon gate-list__icon--${['accepted', 'issued'].includes(item.status) ? 'accepted' : item.risk ? 'rework' : 'pending'}`}><PackageSearch size={17} /></span><span><strong>{item.item}</strong><small>Нужно к {formatDate(item.neededBy, true)} · {item.risk ? `риск: ${item.risk}` : item.status}</small></span></div>)}
              {stageDocuments.slice(0, 4).map((item) => <div key={item.id}><span className={`gate-list__icon gate-list__icon--${item.status === 'signed' ? 'accepted' : 'pending'}`}><ShieldCheck size={17} /></span><span><strong>{item.name}</strong><small>{item.type} · {item.status === 'signed' ? 'подписан' : 'актуальный'}</small></span></div>)}
              {!stageProcurement.length && !stageDocuments.length && <div className="locked-gate"><PackageSearch size={22} /><p>Связанные закупки и документы появятся здесь автоматически по `stageId`.</p></div>}
            </div>
          </div></details>}

          {(checkpoints.length > 0) && <details className="stage-disclosure"><summary>Контроль качества · {checkpoints.length}</summary><div className="stage-disclosure__body">
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
          </div></details>}

          <details className="stage-disclosure"><summary>Исходная запись и история</summary><div className="stage-disclosure__body"><p>{selected.name}</p>{selected.completionNote && <p>{selected.completionNote}</p>}{selected.planHistory?.slice().reverse().map((entry, index) => <p key={`plan-${index}`}>{entry.before || '—'} → {entry.after || '—'} · {entry.reason}<small>{entry.actor} · {formatDate(entry.at.slice(0, 10))}</small></p>)}{selected.scheduleHistory?.slice().reverse().map((entry, index) => <p key={`site-${index}`}>{entry.note}<small>{entry.actor} · {formatDate(entry.at.slice(0, 10))}</small></p>)}</div></details>
      </StageDrawer>}
      {counterpartyId && <CounterpartyModal state={state} counterpartyId={counterpartyId} onClose={() => setCounterpartyId(null)} />}
      {editingDates && <Modal title={`График: ${selected.shortName}`} subtitle="Действующий план можно перенести с причиной. План 0 остаётся неизменным." onClose={() => setEditingDates(false)}><form className="modal-form" onSubmit={saveDates}>
        <div className="form-grid">
          <Field label="Начало"><input required type="date" value={dateForm.planStart} onChange={(event) => setDateForm({ ...dateForm, planStart: event.target.value })} /></Field>
          <Field label="Плановое окончание"><input required type="date" min={dateForm.planStart} value={dateForm.planEnd} onChange={(event) => setDateForm({ ...dateForm, planEnd: event.target.value })} /></Field>
          <Field label="Ручная оценка окончания (не расчёт)"><input required type="date" min={dateForm.planStart} value={dateForm.forecastEnd} onChange={(event) => setDateForm({ ...dateForm, forecastEnd: event.target.value })} /></Field>
          {!selected.schedule && <Field label="Предшествующий этап"><select value={dateForm.dependencyId} onChange={(event) => setDateForm({ ...dateForm, dependencyId: event.target.value })}><option value="">Нет зависимости</option>{state.stages.filter((stage) => stage.id !== selected.id && stage.order < selected.order).map((stage) => <option value={stage.id} key={stage.id}>{stage.order}. {stage.name}</option>)}</select></Field>}
          <Field label="Подрядчик / ответственный"><select value={dateForm.responsibleId} onChange={(event) => setDateForm({ ...dateForm, responsibleId: event.target.value })}><option value="">Не назначен</option>{state.counterparties.filter((item) => ['contractor', 'service'].includes(item.type) && item.status !== 'blocked').map((item) => <option value={item.id} key={item.id}>{item.name}{item.specialty ? ` · ${item.specialty}` : ''}</option>)}</select></Field>
        </div>
        {selected.schedule && <p className="muted">Связи, бригада и сотрудник, подтверждающий состояние, изменяются в «Сверить ППР и факты».</p>}
        <Field label="Причина изменения плана / оценки"><input required={dateForm.planStart !== selected.planStart || dateForm.planEnd !== selected.planEnd || dateForm.forecastEnd !== selected.forecastEnd} value={dateForm.reason} onChange={(event) => setDateForm({ ...dateForm, reason: event.target.value })} /></Field>
        {dateError && <p role="alert" className="danger-text">{dateError}</p>}{selected.baseline && <p className="muted">План 0: {selected.baseline.start ? formatDate(selected.baseline.start) : '—'} — {formatDate(selected.baseline.end)} · {selected.baseline.note}</p>}
        {selected.planHistory?.slice(-5).reverse().map((h, i) => <p className="baseline-history" key={i}>{h.before || '—'} → {h.after || '—'} · {h.reason}<small>{h.actor} · {formatDate(h.at.slice(0, 10))}</small></p>)}
        <div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setEditingDates(false)}>Отмена</button><button type="submit" className="button button--primary">Сохранить график</button></div>
      </form></Modal>}
    </div>
  );
}

function StageDrawer({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    dialog?.showModal();
    document.body.style.overflow = 'hidden';
    return () => { dialog?.close(); document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  return <dialog ref={ref} className="schedule-drawer" aria-label={title} onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); } }}>
    <header className="schedule-drawer__header"><div><span className="eyebrow">Карточка этапа</span><h2>{title}</h2></div><button type="button" className="icon-button" aria-label="Закрыть карточку этапа" onClick={onClose}><X size={20} /></button></header>
    <div className="schedule-drawer__body">{children}</div>
  </dialog>;
}
