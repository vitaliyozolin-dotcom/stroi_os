import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Check, ChevronRight, GanttChart, List, LocateFixed } from 'lucide-react';
import { automaticSchedule, plannedStageDays, type AutomaticSchedule } from '../../sites/lib/automatic-schedule.js';
import type { AppState, Stage } from '../entities/index';
import { addDaysKey, mondayOf } from '../projectWeek';
import { formatDate } from '../presentation/formatting';
import { stageStatusLabel } from '../presentation/status-labels';
import './schedule-timeline.css';

type ScheduleTimelineProps = { state: AppState; today: string; onSelect: (stageId: string) => void };
type DisplayRow = { stage: Stage; start: string | null; end: string | null; basis: string; point: boolean; estimated: boolean; duration?: string };
const DAY = 86_400_000;
const parse = (value: string) => new Date(`${value}T12:00:00Z`).getTime();
const valid = (value: string | undefined): value is string => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(parse(value)));
const finished = (stage: Stage) => ['accepted', 'awaiting_inspection'].includes(stage.status);

/** Presentation only: keep the imported title, numbering and underlying PPR intact. */
export function scheduleStageTitle(stage: Stage) {
  return (stage.shortName || stage.name).replace(/^\s*\d+(?:\.\d+)*(?:[.)]\s*|\s+)/u, '').trim() || stage.name;
}

