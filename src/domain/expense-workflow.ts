import type { AppState, FinanceEntry } from '../entities/index';
import { acceptedAmountFor, paidAmountFor } from './finance.ts';

export const financeMoney = (value: number) => Math.round(value * 100) / 100;

export const needsExpenseApproval = (entry: FinanceEntry) => entry.kind === 'expense' && !entry.approvedAt && acceptedAmountFor(entry) === 0 && paidAmountFor(entry) === 0;

export const expenseAcceptanceSources = (state: AppState, entry: FinanceEntry) => {
  if (!entry.stageId) return [];
  const supplies = state.procurement.filter((item) => item.stageId === entry.stageId
    && (entry.procurementItemId ? item.id === entry.procurementItemId : Boolean(entry.counterpartyId && item.supplierId === entry.counterpartyId))
    && (!entry.counterpartyId || !item.supplierId || item.supplierId === entry.counterpartyId)
    && ['accepted', 'issued'].includes(item.status))
    .map((item) => ({ id: `procurement:${item.id}`, label: `Поставка: ${item.item}` }));
  if (entry.procurementItemId) return supplies;
  return [...supplies,
    ...state.checkpoints.filter((item) => item.stageId === entry.stageId && item.status === 'accepted').map((item) => ({ id: `checkpoint:${item.id}`, label: `Работа: ${item.title}` })),
    ...state.stages.filter((item) => item.id === entry.stageId && item.status === 'accepted').map((item) => ({ id: `stage:${item.id}`, label: `Принятый этап: ${item.name}` })),
  ];
};

export const financeActionError = (state: AppState, entry: FinanceEntry, kind: 'accept' | 'pay' | 'receive', amount: number, date: string, document: string, source: string) => {
  const limit = financeMoney(kind === 'accept' ? entry.amount - acceptedAmountFor(entry) : kind === 'pay' ? acceptedAmountFor(entry) - paidAmountFor(entry) : entry.amount - paidAmountFor(entry));
  if (!Number.isFinite(amount) || Math.abs(amount - financeMoney(amount)) > 0.000001 || amount <= 0 || amount > limit) return 'Укажите сумму больше нуля и не больше доступного остатка.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || !document.trim()) return 'Укажите фактическую дату и документ-основание.';
  if ((kind === 'receive') !== (entry.kind === 'income')) return 'Это действие недоступно для данной операции.';
  if (kind === 'accept' && needsExpenseApproval(entry)) return 'Сначала утвердите расход.';
  if (kind === 'accept' && !expenseAcceptanceSources(state, entry).some((item) => item.id === source)) return 'Сначала примите связанную работу или поставку и выберите её как основание.';
  return '';
};
