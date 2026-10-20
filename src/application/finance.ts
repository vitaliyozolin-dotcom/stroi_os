import type { AppState } from '../entities/index';
import type { StateChange } from '../domain/change';
import {
  type FinanceActor,
} from '../domain/finance/index.js';
export type { FinanceCommandContext } from './finance-context';
import type { Clock, IdGenerator } from './ports';
import { commitStateChange, type StateChangeSink } from './state-change.ts';
import { createProjectCommitment, type CreateCommitmentInput } from './finance-commitment.js';
import { editProjectBudgetLine, classifyProjectCosts, setProjectPaymentDueDate } from './finance-planning.ts';
import type { BudgetLineInput, CostClassificationInput, FinanceDueDateInput } from '../domain/finance/index.js';
import { importProjectFinanceHistory, type HistoryImportCommand } from './finance-history.ts';

export type FinanceCommandResult = { ok: true; change: StateChange | null } | { ok: false; error: string };
import { approveProjectExpense, acceptProjectExpense, recordProjectPayment, recordProjectReceipt } from './finance-facts.ts';
export { approveProjectExpense, acceptProjectExpense, recordProjectPayment, recordProjectReceipt } from './finance-facts.ts';
import type { FactCommand } from './finance-context-facts.ts';

// The existing sync workflow owns repository writes, revisions, retries and conflicts.
export const createFinanceUseCases = (state: AppState, identity: FinanceActor, clock: Clock, ids: IdGenerator, sink: StateChangeSink) => {
  const context = { identity, clock, ids };
  const commit = <T extends FinanceCommandResult>(result: T): T => {
    if (result.ok && result.change) commitStateChange(result.change, sink);
    return result;
  };
  return {
    importHistory: (input: HistoryImportCommand) => commit(importProjectFinanceHistory(state, input, context)),
    updateBudgetLine: (input: BudgetLineInput) => commit(editProjectBudgetLine(state, input, context)),
    classifyCosts: (input: CostClassificationInput) => commit(classifyProjectCosts(state, input, context)),
    setDueDate: (input: FinanceDueDateInput) => commit(setProjectPaymentDueDate(state, input, context)),
    createCommitment: (input: CreateCommitmentInput) => commit(createProjectCommitment(state, input, context)),
    approveExpense: (entryId: string) => commit(approveProjectExpense(state, entryId, context)),
    acceptExpense: (input: FactCommand) => commit(acceptProjectExpense(state, input, context)),
    recordPayment: (input: FactCommand) => commit(recordProjectPayment(state, input, context)),
    recordReceipt: (input: FactCommand) => commit(recordProjectReceipt(state, input, context)),
  };
};
