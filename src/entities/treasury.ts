/** Additive planning metadata. Payments remain owned by FinanceEntry.payments. */
export type TreasuryScenario = 'base' | 'cautious' | 'stress';
export type TreasuryCertainty = 'confirmed' | 'expected' | 'tentative';
export interface TreasuryAccount {
  id: string;
  name: string;
  legalEntityId: string;
  currency: 'RUB';
  /** A confirmed bank/cash balance at the END of asOf, not at the start. */
  opening?: { asOf: string; amountCents: number; confirmed: boolean; source: string };
  restrictedCents?: number;
  isProjectDedicated?: boolean;
  /** Explicit allocation from a shared account to this project. */
  projectAllocationCents?: number;
}
export interface TreasuryDateRule {
  kind: 'stage_start' | 'stage_end' | 'stage_acceptance' | 'task_start' | 'task_end';
  stageId?: string;
  taskId?: string;
  offsetDays: number;
  calendar: 'calendar' | 'workdays';
}
export interface TreasuryTranche {
  id: string;
  amountCents: number;
  contractualDueDate?: string;
  forecastDate?: string;
  certainty: TreasuryCertainty;
  source: string;
  sourceAccountId?: string;
  dateRule?: TreasuryDateRule;
  /** Allocation of an EXISTING payment ID, never a second cash movement. */
  paymentAllocations?: { paymentId: string; amountCents: number }[];
}
export interface TreasuryPaymentFact {
  paymentId: string;
  accountId?: string;
  cashTreatment: 'account' | 'participant_direct';
  confirmation: 'claimed' | 'confirmed' | 'reconciled';
  source: string;
}
export interface TreasuryEntryPlan {
  entryId: string;
  sourceAccountId?: string;
  cashTreatment?: 'account' | 'participant_direct' | 'unassigned';
  tranches: TreasuryTranche[];
  paymentFacts?: TreasuryPaymentFact[];
  source: string;
}
export interface TreasuryCostEstimate {
  id: string;
  budgetLineId?: string;
  name: string;
  recognizedCents: number;
  remainingWorkCents: number;
  /** Already purchased, not yet consumed stock: ETC, not another payment. */
  stockToConsumeCents: number;
  otherRemainingCents: number;
  approvedBudgetCents: number;
  source: string;
}
export interface TreasuryChangeEvent {
  id: string;
  at: string;
  by: string;
  reason: string;
  changes: { field: string; before: unknown; after: unknown }[];
}
export interface TreasuryCashScopeReview {
  asOf: string;
  source: string;
  /** Change-detection fingerprint, not an authentication or signing token. */
  fingerprint: string;
}
export interface TreasuryState {
  version: 1;
  enabled: boolean;
  accounts: TreasuryAccount[];
  entryPlans: TreasuryEntryPlan[];
  costEstimates: TreasuryCostEstimate[];
  reserveCents?: number;
  scenarios?: { cautiousDelayDays: number; stressDelayDays: number; stressCostIncreasePct: number };
  cashScopeReview?: TreasuryCashScopeReview;
  changeReason?: string;
  /** Server-owned, append-only. The client must preserve this array verbatim. */
  history?: TreasuryChangeEvent[];
}
