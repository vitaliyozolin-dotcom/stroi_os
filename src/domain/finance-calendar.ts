import type { AppState, FinanceEntry } from '../entities/index';
import { paidAmountFor } from './finance.ts';

export type FinanceCalendarGroup = 'overdue' | 'next7' | 'later' | 'undated';
export interface FinanceCalendarItem {
  entry: FinanceEntry;
  remaining: number;
  dueDate: string | null;
  group: FinanceCalendarGroup;
}

export const financeCalendarToday = (now = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(now);

export const validFinanceDueDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

// Seven calendar days including today. An invoice/import date is never a due date.
export function financeCalendarItems(state: Pick<AppState, 'financeEntries'>, today = financeCalendarToday()): FinanceCalendarItem[] {
  if (!validFinanceDueDate(today)) throw new Error('Invalid calendar date');
  const end = new Date(`${today}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 6);
  const cutoff = end.toISOString().slice(0, 10);
  const groups: FinanceCalendarGroup[] = ['overdue', 'next7', 'later', 'undated'];
  return state.financeEntries.flatMap(entry => {
    const remaining = Math.max(0, Math.round(entry.amount * 100) - Math.round(paidAmountFor(entry) * 100)) / 100;
    if (!Number.isFinite(remaining) || remaining <= 0) return [];
    const dueDate = validFinanceDueDate(entry.dueDate) ? entry.dueDate : null;
    const group: FinanceCalendarGroup = !dueDate ? 'undated' : dueDate < today ? 'overdue' : dueDate <= cutoff ? 'next7' : 'later';
    return [{ entry, remaining, dueDate, group }];
  }).sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group)
    || (a.dueDate ?? '').localeCompare(b.dueDate ?? '')
    || a.entry.description.localeCompare(b.entry.description, 'ru'));
}

export const financeCalendarTotal = (items: FinanceCalendarItem[]) => items.reduce((sum, item) => sum + Math.round(item.remaining * 100), 0) / 100;
