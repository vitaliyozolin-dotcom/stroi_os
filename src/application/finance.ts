import type { AppState, ProjectDocument } from '../entities/index';
import type { StateChange } from '../domain/change';
import {
  approveExpenseEntry, acceptExpenseEntry, recordPaymentEntry, recordReceiptEntry,
  type FinanceActor, type FinanceEntryResult, type FinanceFactInput,
} from '../domain/finance/index.js';
import type { Clock, IdGenerator } from './ports';
import { commitStateChange, type StateChangeSink } from './state-change.ts';
import { createProjectCommitment, type CreateCommitmentInput } from './finance-commitment.js';
import { editProjectBudgetLine, classifyProjectCosts, setProjectPaymentDueDate } from './finance-planning.ts';
import type { BudgetLineInput, CostClassificationInput, FinanceDueDateInput } from '../domain/finance/index.js';
import { importProjectFinanceHistory, type HistoryImportCommand } from './finance-history.ts';

export type FinanceCommandResult = { ok: true; change: StateChange | null } | { ok: false; error: string };
type FactCommand = FinanceFactInput & { entryId: string };
export interface FinanceCommandContext { identity: FinanceActor; clock: Clock; ids: IdGenerator }
const missingEntry = (): FinanceCommandResult => ({ ok: false, error: 'Финансовая операция не найдена. Обновите список.' });
const money = (value: number) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);

const finish = (state: AppState, result: FinanceEntryResult, context: FinanceCommandContext, timestamp: string, action: string, summary: string, document?: ProjectDocument): FinanceCommandResult => {
  if (!result.ok) return result;
  if (!result.changed) return { ok: true, change: null };
  return { ok: true, change: {
    action, summary,
    state: {
      ...state,
      financeEntries: state.financeEntries.map(entry => entry.id === result.entry.id ? result.entry : entry),
      documents: document ? [document, ...state.documents] : state.documents,
      activity: [{ id: context.ids.next('activity'), timestamp, actor: context.identity.name, text: summary, tone: action === 'expense_accepted' ? 'neutral' : 'positive' }, ...state.activity],
    },
  } };
};

export const approveProjectExpense = (state: AppState, entryId: string, context: FinanceCommandContext): FinanceCommandResult => {
  const entry = state.financeEntries.find(item => item.id === entryId);
  if (!entry) return missingEntry();
  const timestamp = context.clock.now();
  return finish(state, approveExpenseEntry(entry, context.identity, timestamp), context, timestamp,
    'expense_approved', `Утверждён расход ${money(entry.amount)} · ${entry.description}`);
};

const recordFact = (state: AppState, input: FactCommand, context: FinanceCommandContext, kind: 'accept' | 'pay' | 'receive'): FinanceCommandResult => {
  const entry = state.financeEntries.find(item => item.id === input.entryId);
  if (!entry) return missingEntry();
  const transition = kind === 'accept' ? acceptExpenseEntry : kind === 'pay' ? recordPaymentEntry : recordReceiptEntry;
  const result = transition(state, entry, input, context.identity);
  if (!result.ok) return result;
  const timestamp = context.clock.now();
  const document: ProjectDocument = {
    id: context.ids.next('document'), name: input.document.trim(),
    type: kind === 'accept' ? 'Акт / приёмка' : 'Платёжный документ', category: kind === 'accept' ? 'act' : 'other',
    documentDate: input.date, updatedAt: timestamp, clientVisible: false, status: 'current',
    direction: kind === 'accept' ? 'incoming' : 'outgoing', counterpartyId: entry.counterpartyId,
    stageId: entry.stageId, financeEntryId: entry.id,
    receivedAt: kind === 'accept' ? timestamp : undefined, sentAt: kind === 'accept' ? undefined : timestamp,
    storageLocation: `ИКИОМА ОС / ${state.project.code} / Финансы`,
  };
  const action = kind === 'accept' ? 'expense_accepted' : kind === 'pay' ? 'payment_recorded' : 'income_received';
  const verb = kind === 'accept' ? 'принято' : kind === 'pay' ? 'оплачено' : 'получено';
  return finish(state, result, context, timestamp, action, `${entry.description}: ${verb} ${money(input.amount)}`, document);
};

export const acceptProjectExpense = (state: AppState, input: FactCommand, context: FinanceCommandContext) => recordFact(state, input, context, 'accept');
export const recordProjectPayment = (state: AppState, input: FactCommand, context: FinanceCommandContext) => recordFact(state, input, context, 'pay');
export const recordProjectReceipt = (state: AppState, input: FactCommand, context: FinanceCommandContext) => recordFact(state, input, context, 'receive');

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
