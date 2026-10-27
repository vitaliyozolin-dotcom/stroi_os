import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Check, ChevronRight, GanttChart, Kanban, List, LocateFixed, Search } from 'lucide-react';
import { automaticSchedule, forecastSchedule, plannedStageDays, type AutomaticSchedule } from '../domain/construction/index.js';
import type { AppState, Stage, UserRole } from '../entities/index';
import { addDaysKey, mondayOf } from '../projectWeek';
import { formatDate, money } from '../presentation/formatting';
import { stageStatusLabel } from '../presentation/status-labels';
import { ScheduleWorkList, type ScheduleWorkViewProps } from './ScheduleWorkList';
import { ScheduleKanban } from './ScheduleKanban';
import { linkedStageTasks, normalizeSchedulePreferences, schedulePaymentMarkers, scheduleStageTitle, type SchedulePreferences } from './schedule-work-model';
import './schedule-timeline.css';
import './schedule-work-views.css';

export type ScheduleTimelineProps = { state: AppState; today: string; role: UserRole; onSelect: (stageId: string) => void; onOpenFinance?: (entryId: string) => void; onOpenTask?: (taskId: string) => void };
export type ScheduleDisplayRow = { stage: Stage; start: string | null; end: string | null; basis: string; point: boolean; estimated: boolean; duration?: string };
const DAY = 86_400_000;
const parse = (value: string) => new Date(`${value}T12:00:00Z`).getTime();
const valid = (value: string | undefined): value is string => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(parse(value)));
const finished = (stage: Stage) => ['accepted', 'awaiting_inspection'].includes(stage.status);

export { scheduleStageTitle } from './schedule-work-model';

export function scheduleDisplayRow(stage: Stage, forecast: AutomaticSchedule): ScheduleDisplayRow {
  const row = forecast.rows.find((item) => item.id === stage.id);
  if (finished(stage)) {
    const actual = stage.completedOn || stage.actualEnd;
    if (valid(actual)) return { stage, start: valid(stage.actualStart) ? stage.actualStart : actual, end: actual, basis: 'Выполнено', point: !valid(stage.actualStart), estimated: false };
    // The automatic calculation can use today as a fallback for old records.
    // That fallback must never be presented as a recorded observation date.
    const hasObservation = valid(stage.completionObservedOn) || Number.isFinite(Date.parse(stage.acceptedAt || ''));
    if (row && hasObservation) return { stage, start: row.end, end: row.end, basis: 'Подтверждено к', point: true, estimated: false };
    return { stage, start: null, end: null, basis: 'Дата выполнения не указана', point: true, estimated: false };
  }
  const plannedDays = plannedStageDays(stage);
  const unit = stage.schedule && stage.schedule.calendar !== 'daily' ? 'раб. дн.' : 'дн.';
  const duration = row?.source === 'remaining' && forecast.end
    ? `Осталось ${row.remainingDays} ${unit}`
    : plannedDays ? `${plannedDays} ${unit} по ППР` : undefined;
  if (forecast.end && row) return { stage, start: row.start, end: row.end, basis: row.source === 'plan' ? 'Предварительно до' : 'Прогноз до', point: false, estimated: row.source === 'plan', duration };
  return { stage, start: valid(stage.planStart) ? stage.planStart : null, end: valid(stage.planEnd) ? stage.planEnd : null, basis: 'По плану до', point: false, estimated: true, duration };
}

const dateText = (row: ScheduleDisplayRow) => row.end ? `${row.basis} ${formatDate(row.end)}` : row.basis === 'По плану до' ? 'Срок не указан' : row.basis;
const statusText = (stage: Stage) => stage.status === 'not_ready' ? 'Не начато' : stageStatusLabel[stage.status];
const preferenceKey = (projectId: string) => `ikioma.schedule.views.v1:${projectId}`;
const readPreferences = (projectId: string) => {
  try { return normalizeSchedulePreferences(JSON.parse(window.localStorage.getItem(preferenceKey(projectId)) || 'null')); }
  catch { return normalizeSchedulePreferences(null); }
};

