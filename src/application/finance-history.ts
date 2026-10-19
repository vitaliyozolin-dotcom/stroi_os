import type { AppState } from '../entities/index';
import { parseHistoryRegister, prepareHistoryImport } from '../domain/finance/history-import.ts';
import { validateFinanceChanges } from '../domain/finance/index.js';
import type { FinanceCommandContext } from './finance.ts';
import type { StateChange } from '../domain/change';

export interface HistoryImportCommand {
  register: unknown;
  includeBudget: boolean;
  confirmed: boolean;
  expected: string;
}
export type HistoryImportCommandResult = { ok: true; change: StateChange | null; added: number; updated: number; skipped: number } | { ok: false; error: string };

// Only import-relevant state participates; an unrelated task/comment is preserved.
export const historyImportSnapshot = (state: AppState) => JSON.stringify([
  state.project.id, state.project.targetCost, state.budgetLines, state.budgetMeta,
  state.financeEntries, state.documents, state.counterparties, state.stages.map(stage => stage.id),
]);

export const importProjectFinanceHistory = (state: AppState, input: HistoryImportCommand, context: FinanceCommandContext): HistoryImportCommandResult => {
  if (context.identity.role !== 'management') return { ok: false, error: 'Импорт финансов доступен только роли «Управление».' };
  if (input.confirmed !== true) return { ok: false, error: 'Подтвердите, что перечисленные расходы уже оплачены. Приёмка фиксируется отдельно.' };
  if (typeof input.includeBudget !== 'boolean') return { ok: false, error: 'Укажите, нужно ли вносить смету.' };
  if (input.expected !== historyImportSnapshot(state)) return { ok: false, error: 'Данные проекта обновились. Загрузите реестр заново и проверьте предпросмотр.' };
  try {
    const now = context.clock.now();
    // Parsing and immutable preparation use the latest snapshot, never a cached draft.
    const register = parseHistoryRegister(input.register);
    const result = prepareHistoryImport(state, register, context.identity.name, now, input.includeBudget);
    const { added, updated, skipped } = result;
    if (JSON.stringify(result.state) === JSON.stringify(state)) return { ok: true, change: null, added, updated, skipped };
    // Validate on a disposable copy: server-owned stamps must still be assigned by the server.
    const error = validateFinanceChanges(state, structuredClone(result.state), context.identity, now);
    if (error) return { ok: false, error };
    const hasImportActivity = result.state.activity[0]?.id !== state.activity[0]?.id;
    const summary = hasImportActivity ? result.state.activity[0].text : 'Уточнены сведения документов исторического импорта';
    const event = { id: context.ids.next('history-import'), actor: context.identity.name, timestamp: now, text: summary, tone: 'neutral' as const };
    result.state.activity = [event, ...(hasImportActivity ? result.state.activity.slice(1) : result.state.activity)];
    return { ok: true, added, updated, skipped, change: { action: 'finance_history_imported', summary, state: result.state } };
  } catch (failure) {
    return { ok: false, error: failure instanceof Error ? failure.message : 'Импорт не выполнен.' };
  }
};
