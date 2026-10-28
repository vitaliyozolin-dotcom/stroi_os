/** Project-local immutable financial journal. It supplements, never rewrites, legacy payment facts. */
export type LedgerOperationKind = 'payment' | 'receipt' | 'supplier_refund' | 'customer_refund' | 'offset' | 'loan_drawdown' | 'loan_repayment' | 'interest' | 'transfer';
export type LedgerConfirmation = 'claimed' | 'confirmed' | 'reconciled';
export interface LedgerAllocation { entryId: string; trancheId?: string; retentionId?: string; amountCents: number }
export interface LegacyPaymentLink { entryId: string; paymentId: string }
export interface LedgerOperation {
  id: string; kind: LedgerOperationKind; date: string; amountCents: number;
  accountId?: string; toAccountId?: string; counterparty: string; description: string; source: string;
  confirmation: LedgerConfirmation; cashTreatment?: 'account' | 'participant_direct'; allocations: LedgerAllocation[];
  loanId?: string; scheduleItemId?: string;
  refundOfOperationId?: string; refundOfLegacyPayment?: LegacyPaymentLink;
  /** Import reconciliation of the SAME legacy movement. No new cash or settlement. */
  legacyPayment?: LegacyPaymentLink;
  sourceKey?: string; documentId?: string; documentIds?: string[]; recordedAt?: string; recordedBy?: string;
}
export interface LedgerAllocationEvent {
  id: string; operationId: string; allocations: LedgerAllocation[]; source: string; recordedAt?: string; recordedBy?: string;
}
/** Confirmation is append-only; the original operation and its initial assertion stay immutable. */
export interface LedgerConfirmationEvent {
  id: string; operationId: string; confirmation: 'confirmed' | 'reconciled'; source: string;
  sourceKey?: string; bankDate?: string; bankAccountId?: string; recordedAt?: string; recordedBy?: string;
}
export type PaymentRequestStatus = 'draft' | 'submitted' | 'approved' | 'scheduled' | 'executing' | 'partially_paid' | 'paid' | 'rejected' | 'canceled';
export interface LedgerPaymentRequest {
  id: string; entryId: string; trancheId?: string; amountCents: number; requestedDate: string;
  desiredDate: string; accountId?: string; purpose: string; source: string; status: PaymentRequestStatus;
  operationId?: string; paymentAllocations?: { operationId: string; amountCents: number }[]; documentId?: string; documentIds?: string[]; createdAt?: string; createdBy?: string; updatedAt?: string; updatedBy?: string;
}
export interface LedgerRetention {
  id: string; entryId: string; trancheId?: string; amountCents: number;
  releaseDate?: string; status: 'held' | 'released' | 'canceled'; source: string; documentId?: string; documentIds?: string[];
  createdAt?: string; createdBy?: string; updatedAt?: string; updatedBy?: string;
}
export interface LedgerLoanScheduleItem { id: string; kind: 'drawdown' | 'principal' | 'interest'; date: string; amountCents: number; entryId?: string; trancheId?: string }
export interface LedgerLoan {
  id: string; name: string; counterparty: string; direction: 'borrowed' | 'lent'; accountId: string;
  principalCents: number; openingPrincipalCents?: number; openingDate?: string; source: string;
  status: 'draft' | 'active' | 'closed'; schedule: LedgerLoanScheduleItem[]; documentId?: string; documentIds?: string[];
  createdAt?: string; createdBy?: string; updatedAt?: string; updatedBy?: string;
}
export interface LedgerHistoryEvent { id: string; at: string; by: string; reason: string; changes: { field: string; before: unknown; after: unknown }[] }
export interface FinanceLedgerState {
  version: 1; operations: LedgerOperation[]; confirmations: LedgerConfirmationEvent[]; allocationEvents?: LedgerAllocationEvent[];
  requests: LedgerPaymentRequest[]; retentions: LedgerRetention[]; loans: LedgerLoan[];
  changeReason?: string; history?: LedgerHistoryEvent[];
}
