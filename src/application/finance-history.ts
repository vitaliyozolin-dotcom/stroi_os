import type { AppState } from '../entities/index';
import type { FinanceCommandContext } from './finance-context';
import type { StateChange } from '../domain/change';
import { financeHistoryState } from '../domain/finance/history-import.ts';
import { financeHistoryFingerprint, importFinanceHistory, type HistoryImportCommand, type HistoryImportCounts, type FinanceHistoryCommandResult } from './finance-context-history.ts';

export type { HistoryImportCommand } from './finance-context-history.ts';
export type HistoryImportCommandResult = ({ ok: true; change: StateChange | null } & HistoryImportCounts) | { ok: false; error: string };
export const historyImportSnapshot = (state: AppState) => financeHistoryFingerprint(financeHistoryState(state));

/** Translate explicit cross-context intents into the existing revisioned project write. */
export const applyFinanceHistoryResult = (state: AppState, result: FinanceHistoryCommandResult): HistoryImportCommandResult => {
  if (!result.ok) return result;
  const counts = { added: result.added, updated: result.updated, skipped: result.skipped };
  if (!result.change) return { ok: true, change: null, ...counts };
  const change = result.change;
  if (change.projectId !== state.project.id || change.expected !== historyImportSnapshot(state)) {
    return { ok: false, error: 'Данные проекта обновились. Загрузите реестр заново и проверьте предпросмотр.' };
  }
  const updates = new Map(change.documentUpdates.map(update => [update.id, update]));
  const documents = state.documents.map(document => {
    const update = updates.get(document.id);
    if (!update) return document;
    // Import owns only these metadata changes, never file keys, visibility or the registry itself.
    return { ...document,
      ...(Object.hasOwn(update, 'documentDate') ? { documentDate: update.documentDate } : {}),
      ...(Object.hasOwn(update, 'number') ? { number: update.number } : {}),
      ...(Object.hasOwn(update, 'category') ? { category: update.category } : {}),
      ...(Object.hasOwn(update, 'counterpartyId') ? { counterpartyId: update.counterpartyId } : {}),
    };
  });
  return { ok: true, ...counts, change: { action: change.action, summary: change.summary, state: {
    ...state,
    budgetLines: change.patch.budgetLines ?? state.budgetLines,
    budgetMeta: change.patch.budgetMeta ?? state.budgetMeta,
    financeEntries: change.patch.financeEntries ?? state.financeEntries,
    project: change.targetCost === undefined ? state.project : { ...state.project, targetCost: change.targetCost },
    documents,
    counterparties: [...state.counterparties, ...change.counterpartyAdditions],
    activity: [change.event, ...state.activity],
  } } };
};

export const importProjectFinanceHistory = (state: AppState, input: HistoryImportCommand, context: FinanceCommandContext): HistoryImportCommandResult =>
  applyFinanceHistoryResult(state, importFinanceHistory(financeHistoryState(state), input, context));
