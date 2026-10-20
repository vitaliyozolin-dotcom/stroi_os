import { createFinanceCommitment, financeCommitmentFingerprint } from '../application/finance-context-commitment.js';

export const financeCommitmentSnapshot = (state) => ({
  projectId: state.project.id, budgetLines: state.budgetLines, budgetMeta: state.budgetMeta,
  financeEntries: state.financeEntries, counterparties: state.counterparties, stages: state.stages,
});

// Compatibility adapter used by both UI and Telegram; only finance-owned fields can be replaced.
export const applyFinanceCommitmentResult = (state, result) => {
  if (!result.ok) return result;
  if (!result.change) return { ok: true, entryId: result.entryId, change: null };
  const change = result.change;
  if (change.projectId !== state.project.id || change.expected !== financeCommitmentFingerprint(financeCommitmentSnapshot(state))) {
    return { ok: false, error: 'Финансовые данные или связи проекта обновились. Повторите действие на свежих данных.' };
  }
  return { ok: true, entryId: result.entryId, change: {
    action: change.action, summary: change.summary,
    state: {
      ...state, budgetLines: change.patch.budgetLines ?? state.budgetLines,
      financeEntries: change.patch.financeEntries ?? state.financeEntries,
      activity: [change.event, ...(state.activity ?? [])],
    },
  } };
};

export const createProjectCommitment = (state, input, context) =>
  applyFinanceCommitmentResult(state, createFinanceCommitment(financeCommitmentSnapshot(state), input, context));