export function ScheduleTimeline(props: ScheduleTimelineProps) {
  return <ScheduleTimelineContent key={props.state.project.id} {...props} />;
}
function ScheduleTimelineContent({ state, today, role, onSelect, onOpenFinance, onOpenTask }: ScheduleTimelineProps) {
  const [preferences, setPreferences] = useState<SchedulePreferences>(() => readPreferences(state.project.id));
  const updatePreference = <K extends keyof SchedulePreferences>(key: K, value: SchedulePreferences[K]) => setPreferences(previous => ({ ...previous, [key]: value }));
  const { view: mode, compare, showCompleted, showTasks } = preferences;
  const [search, setSearch] = useState('');
  const [phase, setPhase] = useState('');
  const [smallScreen, setSmallScreen] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 700px)').matches);
  const scrollRef = useRef<HTMLDivElement>(null);
  const forecast = useMemo(() => automaticSchedule(state, today), [state, today]);
  const strict = useMemo(() => forecastSchedule(state, today), [state, today]);
  const drivingIds = useMemo(() => new Set(strict.kind === 'calculated' && strict.end ? strict.criticalIds.filter(id => !finished(state.stages.find(stage => stage.id === id)!)) : []), [strict, state.stages]);
  const payments = useMemo(() => preferences.showPayments ? schedulePaymentMarkers(state, role, today) : [], [state, role, preferences.showPayments, today]);
  const phases = useMemo(() => [...new Set(state.stages.map(stage => stage.schedule?.phase).filter((value): value is string => Boolean(value)))], [state.stages]);
  const activeMode = mode === 'auto' ? smallScreen ? 'list' : 'gantt' : mode;
  useEffect(() => { try { window.localStorage.setItem(preferenceKey(state.project.id), JSON.stringify(preferences)); } catch { /* View preferences remain usable when local storage is unavailable. */ } }, [state.project.id, preferences]);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 700px)');
    const update = () => setSmallScreen(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const ordered = useMemo(() => [...state.stages].sort((a, b) => a.order - b.order), [state.stages]);
  const acceptedCount = ordered.filter((stage) => stage.status === 'accepted').length;
  const onlyCompleted = acceptedCount === ordered.length;
  const rows = useMemo(() => ordered.filter(stage => (onlyCompleted || showCompleted || stage.status !== 'accepted')
    && (!phase || stage.schedule?.phase === phase)
    && (!preferences.drivingOnly || !drivingIds.size || drivingIds.has(stage.id))
    && (!search.trim() || [stage.name, stage.shortName, stage.responsible, ...(role === 'client' ? [] : linkedStageTasks(state.tasks, stage.id).map(task => task.title))].join(' ').toLocaleLowerCase('ru').includes(search.trim().toLocaleLowerCase('ru'))))
    .map(stage => scheduleDisplayRow(stage, forecast)), [ordered, onlyCompleted, showCompleted, phase, preferences.drivingOnly, drivingIds, search, state.tasks, forecast, role]);
  const visiblePayments = useMemo(() => { const ids = new Set(rows.map(row => row.stage.id)); return payments.filter(payment => ids.has(payment.stageId)); }, [rows, payments]);
  const viewProps: ScheduleWorkViewProps = { rows, tasks: role === 'client' ? [] : state.tasks, payments: visiblePayments, drivingIds, compare, showTasks, onSelect,
    onOpenFinance: (id, stageId) => onOpenFinance ? onOpenFinance(id) : onSelect(stageId), onOpenTask };
  const timeline = useMemo(() => {
    const keys = [today, ...visiblePayments.map(payment => payment.date), ...rows.flatMap((row) => [row.start, row.end, ...(compare ? [row.stage.baseline?.start, row.stage.baseline?.end] : [])])].filter((key): key is string => valid(key ?? undefined)).sort();
    const first = addDaysKey(mondayOf(keys[0] || today), -7);
    const last = addDaysKey(mondayOf(keys.at(-1) || today), 13);
    const days = Math.max(35, Math.round((parse(last) - parse(first)) / DAY) + 1);
    const dayWidth = days > 210 ? 10 : days > 100 ? 16 : 24;
    const offset = (key: string) => Math.max(0, Math.round((parse(key) - parse(first)) / DAY)) * dayWidth;
    const weeks = Array.from({ length: Math.ceil(days / 7) }, (_, index) => ({ key: addDaysKey(first, index * 7), left: index * 7 * dayWidth }));
    const months = weeks.filter((week, index) => index === 0 || week.key.slice(0, 7) !== weeks[index - 1].key.slice(0, 7));
    return { width: days * dayWidth, dayWidth, offset, weeks, months, todayX: offset(today) + dayWidth / 2 };
  }, [rows, visiblePayments, compare, today]);
  const locateToday = () => {
    const element = scrollRef.current;
    if (!element) return;
    const labelWidth = window.matchMedia('(max-width: 700px)').matches ? 174 : 248;
    element.scrollLeft = Math.max(0, timeline.todayX - Math.max(80, (element.clientWidth - labelWidth) * 0.3));
  };
  useEffect(() => { locateToday(); }, [timeline.width, timeline.todayX, mode]);
  const gridStyle = { '--schedule-track-width': `${timeline.width}px`, '--schedule-week-width': `${timeline.dayWidth * 7}px` } as CSSProperties;

  return (
    <section className={`schedule-board schedule-board--${activeMode}`} aria-label="План работ">
      <div className="schedule-board__toolbar">
        <div className="schedule-board__views" aria-label="Вид этапов">
          <button type="button" className={`schedule-board__view${activeMode === 'list' ? ' is-active' : ''}`} aria-pressed={activeMode === 'list'} onClick={() => updatePreference('view', 'list')}><List size={16} /> Список</button>
          <button type="button" className={`schedule-board__view${activeMode === 'gantt' ? ' is-active' : ''}`} aria-pressed={activeMode === 'gantt'} onClick={() => updatePreference('view', 'gantt')}><GanttChart size={16} /> Гант</button>
          <button type="button" className={`schedule-board__view${activeMode === 'kanban' ? ' is-active' : ''}`} aria-pressed={activeMode === 'kanban'} onClick={() => updatePreference('view', 'kanban')}><Kanban size={16} /> Канбан</button>
        </div>
        <div className="schedule-board__options">
          <label className="schedule-board__check"><input type="checkbox" checked={compare} onChange={(event) => updatePreference('compare', event.target.checked)} /><span>План 0</span></label>
          {role !== 'client' && <label className="schedule-board__check"><input type="checkbox" checked={showTasks} onChange={event => updatePreference('showTasks', event.target.checked)} /><span>Задачи</span></label>}
          {role === 'management' && <label className="schedule-board__check"><input type="checkbox" checked={preferences.showPayments} onChange={event => updatePreference('showPayments', event.target.checked)} /><span>Платежи</span></label>}
          {activeMode === 'gantt' && <button type="button" className="schedule-board__today" onClick={locateToday}><LocateFixed size={16} /> Сегодня</button>}
        </div>
      </div>
      <div className="schedule-board__filters">
        <label className="schedule-board__search"><Search size={15} /><input aria-label="Найти этап, задачу или ответственного" placeholder="Этап, задача, ответственный" value={search} onChange={event => setSearch(event.target.value)} /></label>
        {phases.length > 0 && <select aria-label="Фильтр по разделу ППР" value={phase} onChange={event => setPhase(event.target.value)}><option value="">Все разделы</option>{phases.map(name => <option key={name}>{name}</option>)}</select>}
        <label className="schedule-board__check" title={drivingIds.size ? 'Цепочка работ, определяющая подтверждённый прогноз окончания. Резервы времени не рассчитаны.' : 'Сначала нужны подтверждённые зависимости и актуальные остатки работ.'}><input type="checkbox" disabled={!drivingIds.size} checked={preferences.drivingOnly && drivingIds.size > 0} onChange={event => updatePreference('drivingOnly', event.target.checked)} /><span>Определяют срок</span></label>
        <span className="schedule-board__count">{rows.length} из {ordered.length}</span>
      </div>

      {!rows.length && <p className="schedule-board__empty">По выбранным условиям этапов нет.</p>}
      {activeMode === 'gantt' && rows.length > 0 && <div className="schedule-board__gantt" ref={scrollRef} tabIndex={0} aria-label="График работ. Прокрутите вправо или влево, чтобы увидеть другие даты." style={gridStyle}>
        <div className="schedule-board__canvas">
          <div className="schedule-board__axis">
            <div className="schedule-board__axis-label">Этапы <span>{rows.length}</span></div>
            <div className="schedule-board__axis-track">
              {timeline.months.map((month) => <span key={month.key} className="schedule-board__month" style={{ left: month.left + 10 }}>{new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(parse(month.key)))}</span>)}
              {timeline.weeks.map((week) => <span key={week.key} className="schedule-board__week" style={{ left: week.left + 10 }}>{formatDate(week.key)}</span>)}
              <span className="schedule-board__now" style={{ left: timeline.todayX }}>Сегодня</span>
            </div>
          </div>
          {rows.map((row) => {
            const { stage } = row;
            const span = row.start && row.end ? Math.max(timeline.dayWidth, timeline.offset(row.end) - timeline.offset(row.start) + timeline.dayWidth) : 0;
            const hasBaseline = valid(stage.baseline?.end);
            const baselineStart = valid(stage.baseline?.start) ? stage.baseline.start : stage.baseline?.end;
            const stagePayments = visiblePayments.filter(payment => payment.stageId === stage.id && payment.date);
            const paymentDays = [...new Set(stagePayments.map(payment => payment.date!))];
            return <div key={stage.id} className={`schedule-board__row schedule-board__row--${stage.status}${compare ? ' schedule-board__row--compare' : ''}${stagePayments.length ? ' schedule-board__row--payments' : ''}`}>
              <button type="button" className="schedule-board__name" onClick={() => onSelect(stage.id)} aria-label={`${scheduleStageTitle(stage)}. ${statusText(stage)}. ${dateText(row)}. Открыть этап`}><span className="schedule-board__status-dot">{stage.status === 'accepted' && <Check size={12} />}</span><span><strong>{scheduleStageTitle(stage)}</strong><small>{statusText(stage)}{row.duration && <> · {row.duration}</>}</small>{drivingIds.has(stage.id) && <small className="schedule-driving">Определяет срок</small>}{showTasks && role !== 'client' && linkedStageTasks(state.tasks, stage.id).length > 0 && <small>Задачи · {linkedStageTasks(state.tasks, stage.id).length}</small>}</span><ChevronRight size={14} className="schedule-board__open" /></button>
              <span className="schedule-board__track">
                <span className="schedule-board__today-line" style={{ left: timeline.todayX }} aria-hidden="true" />
                {row.start && row.end ? <button type="button" onClick={() => onSelect(stage.id)} title={dateText(row)} aria-label={`${scheduleStageTitle(stage)}: ${dateText(row)}`} className={`schedule-board__bar${row.point ? ' schedule-board__bar--point' : ''}${row.estimated ? ' schedule-board__bar--estimated' : ''}`} style={{ left: timeline.offset(row.start) + (row.point ? timeline.dayWidth / 2 : 0), width: row.point ? undefined : span }}><span className={`schedule-board__bar-label${span < 170 || row.point ? ' schedule-board__bar-label--outside' : ''}`}>{dateText(row)}</span></button> : <span className="schedule-board__unknown" style={{ left: timeline.todayX + 14 }}>{dateText(row)}</span>}
                {compare && hasBaseline && baselineStart && <span className="schedule-board__baseline" title={`Исходный план: ${formatDate(baselineStart)} — ${formatDate(stage.baseline!.end)}`} style={{ left: timeline.offset(baselineStart), width: Math.max(timeline.dayWidth, timeline.offset(stage.baseline!.end) - timeline.offset(baselineStart) + timeline.dayWidth) }} />}
                {paymentDays.map(day => { const group = stagePayments.filter(payment => payment.date === day); const label = group.map(payment => `${payment.kind === 'income' ? 'Поступление' : 'Оплата'} ${money(payment.amount)} · ${payment.title}${payment.overdue ? ' · просрочено' : ''}${payment.contractualDueDate ? ` · по договору ${formatDate(payment.contractualDueDate)}` : ''}`).join('; '); return <button key={day} type="button" className={`schedule-board__payment-dot schedule-board__payment-dot--${group.every(payment => payment.kind === 'income') ? 'income' : 'expense'}`} style={{ left: timeline.offset(day) + timeline.dayWidth / 2 }} title={`${formatDate(day)}: ${label}`} aria-label={`${formatDate(day)}: ${label}`} onClick={() => group.length === 1 ? viewProps.onOpenFinance(group[0].entryId, stage.id) : onSelect(stage.id)}>{group.length > 1 ? group.length : '₽'}</button>; })}
              </span>
            </div>;
          })}
        </div>
      </div>}
      {activeMode === 'list' && rows.length > 0 && <ScheduleWorkList {...viewProps} />}
      {activeMode === 'kanban' && rows.length > 0 && <ScheduleKanban {...viewProps} />}

      <div className="schedule-board__footer">
        {acceptedCount > 0 && !onlyCompleted ? <button type="button" className="schedule-board__completed" aria-expanded={showCompleted} onClick={() => updatePreference('showCompleted', !showCompleted)}><Check size={15} /> {showCompleted ? 'Скрыть принятые' : 'Показать принятые'} <span>{acceptedCount}</span></button> : <span className="schedule-board__footnote">Откройте этап, чтобы обновить работу или принять результат</span>}
        {compare && <span className="schedule-board__baseline-key"><i /> Исходный план</span>}
        {activeMode === 'gantt' && visiblePayments.length > 0 && <span className="schedule-board__footnote">₽ — {state.treasury?.enabled ? 'базовый прогноз по траншам' : 'план неоплаченного остатка'}{visiblePayments.some(payment => !payment.date) ? ' · Есть платежи без даты: смотрите список' : ''}</span>}
      </div>
    </section>
  );
}
