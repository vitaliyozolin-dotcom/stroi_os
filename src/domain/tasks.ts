import type { ProjectTask, TaskStatus } from '../entities/index';
import { validPlanDate } from './construction/plan-baseline.js';

export const isTaskClosed = (status: TaskStatus) => status === 'done' || status === 'canceled';

export const isTaskOverdue = (task: ProjectTask, today: string) =>
  !isTaskClosed(task.status) && validPlanDate(task.dueDate) && task.dueDate < today;
