import { createCommitment } from '../domain/finance/index.js';

// Shared by the UI and Telegram; persistence and retry orchestration stay in adapters.
export const createProjectCommitment = (state, input, context) => {
  const result = createCommitment(state, { ...input, id: input.id ?? context.ids.next('finance') }, context.identity);
  if (!result.ok) return result;
  if (!result.changed) return { ok: true, entryId: result.entry.id, change: null };
  const timestamp = context.clock.now();
  const summary = `${result.entry.kind === 'expense' ? 'Добавлен расход' : 'Добавлено поступление'} ${new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(result.entry.amount)} · ${result.entry.description}`;
  return { ok: true, entryId: result.entry.id, change: {
    action: result.entry.kind === 'expense' ? 'expense_committed' : 'income_planned', summary,
    state: {
      ...state, budgetLines: result.budgetLines,
      financeEntries: [result.entry, ...(state.financeEntries ?? [])],
      activity: [{ id: context.ids.next('activity'), timestamp, actor: context.identity.name, text: summary, tone: 'neutral' }, ...(state.activity ?? [])],
    },
  } };
};
