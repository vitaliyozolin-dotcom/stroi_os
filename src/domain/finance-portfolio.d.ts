import type { TreasuryProject, TreasuryScenario } from './treasury.js';
export interface PortfolioDay { date: string; inflowCents: number | null; outflowCents: number | null; balanceCents: number | null }
export interface PortfolioTotals { openingCents: number | null; minBalanceCents: number | null; firstDeficitDate: string | null; peakFundingCents: number | null; complete: boolean; days: PortfolioDay[] }
export interface FinancePortfolio {
  today: string; horizonDays: number; scenario: TreasuryScenario; scope: 'authorized_project_allocations'; projectCount: number; enabledProjectCount: number;
  summary: PortfolioTotals; projects: (PortfolioTotals & { projectId: string; code: string; name: string; enabled: boolean; warningCount: number })[];
  companies: (PortfolioTotals & { legalEntityId: string })[];
  accounts: (PortfolioTotals & { projectId: string; accountId: string; name: string; legalEntityId: string; sharedAccountKey: string | null; scope: 'dedicated' | 'project_allocation' })[];
  warnings: string[]; companiesWithDeficit: number;
}
export function validatePortfolioWrite(previous: TreasuryProject | null, next: TreasuryProject, others: TreasuryProject[]): string;
export function requiresPortfolioCheck(previous: TreasuryProject | null, next: TreasuryProject): boolean;
export function financePortfolio(states: TreasuryProject[], options: { today: string; horizonDays?: number; scenario?: TreasuryScenario }): FinancePortfolio;
