import type { ProjectDocument } from '../entities/index';
import { approveExpenseEntry, acceptExpenseEntry, recordPaymentEntry, recordReceiptEntry, type FinanceAcceptanceContext, type FinanceEntryResult, type FinanceFactInput, type FinancePlanningSnapshot } from '../domain/finance/index.js';
import type { FinanceCommandContext } from './finance-context';
import { financeOwnedSnapshot, type FinancePlanningChange } from './finance-context-planning.ts';

export interface FinanceFactsSnapshot extends FinancePlanningSnapshot, FinanceAcceptanceContext { projectCode: string }
export interface FinanceFactsChange extends FinancePlanningChange { expectedReferences: string; appendDocument?: ProjectDocument }
export type FinanceFactsCommandResult = { ok: true; change: FinanceFactsChange | null } | { ok: false; error: string };
export const financeAcceptanceSnapshot = (state: FinanceAcceptanceContext) => JSON.stringify([state.procurement, state.checkpoints, state.stages]);

export type FactCommand = FinanceFactInput & { entryId: string };
const missingEntry = (): FinanceFactsCommandResult => ({ ok: false, error: 'Финансовая операция не найдена. Обновите список.' });
const money = (value: number) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);

const finish = (state: FinanceFactsSnapshot, result: FinanceEntryResult, context: FinanceCommandContext, timestamp: string, action: string, summary: string, document?: ProjectDocument): FinanceFactsCommandResult => {
  if (!result.ok) return result;
  if (!result.changed) return { ok: true, change: null };
  return { ok: true, change: {
    projectId: state.projectId, expectedFinance: financeOwnedSnapshot(state),
    expectedReferences: financeAcceptanceSnapshot(state),
    action, summary,
    patch: { financeEntries: state.financeEntries.map(entry => entry.id === result.entry.id ? result.entry : entry) },
    appendDocument: document,
    event: { id: context.ids.next('activity'), timestamp, actor: context.identity.name, text: summary, tone: action === 'expense_accepted' ? 'neutral' : 'positive' },
  } };
};

export const approveFinanceExpense = (state: FinanceFactsSnapshot, entryId: string, context: FinanceCommandContext): FinanceFactsCommandResult => {
  const entry = state.financeEntries.find(item => item.id === entryId);
  if (!entry) return missingEntry();
  const timestamp = context.clock.now();
  return finish(state, approveExpenseEntry(entry, context.identity, timestamp), context, timestamp,
    'expense_approved', `Утверждён расход ${money(entry.amount)} · ${entry.description}`);
};

const recordFact = (state: FinanceFactsSnapshot, input: FactCommand, context: FinanceCommandContext, kind: 'accept' | 'pay' | 'receive'): FinanceFactsCommandResult => {
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
    storageLocation: `ИКИОМА ОС / ${state.projectCode} / Финансы`,
  };
  const action = kind === 'accept' ? 'expense_accepted' : kind === 'pay' ? 'payment_recorded' : 'income_received';
  const verb = kind === 'accept' ? 'принято' : kind === 'pay' ? 'оплачено' : 'получено';
  return finish(state, result, context, timestamp, action, `${entry.description}: ${verb} ${money(input.amount)}`, document);
};

export const acceptFinanceExpense = (state: FinanceFactsSnapshot, input: FactCommand, context: FinanceCommandContext) => recordFact(state, input, context, 'accept');
export const recordFinancePayment = (state: FinanceFactsSnapshot, input: FactCommand, context: FinanceCommandContext) => recordFact(state, input, context, 'pay');
export const recordFinanceReceipt = (state: FinanceFactsSnapshot, input: FactCommand, context: FinanceCommandContext) => recordFact(state, input, context, 'receive');

