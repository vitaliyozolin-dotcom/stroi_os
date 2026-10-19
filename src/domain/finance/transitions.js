import { acceptedAmountFor, paidAmountFor, lineTotals } from '../finance-totals.js';
import { financeActionError, financeMoney, needsExpenseApproval, validDate } from './policy.js';

const denied = () => ({ ok: false, error: 'Финансовые операции доступны только роли «Управление».' });

export const createCommitment = (state, input, identity) => {
  if (identity.role !== 'management') return denied();
  const existing = (state.financeEntries ?? []).find(entry => entry.id === input.id
    || input.sourceDraftId && entry.sourceDraftId === input.sourceDraftId);
  if (existing) {
    if (input.sourceDraftId && existing.sourceDraftId === input.sourceDraftId) return { ok: true, entry: existing, budgetLines: state.budgetLines, changed: false };
    return { ok: false, error: 'Финансовая операция с таким ID уже существует.' };
  }
  if (!input.id || !['expense', 'income'].includes(input.kind) || !Number.isFinite(input.amount)
    || input.amount <= 0 || Math.abs(input.amount - financeMoney(input.amount)) > 0.000001
    || typeof input.description !== 'string' || !input.description.trim()) return { ok: false, error: 'Укажите сумму с точностью до копеек и назначение операции.' };
  if (input.description.trim().length > 500) return { ok: false, error: 'Сократите назначение операции до 500 символов.' };
  if (!validDate(input.date)) return { ok: false, error: 'Укажите корректную дату операции.' };
  const counterparty = (state.counterparties ?? []).find(item => item.id === input.counterpartyId && item.status !== 'blocked');
  if (!counterparty) return { ok: false, error: 'Выберите доступного контрагента из справочника проекта.' };
  const line = (state.budgetLines ?? []).find(item => item.id === input.budgetLineId);
  if (input.kind === 'expense' && (!line || !line.stageIds?.includes(input.stageId)
    || !(state.stages ?? []).some(stage => stage.id === input.stageId))) return { ok: false, error: 'Выберите статью бюджета и связанный с ней этап проекта.' };
  const entry = {
    id: input.id, kind: input.kind, status: 'committed', createdBy: identity.name,
    amount: input.amount, date: input.date, counterparty: counterparty.name, counterpartyId: counterparty.id,
    description: input.description.trim(),
    ...(input.kind === 'expense' ? { budgetLineId: line.id, stageId: input.stageId } : {}),
    ...(input.sourceDraftId ? { sourceDraftId: input.sourceDraftId } : {}),
  };
  const budgetLines = input.kind === 'expense' ? state.budgetLines.map(item => item.id === line.id
    ? { ...item, forecast: Math.max(Number(item.forecast) || 0, financeMoney(lineTotals(state, line).committed + input.amount)) }
    : item) : state.budgetLines;
  return { ok: true, entry, budgetLines, changed: true };
};

export const approveExpenseEntry = (entry, identity, timestamp) => {
  if (identity.role !== 'management') return denied();
  if (entry.kind !== 'expense') return { ok: false, error: 'Утверждение предусмотрено только для расходов.' };
  if (!needsExpenseApproval(entry)) return { ok: true, entry, changed: false };
  return { ok: true, changed: true, entry: { ...entry, approvedAt: timestamp, approvedBy: identity.name } };
};

const recordAction = (state, entry, input, identity, kind) => {
  if (identity.role !== 'management') return denied();
  if (entry.historicalPayment) return { ok: false, error: 'Историческую оплату нельзя переписывать. Сохраните исходную запись.' };
  const error = financeActionError(state, entry, kind, input.amount, input.date, input.document, input.source ?? '');
  if (error) return { ok: false, error };
  if (kind === 'accept') {
    return { ok: true, changed: true, entry: {
      ...entry, status: 'accepted',
      acceptedAmount: financeMoney(acceptedAmountFor(entry) + input.amount),
      acceptedAt: input.date, acceptedBy: identity.name,
      acceptanceSource: input.source, acceptanceDocument: input.document.trim(), document: input.document.trim(),
    } };
  }
  const paidAmount = financeMoney(paidAmountFor(entry) + input.amount);
  // Payment events are stamped by validateFinanceChanges at the trusted write boundary.
  // The client candidate retains the existing server-owned ledger unchanged.
  return { ok: true, changed: true, entry: {
    ...entry, status: paidAmount >= entry.amount ? 'paid' : entry.status,
    paidAmount, paidAt: input.date, paidBy: identity.name, paymentDocument: input.document.trim(),
  } };
};

export const acceptExpenseEntry = (state, entry, input, identity) => recordAction(state, entry, input, identity, 'accept');
export const recordPaymentEntry = (state, entry, input, identity) => recordAction(state, entry, input, identity, 'pay');
export const recordReceiptEntry = (state, entry, input, identity) => recordAction(state, entry, input, identity, 'receive');