export function scheduleDisplayRow(stage: Stage, forecast: AutomaticSchedule): DisplayRow {
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

const dateText = (row: DisplayRow) => row.end ? `${row.basis} ${formatDate(row.end)}` : row.basis === 'По плану до' ? 'Срок не указан' : row.basis;
const statusText = (stage: Stage) => stage.status === 'accepted' ? 'Выполнено' : stage.status === 'not_ready' ? 'Не начато' : stageStatusLabel[stage.status];

export function ScheduleTimeline({ state, today, onSelect }: ScheduleTimelineProps) {
  const [mode, setMode] = useState<'auto' | 'gantt' | 'list'>('auto');
  const [smallScreen, setSmallScreen] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 700px)').matches);
  const [compare, setCompare] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const forecast = useMemo(() => automaticSchedule(state, today), [state, today]);
  const activeMode = mode === 'auto' ? smallScreen ? 'list' : 'gantt' : mode;
  useEffect(() => {
    const query = window.matchMedia('(max-width: 700px)');
    const update = () => setSmallScreen(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const ordered = useMemo(() => [...state.stages].sort((a, b) => a.order - b.order), [state.stages]);
  const acceptedCount = ordered.filter((stage) => stage.status === 'accepted').length;
  const onlyCompleted = acceptedCount === ordered.length;
  const rows = useMemo(() => ordered.filter((stage) => onlyCompleted || showCompleted || stage.status !== 'accepted').map((stage) => scheduleDisplayRow(stage, forecast)), [ordered, onlyCompleted, showCompleted, forecast]);
  const timeline = useMemo(() => {
    const keys = [today, ...rows.flatMap((row) => [row.start, row.end, ...(compare ? [row.stage.baseline?.start, row.stage.baseline?.end] : [])])].filter((key): key is string => valid(key ?? undefined)).sort();
    const first = addDaysKey(mondayOf(keys[0] || today), -7);
    const last = addDaysKey(mondayOf(keys.at(-1) || today), 13);
    const days = Math.max(35, Math.round((parse(last) - parse(first)) / DAY) + 1);
    const dayWidth = days > 210 ? 10 : days > 100 ? 16 : 24;
    const offset = (key: string) => Math.max(0, Math.round((parse(key) - parse(first)) / DAY)) * dayWidth;
    const weeks = Array.from({ length: Math.ceil(days / 7) }, (_, index) => ({ key: addDaysKey(first, index * 7), left: index * 7 * dayWidth }));
    const months = weeks.filter((week, index) => index === 0 || week.key.slice(0, 7) !== weeks[index - 1].key.slice(0, 7));
    return { width: days * dayWidth, dayWidth, offset, weeks, months, todayX: offset(today) + dayWidth / 2 };
  }, [rows, compare, today]);
  const locateToday = () => {
    const element = scrollRef.current;
    if (!element) return;
    const labelWidth = window.matchMedia('(max-width: 700px)').matches ? 174 : 248;
    element.scrollLeft = Math.max(0, timeline.todayX - Math.max(80, (element.clientWidth - labelWidth) * 0.3));
  };
  useEffect(() => { locateToday(); }, [timeline.width, timeline.todayX, mode]);
  const gridStyle = { '--schedule-track-width': `${timeline.width}px`, '--schedule-week-width': `${timeline.dayWidth * 7}px` } as CSSProperties;

  return (
    <section className={`schedule-board schedule-board--${mode}`} aria-label="Этапы строительства">
      <div className="schedule-board__toolbar">
        <div className="schedule-board__views" aria-label="Вид этапов">
          <button type="button" className={`schedule-board__view schedule-board__view--gantt${mode === 'gantt' ? ' is-active' : ''}`} aria-pressed={activeMode === 'gantt'} onClick={() => setMode('gantt')}><GanttChart size={16} /> График</button>
          <button type="button" className={`schedule-board__view schedule-board__view--list${mode === 'list' ? ' is-active' : ''}`} aria-pressed={activeMode === 'list'} onClick={() => setMode('list')}><List size={16} /> Список</button>
        </div>
        <div className="schedule-board__options">
          <label className="schedule-board__check"><input type="checkbox" checked={compare} onChange={(event) => setCompare(event.target.checked)} /><span>Сравнить с планом</span></label>
          <button type="button" className="schedule-board__today" onClick={locateToday}><LocateFixed size={16} /> Сегодня</button>
        </div>
      </div>

      <div className="schedule-board__gantt" ref={scrollRef} tabIndex={0} aria-label="График работ. Прокрутите вправо или влево, чтобы увидеть другие даты." style={gridStyle}>
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
            return <button type="button" key={stage.id} className={`schedule-board__row schedule-board__row--${stage.status}${compare ? ' schedule-board__row--compare' : ''}`} onClick={() => onSelect(stage.id)} aria-label={`${scheduleStageTitle(stage)}. ${statusText(stage)}. ${dateText(row)}. Открыть этап`}>
              <span className="schedule-board__name"><span className="schedule-board__status-dot">{stage.status === 'accepted' && <Check size={12} />}</span><span><strong>{scheduleStageTitle(stage)}</strong><small>{statusText(stage)}{row.duration && <> · {row.duration}</>}</small></span><ChevronRight size={14} className="schedule-board__open" /></span>
              <span className="schedule-board__track">
                <span className="schedule-board__today-line" style={{ left: timeline.todayX }} aria-hidden="true" />
                {row.start && row.end ? <span title={dateText(row)} className={`schedule-board__bar${row.point ? ' schedule-board__bar--point' : ''}${row.estimated ? ' schedule-board__bar--estimated' : ''}`} style={{ left: timeline.offset(row.start) + (row.point ? timeline.dayWidth / 2 : 0), width: row.point ? undefined : span }}><span className={`schedule-board__bar-label${span < 170 || row.point ? ' schedule-board__bar-label--outside' : ''}`}>{dateText(row)}</span></span> : <span className="schedule-board__unknown" style={{ left: timeline.todayX + 14 }}>{dateText(row)}</span>}
                {compare && hasBaseline && baselineStart && <span className="schedule-board__baseline" title={`Исходный план: ${formatDate(baselineStart)} — ${formatDate(stage.baseline!.end)}`} style={{ left: timeline.offset(baselineStart), width: Math.max(timeline.dayWidth, timeline.offset(stage.baseline!.end) - timeline.offset(baselineStart) + timeline.dayWidth) }} />}
              </span>
            </button>;
          })}
        </div>
      </div>

      <div className="schedule-board__list">
        {rows.map((row) => <button type="button" key={row.stage.id} className={`schedule-board__list-row schedule-board__list-row--${row.stage.status}`} onClick={() => onSelect(row.stage.id)}>
          <span className="schedule-board__list-top"><strong>{scheduleStageTitle(row.stage)}</strong><ChevronRight size={17} /></span>
          <span className="schedule-board__list-bottom"><span>{statusText(row.stage)}{row.duration && <> · {row.duration}</>}</span><span>{dateText(row)}</span></span>
          {compare && <span className="schedule-board__list-baseline">Исходный план: {valid(row.stage.baseline?.end) ? formatDate(row.stage.baseline.end) : 'не зафиксирован'}</span>}
        </button>)}
      </div>

      <div className="schedule-board__footer">
        {acceptedCount > 0 && !onlyCompleted ? <button type="button" className="schedule-board__completed" aria-expanded={showCompleted} onClick={() => setShowCompleted((value) => !value)}><Check size={15} /> {showCompleted ? 'Скрыть выполненные' : 'Показать выполненные'} <span>{acceptedCount}</span></button> : <span className="schedule-board__footnote">Нажмите на этап, чтобы открыть его</span>}
        {compare && <span className="schedule-board__baseline-key"><i /> Исходный план</span>}
      </div>
    </section>
  );
}
