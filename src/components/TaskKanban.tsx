import { CalendarClock, ChevronRight, ShieldCheck } from 'lucide-react';
import type { ProjectTask, Stage, TaskStatus } from '../entities/index';
import { isTaskOverdue } from '../domain/tasks';
import { formatDate } from '../presentation/formatting';
import { taskPriorityLabel, taskStatusLabel } from '../presentation/status-labels';
import './task-kanban.css';

const columns: TaskStatus[] = ['todo', 'in_progress', 'waiting', 'review', 'done', 'canceled'];
/** The board is another view of canonical tasks. All mutations use the task card's audited commands. */
export function TaskKanban({ tasks, stages, today, onOpen }: { tasks: ProjectTask[]; stages: Stage[]; today: string; onOpen?: (taskId: string) => void }) {
  return <div className="task-kanban-view">
    <p className="task-kanban__hint">Откройте задачу, чтобы начать работу, указать препятствие или передать результат на проверку. Закрытие проходит через назначенного проверяющего.</p>
    <div className="task-kanban" aria-label="Канбан задач" tabIndex={0}>
      {columns.filter(status => status !== 'canceled' || tasks.some(task => task.status === 'canceled')).map(status => {
        const members = tasks.filter(task => task.status === status);
        const stageIds = [...new Set(members.map(task => task.stageId || ''))];
        return <section className={`task-kanban__column task-kanban__column--${status}`} key={status} aria-label={taskStatusLabel[status]}>
          <header><h3>{taskStatusLabel[status]}</h3><span>{members.length}</span></header>
          {stageIds.map(stageId => <div key={stageId} className="task-kanban__group"><h4>{stages.find(stage => stage.id === stageId)?.name || 'Общие задачи'}</h4>
            {members.filter(task => (task.stageId || '') === stageId).map(task => {
              const overdue = isTaskOverdue(task, today);
              return <button type="button" className={`task-kanban__card${overdue ? ' is-overdue' : ''}`} key={task.id} onClick={() => onOpen?.(task.id)} disabled={!onOpen} data-task-id={task.id}>
                <span className="task-kanban__title"><strong>{task.title}</strong><ChevronRight size={15} /></span>
                <span className={`task-kanban__priority task-kanban__priority--${task.priority}`}>{taskPriorityLabel[task.priority]}</span>
                <small>{task.assigneeName || 'Ответственный не назначен'}</small>
                {task.blockerReason && status === 'waiting' && <span className="task-kanban__blocker">{task.blockerReason}</span>}
                <span className="task-kanban__date"><CalendarClock size={13} /> {overdue ? 'Просрочено · ' : 'До '}{formatDate(task.dueDate, true)}</span>
                {task.reviewerId && <small className="task-kanban__reviewer"><ShieldCheck size={13} /> Проверяет {task.reviewerName || 'назначенный сотрудник'}</small>}
                {task.status === 'done' && task.completionNote && <small className="task-kanban__result">{task.completionNote}</small>}
              </button>;
            })}
          </div>)}
          {!members.length && <p className="task-kanban__empty">Нет задач</p>}
        </section>;
      })}
    </div>
  </div>;
}
