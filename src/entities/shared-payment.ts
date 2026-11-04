import type { LedgerOperation } from './finance-ledger';
export interface SharedPaymentAllocation { projectId: string; accountId?: string; entryId?: string; trancheId?: string; retentionId?: string; amountCents: number }
export interface SharedPaymentInput {
  id: string; sourceKey: string; sourceReference?: string; kind: 'payment' | 'receipt'; date: string; amountCents: number; currency: 'RUB';
  legalEntityId: string; sharedAccountKey?: string; payer: string; payee: string; description: string; source: string;
  confirmation: 'confirmed' | 'reconciled'; cashTreatment?: 'account' | 'participant_direct';
  expected: { projectId: string; revision: number }[]; allocations: SharedPaymentAllocation[];
  bankEvidence?: { projectId: string; documentId: string; externalId: string; source: string };
}
export type SharedPaymentPrincipal = Omit<SharedPaymentInput, 'expected'>;
export interface SharedPaymentShare { projectId: string; accountId?: string; operationId: string; amountCents: number; operation: LedgerOperation }
export interface SharedPaymentRecord { version: 1; principal: SharedPaymentPrincipal; shares: SharedPaymentShare[]; createdAt: string; createdBy: string; bankDocumentFingerprint?: string }
export interface SharedPaymentProjectOption {
  projectId: string; projectName: string; revision: number; legalEntityIds: string[];
  accounts: { id: string; name: string; legalEntityId: string; sharedAccountKey: string }[];
  entries: { id: string; kind: 'expense' | 'income'; description: string; counterparty: string; remainingCents: number | null; payableCents: number | null;
    tranches: { id: string; amountCents: number; source: string }[]; retentions: { id: string; amountCents: number; status: string; trancheId?: string }[] }[];
  documents: { id: string; name: string }[];
}
export interface SharedPaymentWorkspace { projects: SharedPaymentProjectOption[]; payments: SharedPaymentRecord[] }
