export interface FundingEvidence {
  amountCents: number;
  date: string;
  source: string;
  documentId?: string;
}
export interface ProjectFundingRecord {
  route: 'unknown' | 'direct' | 'escrow';
  bank?: string;
  escrowAccountId?: string;
  escrowAccountReference?: string;
  escrow?: Partial<Record<'planned' | 'deposited' | 'released' | 'received', FundingEvidence>>;
  contractor?: {
    kind: 'unknown' | 'own' | 'loan' | 'partner' | 'customer_direct' | 'mixed';
    confirmed: boolean;
    amountCents?: number;
    date?: string;
    source?: string;
    documentId?: string;
  };
}
export interface ProjectFunding extends ProjectFundingRecord {
  changeReason: string;
  recordedAt?: string;
  recordedBy?: string;
  history?: Array<{ at: string; by: string; reason: string; record: ProjectFundingRecord }>;
}
