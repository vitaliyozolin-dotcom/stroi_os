// Characterization harness: exercise the production scoped use cases/repository and
// expose the staged project for existing assertions. No project facade ships with the module.
import type { AppState } from '../../src/entities/index.ts';
import type { StateChange } from '../../src/domain/change.ts';
import type { Clock, IdGenerator } from '../../src/application/ports.ts';
import type { FinanceActor } from '../../src/domain/finance/index.js';
import type { FinanceCommandContext } from '../../src/application/finance-context.ts';
import type { StateChangeSink } from '../../src/application/state-change.ts';
import { createFinanceUseCases as createScopedUseCases, type FinanceCommandResult as ScopedResult } from '../../src/application/finance.ts';
import { createProjectFinanceRepository } from '../../src/infrastructure/finance-project.ts';
import type { BudgetLineInput, CostClassificationInput, FinanceDueDateInput } from '../../src/domain/finance/index.js';
import type { FactCommand } from '../../src/application/finance-context-facts.ts';
import type { HistoryImportCommand } from '../../src/application/finance-context-history.ts';
import type { CreateCommitmentInput } from '../../src/application/finance-context-commitment.js';

export type FinanceCommandResult = { ok: true; change: StateChange | null } | { ok: false; error: string };
export const createFinanceUseCases = (initial: AppState, identity: FinanceActor, clock: Clock, ids: IdGenerator, sink: StateChangeSink = () => {}) => {
  let current = initial;
  let staged: StateChange | null = null;
  const repository = createProjectFinanceRepository(() => current, (state, metadata) => {
    staged = { state, action: metadata!.action, summary: metadata!.summary };
    current = state;
    sink(state, metadata);
  });
  const commands = createScopedUseCases(repository, { identity, clock, ids });
  const run = <R extends ScopedResult>(command: () => R) => {
    staged = null;
    const result = command();
    return result.ok ? { ...result, change: staged as StateChange | null } : result;
  };
  return {
    approveExpense: (id: string) => run(() => commands.approveExpense(id)),
    acceptExpense: (input: FactCommand) => run(() => commands.acceptExpense(input)),
    recordPayment: (input: FactCommand) => run(() => commands.recordPayment(input)),
    recordReceipt: (input: FactCommand) => run(() => commands.recordReceipt(input)),
    updateBudgetLine: (input: BudgetLineInput) => run(() => commands.updateBudgetLine(input)),
    classifyCosts: (input: CostClassificationInput) => run(() => commands.classifyCosts(input)),
    setDueDate: (input: FinanceDueDateInput) => run(() => commands.setDueDate(input)),
    createCommitment: (input: CreateCommitmentInput) => run(() => commands.createCommitment(input)),
    importHistory: (input: HistoryImportCommand) => run(() => commands.importHistory(input)),
  };
};
const commands = (state: AppState, context: FinanceCommandContext) => createFinanceUseCases(state, context.identity, context.clock, context.ids);
export const approveProjectExpense = (state: AppState, id: string, context: FinanceCommandContext) => commands(state, context).approveExpense(id);
export const acceptProjectExpense = (state: AppState, input: FactCommand, context: FinanceCommandContext) => commands(state, context).acceptExpense(input);
export const recordProjectPayment = (state: AppState, input: FactCommand, context: FinanceCommandContext) => commands(state, context).recordPayment(input);
export const recordProjectReceipt = (state: AppState, input: FactCommand, context: FinanceCommandContext) => commands(state, context).recordReceipt(input);
export const editProjectBudgetLine = (state: AppState, input: BudgetLineInput, context: FinanceCommandContext) => commands(state, context).updateBudgetLine(input);
export const classifyProjectCosts = (state: AppState, input: CostClassificationInput, context: FinanceCommandContext) => commands(state, context).classifyCosts(input);
export const setProjectPaymentDueDate = (state: AppState, input: FinanceDueDateInput, context: FinanceCommandContext) => commands(state, context).setDueDate(input);
export const importProjectFinanceHistory = (state: AppState, input: HistoryImportCommand, context: FinanceCommandContext) => commands(state, context).importHistory(input);
