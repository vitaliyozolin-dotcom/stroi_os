export type ExpenseStatus = 'committed' | 'accepted' | 'paid';
export type CostGroup = 'construction' | 'overhead' | 'reserve' | 'unallocated';
export interface CostClassification {
  costGroup?: CostGroup;
  costGroupHistory?: { group: CostGroup | null; at: string; by: string }[];
}

export interface BudgetMeta {
  importSourceSha256?: string;
  importPreviousBudget?: { lines: BudgetLine[]; meta: BudgetMeta; targetCost: number; recordedAt: string };
  version: string;
  source: string;
  importedAt?: string;
  approvedBy?: string;
  approvedAt?: string;
  note?: string;
}

export interface BudgetLine extends CostClassification {
  sourcePlan?: number;
  outsideSourceTotal?: boolean;
  sourceRow?: number;
  sourceFact?: number;
  sourceParticipantAmounts?: Record<string, number | null>;
  id: string;
  stageIds: string[];
  name: string;
  plan: number;
  forecast: number;
}

export interface FinanceEntry extends CostClassification {
  payments?: { id: string; amount: number; date: string; document: string; recordedAt: string; recordedBy: string }[];
  legacyPayment?: { amount: number; lastRecordedDate?: string; document?: string };
  budgetAllocation?: { at: string; by: string; budgetLineId: string };
  historicalPayment?: { existingOperation?: boolean; sourceDocumentId: string; sourceUniqueKey: string; sourceSha256: string; confirmation: string; sourceDate: string; recordedAt: string; recordedBy: string };
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
  createdBy?: string;
  approvedBy?: string;
  approvedAt?: string;
  acceptedBy?: string;
  acceptanceSource?: string;
  paidBy?: string;
  acceptedAmount?: number;
  acceptedAt?: string;
  acceptanceDocument?: string;
  paidAmount?: number;
  paidAt?: string;
  paymentDocument?: string;
}
