import type { FinanceOwnedState } from './finance/context';
import type { BudgetLine, FinanceEntry } from '../entities/index';

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
export function lineTotals(state: Pick<FinanceOwnedState, 'financeEntries'>, line: BudgetLine): EntryTotals;
export function lineForecast(state: Pick<FinanceOwnedState, 'financeEntries'>, line: BudgetLine): number;
export function unallocatedExpenses(state: Pick<FinanceOwnedState, 'budgetLines' | 'financeEntries'>): FinanceEntry[];
export function unallocatedExpenseTotals(state: Pick<FinanceOwnedState, 'budgetLines' | 'financeEntries'>): EntryTotals & { forecast: number };
export function financeTotals(state: Pick<FinanceOwnedState, 'budgetLines' | 'financeEntries'>): FinanceTotals;
export function outstandingExpenseTotal(state: Pick<FinanceOwnedState, 'financeEntries'>): number;
export function stageFinanceTotals(state: Pick<FinanceOwnedState, 'budgetLines' | 'financeEntries'>, stageId: string): EntryTotals & {
  plan: number; forecast: number; billed: number; received: number;
};
