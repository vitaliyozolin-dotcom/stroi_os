import type { BudgetLineInput, CostClassificationInput, FinanceDueDateInput, FinancePlanningSnapshot } from '../domain/finance/index.js';
import type { FinanceCommandContext } from './finance-context';
import type { FinanceRepository, FinanceReadModel, FinanceMutation, FinanceFailure } from './finance-repository.ts';
import { editFinanceBudgetLine, classifyFinanceContextCosts, setFinanceContextDueDate, type FinancePlanningCommandResult } from './finance-context-planning.ts';
import { approveFinanceExpense, acceptFinanceExpense, recordFinancePayment, recordFinanceReceipt, type FinanceFactsSnapshot, type FinanceFactsCommandResult, type FactCommand } from './finance-context-facts.ts';
import { createFinanceCommitment, type CreateCommitmentInput, type FinanceCommitmentCommandResult } from './finance-context-commitment.js';
import { importFinanceHistory, type HistoryImportCommand, type FinanceHistoryCommandResult } from './finance-context-history.ts';

export type FinanceCommandResult = FinancePlanningCommandResult | FinanceFactsCommandResult | FinanceCommitmentCommandResult | FinanceHistoryCommandResult;
export type { FinanceCommandContext } from './finance-context';

const planningSnapshot = (state: FinanceReadModel): FinancePlanningSnapshot => ({
  projectId: state.project.id, budgetLines: state.budgetLines, budgetMeta: state.budgetMeta, financeEntries: state.financeEntries,
});
const factsSnapshot = (state: FinanceReadModel): FinanceFactsSnapshot => ({
  ...planningSnapshot(state), projectCode: state.project.code, procurement: state.procurement, checkpoints: state.checkpoints, stages: state.stages,
});

/** Financial workflows depend only on the scoped repository, never the project write contract. */
export const createFinanceUseCases = (repository: FinanceRepository, context: FinanceCommandContext) => {
  const execute = <R extends FinanceCommandResult>(command: (state: FinanceReadModel) => R): R | FinanceFailure => {
    const read = repository.read();
    return read.ok ? command(read.snapshot) : read;
  };
  const commit = <R extends FinanceCommandResult>(result: R, mutation: FinanceMutation | null): R | FinanceFailure => {
    if (!mutation) return result;
    const committed = repository.commit(mutation);
    return committed.ok ? result : committed;
  };
  const plan = (command: (state: FinancePlanningSnapshot) => FinancePlanningCommandResult) => execute(state => {
    const result = command(planningSnapshot(state));
    return commit(result, result.ok && result.change ? { kind: 'planning', change: result.change } : null);
  });
  const fact = (command: (state: FinanceFactsSnapshot) => FinanceFactsCommandResult) => execute(state => {
    const result = command(factsSnapshot(state));
    return commit(result, result.ok && result.change ? { kind: 'facts', change: result.change } : null);
  });
  return {
    importHistory: (input: HistoryImportCommand) => execute(state => {
      const result = importFinanceHistory(state, input, context);
      return commit(result, result.ok && result.change ? { kind: 'history', change: result.change } : null);
    }),
    updateBudgetLine: (input: BudgetLineInput) => plan(state => editFinanceBudgetLine(state, input, context)),
    classifyCosts: (input: CostClassificationInput) => plan(state => classifyFinanceContextCosts(state, input, context)),
    setDueDate: (input: FinanceDueDateInput) => plan(state => setFinanceContextDueDate(state, input, context)),
    createCommitment: (input: CreateCommitmentInput) => execute(state => {
      const result = createFinanceCommitment({ ...planningSnapshot(state), counterparties: state.counterparties, stages: state.stages }, input, context);
      return commit(result, result.ok && result.change ? { kind: 'commitment', change: result.change, entryId: result.entryId } : null);
    }),
    approveExpense: (entryId: string) => fact(state => approveFinanceExpense(state, entryId, context)),
    acceptExpense: (input: FactCommand) => fact(state => acceptFinanceExpense(state, input, context)),
    recordPayment: (input: FactCommand) => fact(state => recordFinancePayment(state, input, context)),
    recordReceipt: (input: FactCommand) => fact(state => recordFinanceReceipt(state, input, context)),
  };
};
