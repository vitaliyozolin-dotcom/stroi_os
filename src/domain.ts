import type { AppState, BudgetLine, ExpenseStatus, StageStatus, TaskPriority, TaskStatus } from './entities/index';
import { projectProgressTotals } from './progressEngine.ts';

export const acceptedAmountFor = (entry: AppState['financeEntries'][number]) => entry.acceptedAmount ?? (entry.status === 'accepted' || entry.status === 'paid' ? entry.amount : 0);
export const paidAmountFor = (entry: AppState['financeEntries'][number]) => entry.paidAmount ?? (entry.status === 'paid' ? entry.amount : 0);

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

export const financeTotals = (state: AppState) => {
  const expenses = state.financeEntries.filter((entry) => entry.kind === 'expense');
  const income = state.financeEntries.filter((entry) => entry.kind === 'income');
  const hasStatus = (current: ExpenseStatus, accepted: ExpenseStatus[]) => accepted.includes(current);
  return {
    plan: state.budgetLines.reduce((sum, line) => sum + line.plan, 0),
    forecast: state.budgetLines.reduce((sum, line) => sum + line.forecast, 0),
    committed: expenses.filter((entry) => hasStatus(entry.status, ['committed', 'accepted', 'paid'])).reduce((sum, entry) => sum + entry.amount, 0),
    accepted: expenses.reduce((sum, entry) => sum + acceptedAmountFor(entry), 0),
    paid: expenses.reduce((sum, entry) => sum + paidAmountFor(entry), 0),
    received: income.reduce((sum, entry) => sum + paidAmountFor(entry), 0),
    contractedIncome: income.reduce((sum, entry) => sum + entry.amount, 0),
  };
};

export const lineTotals = (state: AppState, line: BudgetLine) => {
  const entries = state.financeEntries.filter((entry) => entry.kind === 'expense' && entry.budgetLineId === line.id);
  return {
    committed: entries.reduce((sum, entry) => sum + entry.amount, 0),
    accepted: entries.reduce((sum, entry) => sum + acceptedAmountFor(entry), 0),
    paid: entries.reduce((sum, entry) => sum + paidAmountFor(entry), 0),
  };
};

export const stageFinanceTotals = (state: AppState, stageId: string) => {
  const budgetLines = state.budgetLines.filter((line) => line.stageIds.includes(stageId));
  const entries = state.financeEntries.filter((entry) => entry.stageId === stageId);
  const expenses = entries.filter((entry) => entry.kind === 'expense');
  const income = entries.filter((entry) => entry.kind === 'income');

  return {
    plan: budgetLines.reduce((sum, line) => sum + line.plan / Math.max(1, line.stageIds.length), 0),
    forecast: budgetLines.reduce((sum, line) => sum + line.forecast / Math.max(1, line.stageIds.length), 0),
    committed: expenses.reduce((sum, entry) => sum + entry.amount, 0),
    accepted: expenses.reduce((sum, entry) => sum + acceptedAmountFor(entry), 0),
    paid: expenses.reduce((sum, entry) => sum + paidAmountFor(entry), 0),
    billed: income.reduce((sum, entry) => sum + entry.amount, 0),
    received: income.reduce((sum, entry) => sum + paidAmountFor(entry), 0),
  };
};

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
