import type { AppState, StageStatus, TaskPriority, TaskStatus } from './entities/index';
import { projectProgressTotals } from './progressEngine.ts';

export { acceptedAmountFor, financeTotals, lineTotals, paidAmountFor, stageFinanceTotals } from './domain/index.ts';

export const money = (value: number, compact = false) =>
  new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
    notation: compact ? 'compact' : 'standard',
  }).format(value);

export const shortMoney = (value: number) => {
  const absolute = Math.abs(value);
  if (absolute < 1_000) return `${Math.round(value).toLocaleString('ru-RU')} ₽`;
  if (absolute < 1_000_000) return `${(value / 1_000).toFixed(absolute >= 100_000 ? 0 : 1).replace('.', ',')} тыс. ₽`;
  return `${(value / 1_000_000).toFixed(absolute >= 10_000_000 ? 0 : 2).replace('.', ',')} млн ₽`;
};

export const formatDate = (value: string, withYear = false) =>
  new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
  }).format(new Date(value));

export const formatDateTime = (value: string) =>
  new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));

export const progressTotals = (state: AppState) => projectProgressTotals(state);

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

export const isTaskClosed = (status: TaskStatus) => status === 'done' || status === 'canceled';

export const isTaskOverdue = (task: AppState['tasks'][number], today = new Date().toISOString().slice(0, 10)) =>
  !isTaskClosed(task.status) && task.dueDate < today;

export const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
