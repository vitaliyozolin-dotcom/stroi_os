import type { ProjectTask, TaskStatus } from '../entities/index';

export const isTaskClosed = (status: TaskStatus) => status === 'done' || status === 'canceled';

export const isTaskOverdue = (task: ProjectTask, today: string) =>
  !isTaskClosed(task.status) && task.dueDate < today;
