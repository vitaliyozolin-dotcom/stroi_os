import { acceptedAmountFor, paidAmountFor } from '../finance-totals.js';
import { financeActionError, financeMoney, needsExpenseApproval } from './policy.js';

const denied = () => ({ ok: false, error: 'Финансовые операции доступны только роли «Управление».' });

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
