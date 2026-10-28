import type { AppState, FinanceEntry } from '../entities/index';
import { outstandingAmountFor } from './finance-totals.js';
import { treasuryProjection, type TreasuryProjectionEvent } from './treasury.js';

export type FinanceCalendarGroup = 'overdue' | 'next7' | 'later' | 'undated';
export interface FinanceCalendarItem {
  id: string;
  entry?: FinanceEntry;
  kind: 'expense' | 'income';
  title: string;
  counterparty?: string;
  remaining: number;
  /** Original scheduled date; never the overdue roll-forward used by the cash forecast. */
  dueDate: string | null;
  group: FinanceCalendarGroup;
  projectionEvent?: TreasuryProjectionEvent;
}

export const financeCalendarToday = (now = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(now);

export const validFinanceDueDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

// Legacy dates include today; treasury shows the seven days after its end-of-day cutoff.
export function financeCalendarItems(state: AppState | Pick<AppState, 'financeEntries'> & Partial<Pick<AppState, 'financeLedger'>>, today = financeCalendarToday()): FinanceCalendarItem[] {
  if (!validFinanceDueDate(today)) throw new Error('Invalid calendar date');
  const end = new Date(`${today}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() + ('treasury' in state && state.treasury?.enabled ? 7 : 6));
  const cutoff = end.toISOString().slice(0, 10);
  const groups: FinanceCalendarGroup[] = ['overdue', 'next7', 'later', 'undated'];
  let items: FinanceCalendarItem[];
  if ('treasury' in state && state.treasury?.enabled) {
    const byId = new Map(state.financeEntries.map(entry => [entry.id, entry]));
    // Events are unbounded; a one-day balance horizon avoids calculating unused daily totals.
    // The base scenario includes every remaining obligation, even those paid directly by a participant.
    items = treasuryProjection(state, { today, horizonDays: 1, scenario: 'base' }).events.flatMap(event => {
      const entry = byId.get(event.entryId);
      const dueDate = event.scheduledDate;
      const group: FinanceCalendarGroup = !dueDate ? 'undated' : event.overdue ? 'overdue' : dueDate <= cutoff ? 'next7' : 'later';
      return [{ id: event.id, entry, kind: event.kind, title: event.description, counterparty: entry?.counterparty, remaining: event.amountCents / 100, dueDate, group, projectionEvent: event }];
    });
  } else {
    items = state.financeEntries.flatMap(entry => {
      const remaining = outstandingAmountFor(entry, state);
      if (!Number.isFinite(remaining) || remaining <= 0) return [];
      const dueDate = validFinanceDueDate(entry.dueDate) ? entry.dueDate : null;
      const group: FinanceCalendarGroup = !dueDate ? 'undated' : dueDate < today ? 'overdue' : dueDate <= cutoff ? 'next7' : 'later';
      return [{ id: entry.id, entry, kind: entry.kind, title: entry.description, counterparty: entry.counterparty, remaining, dueDate, group }];
    });
  }
  return items.sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group)
    || (a.dueDate ?? '').localeCompare(b.dueDate ?? '')
    || a.title.localeCompare(b.title, 'ru')
    || a.id.localeCompare(b.id));
}

export const financeCalendarTotal = (items: FinanceCalendarItem[]) => items.reduce((sum, item) => sum + Math.round(item.remaining * 100), 0) / 100;
