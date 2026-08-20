import type { StageStatus, TaskPriority, TaskStatus } from '../entities/index';

export const stageStatusLabel: Record<StageStatus, string> = {
  not_ready: 'Не готов',
  ready: 'Готов к старту',
  in_progress: 'В работе',
  blocked: 'Заблокирован',
  awaiting_inspection: 'На проверке',
  accepted: 'Принят',
  rework: 'Доработка',
};

export const taskStatusLabel: Record<TaskStatus, string> = {
  todo: 'К выполнению',
  in_progress: 'В работе',
  waiting: 'Ожидание',
  review: 'На проверке',
  done: 'Выполнена',
  canceled: 'Отменена',
};

export const taskPriorityLabel: Record<TaskPriority, string> = {
  low: 'Низкий',
  normal: 'Обычный',
  high: 'Высокий',
  critical: 'Критичный',
};
