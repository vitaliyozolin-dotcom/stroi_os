import type { AppState } from '../entities/index';
export interface FinanceWorkspaceSummary {
  estimateKind: 'internal_cost' | 'commercial' | 'unknown';
  contractCents: number | null;
  commercialEstimateCents: number | null;
  internalBudgetCents: number | null;
  internalBudgetApproved: boolean;
  forecastCents: number | null;
  forecastComplete: boolean;
  forecastResultCents: number | null;
  availableCashCents: number | null;
  paidCents: number | null;
  scheduled14Cents: number;
  horizonEnd: string;
  undatedExpenseCents: number;
  needs14Cents: number | null;
  cashComplete: boolean;
  firstDeficitDate: string | null;
  firstDeficitCents: number | null;
  peakFundingCents: number | null;
  costWarnings: string[];
}
export function financeWorkspaceSummary(state: AppState, today: string): FinanceWorkspaceSummary;
