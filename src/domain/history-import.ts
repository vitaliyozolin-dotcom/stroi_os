import type { AppState } from '../entities/index';
import { prepareFinanceHistoryImport, type HistoryRegister } from './finance/history-import.ts';
// Legacy whole-project facade; the financial domain itself accepts only its explicit read model.
export { parseHistoryRegister } from './finance/history-import.ts';
export type { HistoryRegister } from './finance/history-import.ts';

export const prepareHistoryImport = (current: AppState, input: HistoryRegister, actor: string, now: string, includeBudget: boolean) => {
  const result = prepareFinanceHistoryImport(current, input, actor, now, includeBudget);
  const next = structuredClone(current);
  Object.assign(next, result.patch);
  next.project.targetCost = result.targetCost;
  next.documents = result.documents;
  next.counterparties = result.counterparties;
  if (result.event) next.activity.unshift(result.event);
  return { state: next, added: result.added, updated: result.updated, skipped: result.skipped };
};
