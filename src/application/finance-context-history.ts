import type { ActivityEvent, ProjectDocument, CounterpartyProfile } from '../entities/index';
import type { FinanceHistorySnapshot, FinancePatch } from '../domain/finance/index.js';
import { validateFinanceChanges } from '../domain/finance/index.js';
import { parseHistoryRegister, prepareFinanceHistoryImport } from '../domain/finance/history-import.ts';
import type { FinanceCommandContext } from './finance-context';

export interface HistoryImportCommand { register: unknown; includeBudget: boolean; confirmed: boolean; expected: string }
export interface HistoryImportCounts { added: number; updated: number; skipped: number }
export type HistoryDocumentUpdate = Pick<ProjectDocument, 'id'> & Partial<Pick<ProjectDocument, 'documentDate' | 'number' | 'category' | 'counterpartyId'>>;
export interface FinanceHistoryChange {
  projectId: string;
  expected: string;
  action: string;
  summary: string;
  patch: FinancePatch;
  targetCost?: number;
  documentUpdates: HistoryDocumentUpdate[];
  counterpartyAdditions: CounterpartyProfile[];
  event: ActivityEvent;
}
export type FinanceHistoryCommandResult = ({ ok: true; change: FinanceHistoryChange | null } & HistoryImportCounts) | { ok: false; error: string };

// Deliberately excludes tasks, comments, project presentation and unrelated construction details.
export const financeHistoryFingerprint = (state: FinanceHistorySnapshot) => JSON.stringify([
  state.project.id, state.project.targetCost, state.budgetLines, state.budgetMeta,
  state.financeEntries, state.documents, state.counterparties, state.stages.map(stage => stage.id),
]);

export const importFinanceHistory = (state: FinanceHistorySnapshot, input: HistoryImportCommand, context: FinanceCommandContext): FinanceHistoryCommandResult => {
  if (context.identity.role !== 'management') return { ok: false, error: 'Импорт финансов доступен только роли «Управление».' };
  if (input.confirmed !== true) return { ok: false, error: 'Подтвердите, что перечисленные расходы уже оплачены. Приёмка фиксируется отдельно.' };
  if (typeof input.includeBudget !== 'boolean') return { ok: false, error: 'Укажите, нужно ли вносить смету.' };
  if (input.expected !== financeHistoryFingerprint(state)) return { ok: false, error: 'Данные проекта обновились. Загрузите реестр заново и проверьте предпросмотр.' };
  try {
    const now = context.clock.now();
    const result = prepareFinanceHistoryImport(state, parseHistoryRegister(input.register), context.identity.name, now, input.includeBudget);
    const counts = { added: result.added, updated: result.updated, skipped: result.skipped };
    const candidate: FinanceHistorySnapshot = { ...state, ...result.patch,
      project: { ...state.project, targetCost: result.targetCost }, documents: result.documents, counterparties: result.counterparties,
    };
    if (financeHistoryFingerprint(candidate) === financeHistoryFingerprint(state)) return { ok: true, change: null, ...counts };
    // Check a disposable copy; trusted payment stamps still belong to the server.
    const error = validateFinanceChanges(state, structuredClone(candidate), context.identity, now);
    if (error) return { ok: false, error };
    const summary = result.event?.text ?? 'Уточнены сведения документов исторического импорта';
    const documentUpdates: HistoryDocumentUpdate[] = [];
    for (const document of result.documents) {
      const previous = state.documents.find(item => item.id === document.id);
      if (!previous) continue;
      const update: HistoryDocumentUpdate = { id: document.id };
      if (document.documentDate !== previous.documentDate) update.documentDate = document.documentDate;
      if (document.number !== previous.number) update.number = document.number;
      if (document.category !== previous.category) update.category = document.category;
      if (document.counterpartyId !== previous.counterpartyId) update.counterpartyId = document.counterpartyId;
      if (Object.keys(update).length > 1) documentUpdates.push(update);
    }
    return { ok: true, ...counts, change: {
      projectId: state.project.id, expected: financeHistoryFingerprint(state),
      action: 'finance_history_imported', summary, patch: result.patch,
      targetCost: result.targetCost !== state.project.targetCost ? result.targetCost : undefined,
      documentUpdates, counterpartyAdditions: result.counterparties.filter(item => !state.counterparties.some(previous => previous.id === item.id)),
      event: { id: context.ids.next('history-import'), actor: context.identity.name, timestamp: now, text: summary, tone: 'neutral' },
    } };
  } catch (failure) {
    return { ok: false, error: failure instanceof Error ? failure.message : 'Импорт не выполнен.' };
  }
};
