import type { FinanceLedgerState, LedgerOperation, LedgerAllocation, LedgerConfirmation, FinanceEntry, TreasuryState } from '../entities/index';
export type { FinanceLedgerState, LedgerOperation, LedgerAllocation, LedgerConfirmation } from '../entities/index';
export interface LedgerProject {
  project?: { id: string };
  financeLedger?: FinanceLedgerState;
  financeEntries: Array<Pick<FinanceEntry, 'id' | 'kind' | 'amount'> & Partial<FinanceEntry>>;
  treasury?: TreasuryState;
  documents?: Array<{ id: string; fileKey?: string; clientVisible?: boolean }>;
}
export interface LedgerEntryBalance {
  committedCents: number | null; legacyPaidCents: number | null; ledgerSettledCents: number | null;
  cashSettledCents: number | null; nonCashSettledCents: number | null; settledCents: number | null;
  remainingCents: number | null; heldCents: number | null; payableCents: number | null; overpaidCents: number | null;
}
export interface LedgerEffects {
  settlementsByEntry: { entryId: string; amountCents: number | null }[];
  settlementsByTranche: { entryId: string; trancheId: string; amountCents: number | null }[];
  cashMovements: { id: string; date: string; accountId: string | null; inflowCents: number; outflowCents: number; kind: string; sourceOperationId: string }[];
  futureEvents: { id: string; date: string; accountId: string; amountCents: number; direction: 'in' | 'out'; kind: string; description: string; source: string; sourceType: 'loan'; sourceId: string; scheduleItemId: string }[];
  legacyFacts: { entryId: string; paymentId: string; accountId: string | null; cashTreatment: 'account' | 'participant_direct'; confirmation: 'confirmed' | 'reconciled'; source: string }[];
  retentionPlans: { id: string; entryId: string; trancheId?: string; amountCents: number; releaseDate: string | null; status: 'held' | 'released'; source: string }[];
  loanBalances: { loanId: string; principalCents: number | null; direction: 'borrowed' | 'lent' }[];
  warnings: string[];
}
export function emptyFinanceLedger(): FinanceLedgerState;
export function effectiveLedgerConfirmation(ledger: FinanceLedgerState | undefined, operation: LedgerOperation): LedgerConfirmation;
export function ledgerOperationAllocations(ledger: FinanceLedgerState, operation: LedgerOperation): LedgerAllocation[];
export function ledgerLegacyPaymentReferences(entry: LedgerProject['financeEntries'][number]): { id: string; amountCents: number; date: string | null }[];
export function ledgerConfirmedLegacyPaidCents(state: LedgerProject, entry: LedgerProject['financeEntries'][number]): number | null;
/** Signed NEW settlement delta, excluding legacy facts, including noncash offsets. */
export function ledgerSettledCentsFor(state: LedgerProject, entryId: string): number | null;
/** Signed NEW monetary settlement delta, excluding legacy facts and noncash offsets. */
export function ledgerCashSettledCentsFor(state: LedgerProject, entryId: string): number | null;
/** Net monetary settlement, INCLUDING legacy facts. */
export function ledgerEntryPaidCents(state: LedgerProject, entryId: string): number | null;
export function ledgerEntryBalance(state: LedgerProject, entryId: string): LedgerEntryBalance | null;
export function ledgerEffect(state: LedgerProject, options?: { today?: string }): LedgerEffects;
export function validateFinanceLedgerShape(ledger: unknown): string;
export function validateFinanceLedgerChanges(previous: LedgerProject | null, next: LedgerProject, identity: { role: string; name?: string; id?: string }, now?: string): string;
