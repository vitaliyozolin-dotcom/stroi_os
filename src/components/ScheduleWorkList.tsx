import { ArrowDownLeft, ArrowUpRight, ChevronRight, ListTodo } from 'lucide-react';
import type { ProjectTask } from '../entities/index';
import { formatDate, money } from '../presentation/formatting';
import { stageStatusLabel, taskStatusLabel } from '../presentation/status-labels';
import type { ScheduleDisplayRow } from './ScheduleTimeline';
import { linkedStageTasks, scheduleStageTitle, scheduleVariance, type SchedulePaymentMarker } from './schedule-work-model';

export interface ScheduleWorkViewProps {
  rows: ScheduleDisplayRow[];
  tasks: ProjectTask[];
  payments: SchedulePaymentMarker[];
  drivingIds: Set<string>;
  compare: boolean;
  showTasks: boolean;
  onSelect: (stageId: string) => void;
  onOpenFinance: (entryId: string, stageId: string) => void;
  onOpenTask?: (taskId: string) => void;
}

export function ScheduleWorkProgress({ value }: { value: number }) {
  const progress = Math.round(Math.max(0, Math.min(100, Number(value) || 0)));
  return <div className="schedule-work-progress"><progress max={100} value={progress} aria-label={`Физически выполнено ${progress}%`} /><span>{progress}%</span></div>;
}

export function ScheduleTaskList({ tasks, onOpenTask }: { tasks: ProjectTask[]; onOpenTask?: (id: string) => void }) {
  if (!tasks.length) return null;
  const done = tasks.filter(task => task.status === 'done').length;
  return <details className="schedule-linked-tasks"><summary><ListTodo size={14} /> Задачи <span>{done}/{tasks.filter(task => task.status !== 'canceled').length}</span></summary><ul>{tasks.map(task => <li key={task.id}>
    {onOpenTask ? <button type="button" onClick={() => onOpenTask(task.id)}>{task.title}<ChevronRight size={13} /></button> : <strong>{task.title}</strong>}
    <small>{taskStatusLabel[task.status]} · {task.assigneeName || 'Не назначен'}{task.dueDate ? ` · до ${formatDate(task.dueDate)}` : ''}</small>
  </li>)}</ul></details>;
}

export function SchedulePaymentList({ payments, onOpen }: { payments: SchedulePaymentMarker[]; onOpen: (id: string, stageId: string) => void }) {
  if (!payments.length) return null;
  return <div className="schedule-linked-payments">{payments.map(payment => <button key={payment.id} type="button" className={`schedule-payment schedule-payment--${payment.kind}`} onClick={() => onOpen(payment.entryId, payment.stageId)} title={[payment.title, payment.dateLabel, payment.dateReason, payment.contractualDueDate ? `По договору ${formatDate(payment.contractualDueDate)}` : '', payment.excludedFromCash ? 'Прямая оплата участником; не меняет счета компании' : ''].filter(Boolean).join(' · ')}>
    {payment.kind === 'income' ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}
    <span>{payment.kind === 'income' ? 'Поступление' : 'Оплата'}<small>{payment.source === 'treasury' ? 'По правилу / плану · ' : ''}{payment.date ? formatDate(payment.date) : 'Без даты'}{payment.overdue ? payment.contractOverdue ? ' · договорный срок прошёл' : ' · плановый срок прошёл' : ''}</small>
      {payment.dateLabel && <small>{payment.dateLabel}</small>}
      {payment.forecastDate && payment.forecastDate !== payment.date && <small>В денежном прогнозе: {formatDate(payment.forecastDate)}</small>}
      {payment.forecastDelayDays !== undefined && payment.forecastDelayDays !== null && payment.forecastDelayDays > 0 && <small>Прогноз позже договора на {payment.forecastDelayDays} дн.</small>}
      {payment.excludedFromCash && <small>Оплата участником · вне счетов компании</small>}
      {!payment.date && payment.dateReason && <small>{payment.dateReason}</small>}
    </span>
    <strong>{payment.kind === 'income' ? '+' : '−'}{money(payment.amount)}</strong>
  </button>)}</div>;
}

export function ScheduleDeviation({ row }: { row: ScheduleDisplayRow }) {
  const variance = scheduleVariance(row.stage, row.end, row.basis);
  const label = variance.basis === 'actual' ? 'Факт к исходному' : variance.basis === 'forecast' ? 'Прогноз к исходному' : variance.basis === 'plan' ? 'Перенос плана' : 'Дата факта неизвестна';
  return <span className={`schedule-deviation${variance.days && variance.days > 0 ? ' schedule-deviation--late' : ''}`}><small>{label}</small><strong>{variance.days === null ? '—' : `${variance.days > 0 ? '+' : ''}${variance.days} кал. дн.`}</strong></span>;
}

export function ScheduleWorkList(props: ScheduleWorkViewProps) {
  return <div className="schedule-work-list">
    <div className="schedule-work-list__head" aria-hidden="true"><span>Этап и задачи</span><span>Сроки</span><span>Отклонение</span>{props.payments.length > 0 && <span>Осталось оплатить / получить</span>}</div>
    {props.rows.map(row => <article className={`schedule-work-list__row${props.payments.length ? ' has-payments' : ''}`} key={row.stage.id}>
      <div><button type="button" className="schedule-stage-link" onClick={() => props.onSelect(row.stage.id)}><strong>{scheduleStageTitle(row.stage)}</strong><ChevronRight size={16} /></button>
        <span className={`schedule-status schedule-status--${row.stage.status}`}>{stageStatusLabel[row.stage.status]}</span>
        {props.drivingIds.has(row.stage.id) && <span className="schedule-driving">Определяет срок</span>}
        <small className="schedule-stage-owner">{row.stage.responsible || 'Ответственный не назначен'}</small>
        <ScheduleWorkProgress value={row.stage.progress} />
        {row.stage.blocker && <p className="schedule-stage-blocker">{row.stage.blocker}</p>}
        {props.showTasks && <ScheduleTaskList tasks={linkedStageTasks(props.tasks, row.stage.id)} onOpenTask={props.onOpenTask} />}
      </div>
      <div className="schedule-work-list__dates"><span><small>{row.basis}</small><strong>{row.end ? formatDate(row.end, true) : 'Не указано'}</strong></span>
        {props.compare && <span><small>План 0</small><strong>{row.stage.baseline?.end ? formatDate(row.stage.baseline.end, true) : 'Не зафиксирован'}</strong></span>}
        {row.duration && <small>{row.duration}</small>}
      </div>
      <ScheduleDeviation row={row} />
      {props.payments.length > 0 && <SchedulePaymentList payments={props.payments.filter(payment => payment.stageId === row.stage.id)} onOpen={props.onOpenFinance} />}
    </article>)}
  </div>;
}
