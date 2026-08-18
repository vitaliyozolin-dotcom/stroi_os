export type ProcurementStatus =
  | 'need'
  | 'rfq'
  | 'ordered'
  | 'in_transit'
  | 'delivered'
  | 'accepted'
  | 'issued';

export interface ProcurementItem {
  id: string;
  stageId: string;
  item: string;
  quantity: number;
  unit: string;
  neededBy: string;
  status: ProcurementStatus;
  budget: number;
  supplier: string;
  supplierId?: string;
  owner: string;
  risk?: string;
  budgetLineId?: string;
  reason?: string;
  deliveryAddress?: string;
  warehouse?: string;
  orderedAt?: string;
  deliveredAt?: string;
}

export type QuoteStatus = 'received' | 'selected' | 'rejected';

export interface SupplierQuote {
  id: string;
  procurementItemId: string;
  supplier: string;
  supplierId?: string;
  amount: number;
  deliveryDays: number;
  paymentTerms: string;
  source: string;
  validUntil?: string;
  status: QuoteStatus;
  comment?: string;
}
