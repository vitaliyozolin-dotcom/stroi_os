import type { AppState, FinanceEntry, ProjectTask, Stage, UserRole } from '../entities/index.ts';
import { outstandingAmountFor } from '../domain/finance-totals.js';
import { planDays, validPlanDate } from '../domain/construction/plan-baseline.js';
import { treasuryProjection } from '../domain/treasury.js';

export type ScheduleView = 'auto' | 'gantt' | 'list' | 'kanban' | 'tasks';
export interface SchedulePreferences {
  view: ScheduleView;
  compare: boolean;
  showCompleted: boolean;
  showPayments: boolean;
  showTasks: boolean;
  drivingOnly: boolean;
}
export const defaultSchedulePreferences: SchedulePreferences = {
  view: 'auto', compare: true, showCompleted: true, showPayments: true, showTasks: true, drivingOnly: false,
};
export function normalizeSchedulePreferences(value: unknown): SchedulePreferences {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    view: ['auto', 'gantt', 'list', 'kanban', 'tasks'].includes(String(input.view)) ? input.view as ScheduleView : 'auto',
    ...Object.fromEntries(Object.entries(defaultSchedulePreferences).filter(([key]) => key !== 'view').map(([key, fallback]) => [key, typeof input[key] === 'boolean' ? input[key] : fallback])),
  } as SchedulePreferences;
}
export const scheduleColumns = [
  { id: 'planned', title: 'Запланировано' },
  { id: 'ready', title: 'Готово к старту' },
  { id: 'progress', title: 'В работе' },
  { id: 'review', title: 'На проверке' },
  { id: 'accepted', title: 'Принято' },
] as const;
export function scheduleColumn(stage: Stage): typeof scheduleColumns[number]['id'] {
  if (stage.status === 'accepted') return 'accepted';
  if (stage.status === 'awaiting_inspection') return 'review';
  if (stage.status === 'ready') return 'ready';
  if (['in_progress', 'rework'].includes(stage.status) || stage.status === 'blocked' && stage.actualStart) return 'progress';
  return 'planned';
}
export const linkedStageTasks = (tasks: ProjectTask[], stageId: string) => tasks.filter(task => task.stageId === stageId && task.id !== `auto-stage-${stageId}`);
export const scheduleStageTitle = (stage: Stage) => (stage.shortName || stage.name).replace(/^\s*\d+(?:\.\d+)*(?:[.)]\s*|\s+)/u, '').trim() || stage.name;
export interface SchedulePaymentMarker {
  id: string; entryId: string; stageId: string; kind: 'income' | 'expense'; amount: number; date: string | null; title: string;
  contractualDueDate?: string | null; overdue?: boolean; contractOverdue?: boolean; source: 'legacy' | 'treasury';
  /** The cash forecast may roll a missed scheduled date forward; it does not move the PPR marker. */
  forecastDate?: string | null; dateLabel?: string; dateReason?: string | null; forecastDelayDays?: number | null;
  excludedFromCash?: boolean; sourceType?: string; sourceId?: string;
}
/** Read-only projection: document dates and paid amounts never become future payments. */
export function schedulePaymentMarkers(source: FinanceEntry[] | Pick<AppState, 'project' | 'financeEntries' | 'treasury' | 'stages' | 'tasks' | 'financeLedger'>, role: UserRole, today?: string): SchedulePaymentMarker[] {
  if (role !== 'management') return [];
  const entries = Array.isArray(source) ? source : source.financeEntries;
  if (!Array.isArray(source) && source.treasury?.enabled) {
    // A one-day horizon is enough: events retain every future tranche, without building an unnecessary chart.
    if (!validPlanDate(today)) return [];
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    return treasuryProjection(source, { today, horizonDays: 1, scenario: 'base' }).events.flatMap(event => {
      // A payment can be accounted against one budget stage but triggered by another stage/task.
      // Its timeline marker follows the triggering work, including when that work has no usable date.
      const resolution = event.dateResolution;
      const stageId = resolution?.stageId ?? resolution?.linkedStageId ?? byId.get(event.entryId)?.stageId;
      if (!stageId || event.amountCents <= 0) return [];
      return [{ id: event.id, entryId: event.entryId, stageId, kind: event.kind, amount: event.amountCents / 100, date: event.scheduledDate, title: event.description,
        contractualDueDate: event.contractualDueDate, overdue: event.overdue || Boolean(event.scheduledDate && event.scheduledDate <= today),
        contractOverdue: event.contractOverdue, sourceType: event.sourceType, sourceId: event.sourceId, source: 'treasury' as const,
        forecastDate: event.date, dateLabel: resolution?.label, dateReason: resolution?.reason ?? null,
        forecastDelayDays: event.forecastDelayDays, excludedFromCash: Boolean(event.excluded) }];
    }).sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.id.localeCompare(b.id));
  }
  return entries.flatMap(entry => {
    const amount = outstandingAmountFor(entry, Array.isArray(source) ? undefined : source);
    if (!entry.stageId || amount <= 0) return [];
    return [{ id: entry.id, entryId: entry.id, stageId: entry.stageId, kind: entry.kind, amount, date: validPlanDate(entry.dueDate) ? entry.dueDate! : null, title: entry.description, source: 'legacy' as const }];
  }).sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.id.localeCompare(b.id));
}
export interface ScheduleVariance { days: number | null; basis: 'actual' | 'forecast' | 'plan' | 'unknown' }
export function scheduleVariance(stage: Stage, end: string | null, basis: string): ScheduleVariance {
  const completed = ['accepted', 'awaiting_inspection'].includes(stage.status);
  const actual = stage.completedOn || stage.actualEnd;
  if (completed) return validPlanDate(actual) ? { days: planDays(actual, stage.baseline?.end), basis: 'actual' } : { days: null, basis: 'unknown' };
  const kind = basis === 'По плану до' ? 'plan' : 'forecast';
  return { days: planDays(end, stage.baseline?.end), basis: kind };
}
