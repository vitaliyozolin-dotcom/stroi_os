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
  /** Stable company-level identity shared by every project using this account. */
  sharedAccountKey?: string;
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
  taxBasis?: 'gross' | 'net' | 'not_applicable';
}
export type TreasuryCashCategory = 'uncontracted_work' | 'overhead' | 'payroll' | 'tax' | 'other';
export interface TreasuryCashPlan {
  id: string; name: string; kind: 'expense' | 'income'; category: TreasuryCashCategory;
  amountCents: number; date?: string; dateRule?: TreasuryDateRule; accountId?: string;
  budgetLineId?: string; certainty: TreasuryCertainty; source: string;
  /** Explicit portion replaced by a real obligation; never a second commitment or payment. */
  coverage?: { entryId: string; amountCents: number }[];
}
export interface TreasuryDelayRate {
  id: string; name: string; category: 'overhead' | 'interest' | 'other';
  baselineEnd: string; endDate?: string; endRule?: TreasuryDateRule;
  dailyCents: number; calendar: 'calendar' | 'workdays'; accountId?: string;
  paymentOffsetDays: number; source: string;
  coverage?: { entryId: string; amountCents: number }[];
  costTreatment: 'additional' | 'included_in_estimate';
  /** Recognized part of this additional cost, independent of actual cash settlement. */
  recognizedCents: number;
}
export interface TreasuryInventoryLot {
  id: string; name: string; costEstimateId: string; quantityMillis: number; unit: string;
  totalCostCents: number; receivedOn: string; source: string;
  recordedAt?: string; recordedBy?: string;
}
export interface TreasuryInventoryMovement {
  id: string; lotId: string; kind: 'consume' | 'reverse'; quantityMillis?: number; reversesId?: string;
  date: string; source: string; recordedAt?: string; recordedBy?: string;
}
export interface TreasuryBudgetVersion {
  id: string; name: string; source: string; taxBasis: 'gross' | 'net' | 'not_applicable'; taxNote: string;
  lines: { id: string; name: string; amountCents: number }[];
  approvedAt?: string; approvedBy?: string;
}
export interface TreasurySavedScenario {
  id: string; name: string; source: string; asOf: string; basisFingerprint: string;
  incomeDelayDays: number; workDelayDays: number; tentativeCostIncreasePct: number;
  extraCashPlans: TreasuryCashPlan[]; recordedAt?: string; recordedBy?: string;
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
  cashPlans?: TreasuryCashPlan[];
  delayRates?: TreasuryDelayRate[];
  inventoryLots?: TreasuryInventoryLot[];
  inventoryMovements?: TreasuryInventoryMovement[];
  budgetVersions?: TreasuryBudgetVersion[];
  activeBudgetVersionId?: string;
  savedScenarios?: TreasurySavedScenario[];
  changeReason?: string;
  /** Server-owned, append-only. The client must preserve this array verbatim. */
  history?: TreasuryChangeEvent[];
}
