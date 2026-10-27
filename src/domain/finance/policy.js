import { acceptedAmountFor, paidAmountFor } from '../finance-totals.js';

export const financeMoney = (value) => Math.round(value * 100) / 100;

export const needsExpenseApproval = (entry) => entry.kind === 'expense' && !entry.approvedAt && acceptedAmountFor(entry) === 0 && paidAmountFor(entry) === 0;

export const expenseAcceptanceSources = (state, entry) => {
  if (!entry.stageId) return [];
  const supplies = (state.procurement ?? []).filter((item) => item.stageId === entry.stageId
    && (entry.procurementItemId ? item.id === entry.procurementItemId : Boolean(entry.counterpartyId && item.supplierId === entry.counterpartyId))
    && (!entry.counterpartyId || !item.supplierId || item.supplierId === entry.counterpartyId)
    && ['accepted', 'issued'].includes(item.status))
    .map((item) => ({ id: `procurement:${item.id}`, label: `Поставка: ${item.item}` }));
  if (entry.procurementItemId) return supplies;
  return [...supplies,
    ...(state.checkpoints ?? []).filter((item) => item.stageId === entry.stageId && item.status === 'accepted').map((item) => ({ id: `checkpoint:${item.id}`, label: `Работа: ${item.title}` })),
    ...(state.stages ?? []).filter((item) => item.id === entry.stageId && item.status === 'accepted').map((item) => ({ id: `stage:${item.id}`, label: `Принятый этап: ${item.name}` })),
  ];
};

export const financeActionError = (state, entry, kind, amount, date, document, source) => {
  const limit = financeMoney(kind === 'accept' ? entry.amount - acceptedAmountFor(entry) : entry.amount - paidAmountFor(entry));
  if (!Number.isFinite(amount) || !Number.isSafeInteger(Math.round(amount * 100)) || Math.abs(amount - financeMoney(amount)) > 0.000001 || amount <= 0 || amount > limit) return 'Укажите сумму больше нуля и не больше доступного остатка.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || !document.trim()) return 'Укажите фактическую дату и документ-основание.';
  if ((kind === 'receive') !== (entry.kind === 'income')) return 'Это действие недоступно для данной операции.';
  if (['accept', 'pay'].includes(kind) && needsExpenseApproval(entry)) return 'Сначала утвердите расход.';
  if (kind === 'accept' && !expenseAcceptanceSources(state, entry).some((item) => item.id === source)) return 'Сначала примите связанную работу или поставку и выберите её как основание.';
  return '';
};

export const cents = (value) => Math.round(value * 100);
// Raw values must remain available to the trusted validator so NaN/Infinity are rejected.
export const recordedAcceptedAmount = (entry) => entry?.acceptedAmount ?? (['accepted', 'paid'].includes(entry?.status) ? entry.amount : 0);
export const recordedPaidAmount = (entry) => entry?.paidAmount ?? (entry?.status === 'paid' ? entry.amount : 0);
export const text = (value) => typeof value === 'string' && value.trim().length > 0;
export const validDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export const hasFinanceAcceptanceSource = (state, entry) => expenseAcceptanceSources(state, entry).some(source => source.id === entry.acceptanceSource);
