import { ChevronRight } from 'lucide-react';
import { formatDate } from '../presentation/formatting';
import { scheduleColumn, scheduleColumns, scheduleStageTitle, linkedStageTasks } from './schedule-work-model';
import { ScheduleDeviation, SchedulePaymentList, ScheduleTaskList, ScheduleWorkProgress, type ScheduleWorkViewProps } from './ScheduleWorkList';

export function ScheduleKanban(props: ScheduleWorkViewProps) {
  return <div className="schedule-kanban" aria-label="Канбан этапов">{scheduleColumns.map(column => {
    const rows = props.rows.filter(row => scheduleColumn(row.stage) === column.id);
    return <section key={column.id} className={`schedule-kanban__column schedule-kanban__column--${column.id}`} aria-label={column.title}>
      <header><h3>{column.title}</h3><span>{rows.length}</span></header>
      <div className="schedule-kanban__cards">{rows.length ? rows.map(row => <article key={row.stage.id} className="schedule-kanban__card">
        {row.stage.schedule?.phase && <small className="schedule-kanban__phase">{row.stage.schedule.phase}</small>}
        <button type="button" className="schedule-stage-link" onClick={() => props.onSelect(row.stage.id)}><strong>{scheduleStageTitle(row.stage)}</strong><ChevronRight size={15} /></button>
        {props.drivingIds.has(row.stage.id) && <span className="schedule-driving">Определяет срок</span>}
        {row.stage.status === 'rework' && <span className="schedule-status schedule-status--rework">На доработке</span>}
        {(row.stage.blocker || row.stage.status === 'blocked') && <p className="schedule-stage-blocker">{row.stage.blocker || 'Есть препятствие'}</p>}
        <small className="schedule-stage-owner">{row.stage.responsible || 'Ответственный не назначен'}</small>
        <ScheduleWorkProgress value={row.stage.progress} />
        <div className="schedule-kanban__date"><span>{row.basis}</span><strong>{row.end ? formatDate(row.end) : 'Не указано'}</strong></div>
        {props.compare && <div className="schedule-kanban__date schedule-kanban__date--baseline"><span>План 0</span><strong>{row.stage.baseline?.end ? formatDate(row.stage.baseline.end) : 'Не зафиксирован'}</strong></div>}
        <ScheduleDeviation row={row} />
        {props.showTasks && <ScheduleTaskList tasks={linkedStageTasks(props.tasks, row.stage.id)} onOpenTask={props.onOpenTask} />}
        <SchedulePaymentList payments={props.payments.filter(payment => payment.stageId === row.stage.id)} onOpen={props.onOpenFinance} />
      </article>) : <p className="schedule-kanban__empty">Нет этапов</p>}</div>
    </section>;
  })}</div>;
}
