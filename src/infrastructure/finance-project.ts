import type { AppState } from '../entities/index';
import type { StateChange } from '../domain/change';
import type { FinanceRepository, FinanceMutation, FinanceCommitResult } from '../application/finance-repository.ts';
import type { FinancePlanningSnapshot } from '../domain/finance/index.js';
import { financeOwnedSnapshot, type FinancePlanningCommandResult } from '../application/finance-context-planning.ts';
import { financeAcceptanceSnapshot, type FinanceFactsSnapshot, type FinanceFactsCommandResult } from '../application/finance-context-facts.ts';
import { financeHistoryFingerprint, type HistoryImportCounts, type FinanceHistoryCommandResult } from '../application/finance-context-history.ts';
import { financeHistoryState } from '../domain/finance/history-import.ts';
import { applyFinanceCommitmentResult } from './finance-commitment.js';
import { commitStateChange, type StateChangeSink } from '../application/state-change.ts';

export type ProjectFinanceCommandResult = { ok: true; change: StateChange | null } | { ok: false; error: string };

/** Compatibility adapter: storage still saves the revisioned whole-project snapshot. */
export const financePlanningSnapshot = (state: AppState): FinancePlanningSnapshot => ({ projectId: state.project.id, budgetLines: state.budgetLines, budgetMeta: state.budgetMeta, financeEntries: state.financeEntries });
export const applyFinancePlanningResult = (state: AppState, result: FinancePlanningCommandResult): ProjectFinanceCommandResult => {
  if (!result.ok) return result;
  if (!result.change) return { ok: true, change: null };
  const change = result.change;
  if (change.projectId !== state.project.id) return { ok: false, error: 'Проект изменился. Откройте финансовую форму заново.' };
  if (change.expectedFinance !== financeOwnedSnapshot(state)) return { ok: false, error: 'Финансовые данные обновились. Повторите действие на свежих данных.' };
  // Deliberate allowlist: a finance result cannot replace tasks, access, documents or other contexts.
  const patch = change.patch;
  return { ok: true, change: { action: change.action, summary: change.summary, state: {
    ...state,
    budgetLines: patch.budgetLines ?? state.budgetLines,
    budgetMeta: patch.budgetMeta ?? state.budgetMeta,
    financeEntries: patch.financeEntries ?? state.financeEntries,
    activity: [change.event, ...state.activity],
  } } };
};

export const financeFactsSnapshot = (state: AppState): FinanceFactsSnapshot => ({
  ...financePlanningSnapshot(state), projectCode: state.project.code,
  procurement: state.procurement, checkpoints: state.checkpoints, stages: state.stages, documents: state.documents, financeLedger: state.financeLedger, treasury: state.treasury,
});

/** Append a finance document without replacing the document registry or unrelated contexts. */
export const applyFinanceFactsResult = (state: AppState, result: FinanceFactsCommandResult): ProjectFinanceCommandResult => {
  if (!result.ok) return result;
  if (!result.change) return { ok: true, change: null };
  if (result.change.expectedReferences !== financeAcceptanceSnapshot(state)) return { ok: false, error: 'Основания приёмки обновились. Повторите действие на свежих данных.' };
  const reference = result.change.expectedDocument;
  if (reference && reference.value !== JSON.stringify(state.documents.find(document => document.id === reference.id))) return { ok: false, error: 'Документ-основание обновился. Выберите его заново.' };
  const applied = applyFinancePlanningResult(state, result);
  if (!applied.ok || !applied.change) return applied;
  const document = result.change.appendDocument;
  if (!document) return applied;
  if (result.change.attachmentOnly) {
    if (state.documents.some(item => item.financeEntryId === document.financeEntryId && item.fileKey === document.fileKey)) return { ok: true, change: null };
    if (state.documents.some(item => item.id === document.id)) return { ok: false, error: 'Документ с таким ID уже существует. Повторите прикрепление.' };
  }
  return { ok: true, change: { ...applied.change, state: { ...applied.change.state, documents: [document, ...state.documents] } } };
};

export type ProjectHistoryImportResult = ({ ok: true; change: StateChange | null } & HistoryImportCounts) | { ok: false; error: string };
export const historyImportSnapshot = (state: AppState) => financeHistoryFingerprint(financeHistoryState(state));

/** Translate explicit cross-context intents into the existing revisioned project write. */
export const applyFinanceHistoryResult = (state: AppState, result: FinanceHistoryCommandResult): ProjectHistoryImportResult => {
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

/** Bind once to a project; read the current draft again for every operation and commit.
 * The sink is the existing cache/sync workflow, which retains expectedRevision and conflicts. */
export const createProjectFinanceRepository = (readProject: () => AppState, stageProject: StateChangeSink): FinanceRepository => {
  const projectId = readProject().project.id;
  const switched = () => ({ ok: false as const, error: 'Проект изменился. Откройте финансовую форму заново.' });
  return {
    read: () => {
      const state = readProject();
      if (state.project.id !== projectId) return switched();
      return { ok: true, snapshot: { ...financeHistoryState(state), project: { id: state.project.id, code: state.project.code, targetCost: state.project.targetCost } } };
    },
    commit: (mutation: FinanceMutation): FinanceCommitResult => {
      const state = readProject();
      if (state.project.id !== projectId) return switched();
      const result = mutation.kind === 'planning' ? applyFinancePlanningResult(state, { ok: true, change: mutation.change })
        : mutation.kind === 'facts' ? applyFinanceFactsResult(state, { ok: true, change: mutation.change })
        : mutation.kind === 'commitment' ? applyFinanceCommitmentResult(state, { ok: true, entryId: mutation.entryId, change: mutation.change })
        : applyFinanceHistoryResult(state, { ok: true, added: 0, updated: 0, skipped: 0, change: mutation.change });
      if (!result.ok) return result;
      if (result.change) commitStateChange(result.change, stageProject);
      return { ok: true };
    },
  };
};
