import type { TreasuryState, TreasuryScenario, TreasuryDateRule, TreasuryCertainty } from '../entities/index';
export type { TreasuryState, TreasuryScenario, TreasuryDateRule, TreasuryCertainty } from '../entities/index';
export interface TreasuryEntry {
  id: string; kind: 'expense' | 'income'; amount: number; status?: string;
  description: string; dueDate?: string; paidAmount?: number | null; paidAt?: string; budgetLineId?: string;
  payments?: { id: string; amount: number; date: string }[];
}
export interface TreasuryProject {
  project: { id: string };
  treasury?: TreasuryState;
  financeEntries: TreasuryEntry[];
  budgetLines?: { id: string; plan: number; forecast?: number; name?: string }[];
  stages?: { id: string; name?: string; shortName?: string; status?: string; planStart?: string; forecastEnd?: string; actualStart?: string; actualEnd?: string; completedOn?: string; acceptedAt?: string; schedule?: unknown; siteUpdate?: { readyOn?: string; acceptanceOn?: string } }[];
  tasks?: { id: string; title?: string; status?: string; stageId?: string; plannedStart?: string; dueDate?: string; completedAt?: string }[];
}
export interface TreasuryDateResolution {
  date: string | null; anchorDate: string | null;
  basis: 'actual' | 'forecast' | 'recorded_plan' | 'fixed' | 'unknown';
  /** Human-readable anchor and offset; reason explains uncertainty or conflicting dates. */
  label: string; reason: string | null;
  stageId?: string; taskId?: string; linkedStageId?: string;
  offsetDays: number; calendar: 'calendar' | 'workdays';
}
export interface TreasuryProjectionEvent {
  id: string; entryId: string; description: string; kind: 'income' | 'expense'; amountCents: number;
  date: string | null; scheduledDate: string | null; contractualDueDate: string | null; accountId: string | null;
  trancheId?: string; certainty: TreasuryCertainty; overdue: boolean; source: string; excluded?: boolean;
  dateResolution: TreasuryDateResolution;
  /** Deadline passed at the end-of-day cutoff, separate from forecast lateness. */
  contractOverdue: boolean;
  /** Effective cash forecast (after overdue/scenario shift) minus contract, minimum zero; unknown = null. */
  forecastDelayDays: number | null;
  /** Original fixed/PPR schedule minus contract, minimum zero; unknown = null. */
  scheduledDelayDays: number | null;
}
export interface TreasuryProjectionDay {
  date: string; inflowCents: number; outflowCents: number; balanceCents: number | null;
  deficitCents: number | null; reserveShortfallCents: number | null; events: TreasuryProjectionEvent[];
}
export interface TreasuryProjection {
  today: string; scenario: TreasuryScenario; days: TreasuryProjectionDay[]; events: TreasuryProjectionEvent[];
  openingKnown: boolean; openingCents: number | null; minBalanceCents: number | null;
  firstDeficitDate: string | null; peakFundingCents: number | null; peakReserveFundingCents: number | null;
  unallocatedCents: { income: number; expense: number }; unallocatedSettlementCents: number;
  warnings: string[]; completeness: boolean;
}
export function emptyTreasury(): TreasuryState;
export function treasuryScopeFingerprint(state: TreasuryProject): string;
export function treasuryMoneyToCents(value: unknown): number | null;
export function validTreasuryDate(value: unknown): value is string;
export function resolveTreasuryDateRule(state: TreasuryProject, rule: TreasuryDateRule, today?: string): string | null;
export function resolveTreasuryDateRuleDetails(state: TreasuryProject, rule: TreasuryDateRule, today?: string): TreasuryDateResolution;
export interface TreasuryScheduleChange {
  id: string; entryId: string; trancheId?: string; description: string; kind: 'income' | 'expense'; amountCents: number;
  beforeDate: string | null; afterDate: string | null; shiftDays: number | null; contractualDueDate: string | null;
  beforeResolution: TreasuryDateResolution; afterResolution: TreasuryDateResolution; reason: string; affectsCash: boolean;
}
export interface TreasuryScheduleImpact {
  before: TreasuryProjection; after: TreasuryProjection; changes: TreasuryScheduleChange[];
  shiftedIncomeCents: number | null; shiftedExpenseCents: number | null; peakFundingDeltaCents: number | null;
  /** Comparable known cash events; complete also requires all scope/estimate checks to pass. */
  comparable: boolean; complete: boolean;
}
export function treasuryScheduleImpact(previous: TreasuryProject, next: TreasuryProject, options: { today: string; horizonDays?: number; accountId?: string }): TreasuryScheduleImpact;
/** Existing ledger projection. Legacy aggregates have an explicit synthetic reference only. */
export function treasuryPaymentReferences(entry: TreasuryEntry): { id: string; amountCents: number; date: string | null; legacy: boolean }[];
export function treasuryProjection(state: TreasuryProject, options: { today: string; horizonDays?: number; scenario?: TreasuryScenario; accountId?: string }): TreasuryProjection;
export function treasuryCostSummary(state: TreasuryProject): { recognizedCents: number | null; etcCents: number | null; eacCents: number | null; budgetCents: number | null; varianceCents: number | null; complete: boolean; warnings: string[] };
/** Validates without mutations when now is omitted; server stamps history after successful validation. */
export function validateTreasuryChanges(previous: TreasuryProject | null, next: TreasuryProject, identity: { role: string; name?: string; id?: string; isOwner?: boolean }, now?: string): string;
