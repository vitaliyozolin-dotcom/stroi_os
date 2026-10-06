import type { AppState, BudgetLine, FinanceEntry } from '../entities/index';

export const FINANCE_RULES_VERSION: 2;
export interface EntryTotals { committed: number; accepted: number; paid: number }
export interface FinanceTotals extends EntryTotals {
  plan: number;
  forecast: number;
  storedForecast: number;
  received: number;
  contractedIncome: number;
}
export function roundMoney(value: number): number;
export function acceptedAmountFor(entry: FinanceEntry): number;
export function paidAmountFor(entry: FinanceEntry): number;
export function outstandingAmountFor(entry: FinanceEntry): number;
export function entryTotals(entries: FinanceEntry[]): EntryTotals;
export function lineTotals(state: AppState, line: BudgetLine): EntryTotals;
export function lineForecast(state: AppState, line: BudgetLine): number;
export function unallocatedExpenses(state: AppState): FinanceEntry[];
export function unallocatedExpenseTotals(state: AppState): EntryTotals & { forecast: number };
export function financeTotals(state: AppState): FinanceTotals;
export function outstandingExpenseTotal(state: AppState): number;
export function stageFinanceTotals(state: AppState, stageId: string): EntryTotals & {
  plan: number; forecast: number; billed: number; received: number;
};
