export type ExpenseStatus = 'committed' | 'accepted' | 'paid';

export interface BudgetMeta {
  version: string;
  source: string;
  importedAt?: string;
  approvedBy?: string;
  approvedAt?: string;
  note?: string;
}

export interface BudgetLine {
  id: string;
  stageIds: string[];
  name: string;
  plan: number;
  forecast: number;
}

export interface FinanceEntry {
  id: string;
  kind: 'expense' | 'income';
  status: ExpenseStatus;
  amount: number;
  date: string;
  stageId?: string;
  budgetLineId?: string;
  counterparty: string;
  counterpartyId?: string;
  description: string;
  document?: string;
  procurementItemId?: string;
  acceptedAmount?: number;
  acceptedAt?: string;
  acceptanceDocument?: string;
  paidAmount?: number;
  paidAt?: string;
  paymentDocument?: string;
}
