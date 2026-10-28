import type { FinanceOwnedState, FinanceSettlementContext, FinanceBudgetContext } from './finance/context';
import type { BudgetLine, FinanceEntry } from '../entities/index';

export const FINANCE_RULES_VERSION: 3;
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
export function paidAmountFor(entry: FinanceEntry, state?: FinanceSettlementContext): number;
export function settledAmountFor(entry: FinanceEntry, state?: FinanceSettlementContext): number;
export function payableAmountFor(entry: FinanceEntry, state?: FinanceSettlementContext): number;
export function outstandingAmountFor(entry: FinanceEntry, state?: FinanceSettlementContext): number;
export function effectiveBudgetLines(state: Pick<FinanceOwnedState, 'budgetLines'> & FinanceBudgetContext): BudgetLine[];
export function entryTotals(entries: FinanceEntry[], state?: FinanceSettlementContext): EntryTotals;
export function lineTotals(state: Pick<FinanceOwnedState, 'financeEntries'> & FinanceSettlementContext & FinanceBudgetContext, line: BudgetLine): EntryTotals;
export function lineForecast(state: Pick<FinanceOwnedState, 'financeEntries'> & FinanceSettlementContext & FinanceBudgetContext, line: BudgetLine): number;
export function unallocatedExpenses(state: Pick<FinanceOwnedState, 'budgetLines' | 'financeEntries'> & FinanceSettlementContext & FinanceBudgetContext): FinanceEntry[];
export function unallocatedExpenseTotals(state: Pick<FinanceOwnedState, 'budgetLines' | 'financeEntries'> & FinanceSettlementContext & FinanceBudgetContext): EntryTotals & { forecast: number };
export function financeTotals(state: Pick<FinanceOwnedState, 'budgetLines' | 'financeEntries'> & FinanceSettlementContext & FinanceBudgetContext): FinanceTotals;
export function outstandingExpenseTotal(state: Pick<FinanceOwnedState, 'financeEntries'> & FinanceSettlementContext & FinanceBudgetContext): number;
export function stageFinanceTotals(state: Pick<FinanceOwnedState, 'budgetLines' | 'financeEntries'> & FinanceSettlementContext & FinanceBudgetContext, stageId: string): EntryTotals & {
  plan: number; forecast: number; billed: number; received: number;
};
