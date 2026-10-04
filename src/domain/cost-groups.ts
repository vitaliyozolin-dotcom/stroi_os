import type { AppState, CostGroup, FinanceEntry } from '../entities/index';
import { paidAmountFor } from './finance.ts';

export const costGroupLabels: Record<CostGroup, string> = {
  construction: 'Строительство', overhead: 'Накладные', reserve: 'Резерв', unallocated: 'Нужно распределить',
};
export const costGroups = Object.keys(costGroupLabels) as CostGroup[];
export function expenseCostGroup(state: AppState, entry: FinanceEntry): CostGroup {
  const group = entry.costGroup ?? state.budgetLines.find(line => line.id === entry.budgetLineId)?.costGroup;
  // A reserve is a budget allowance, never a type of actual expenditure.
  return group && group !== 'reserve' ? group : 'unallocated';
}
export function costGroupTotals(state: AppState) {
  const totals = Object.fromEntries(costGroups.map(group => [group, { plan: 0, paid: 0 }])) as Record<CostGroup, { plan: number; paid: number }>;
  for (const line of state.budgetLines) totals[line.costGroup ?? 'unallocated'].plan += line.plan;
  for (const entry of state.financeEntries) if (entry.kind === 'expense') totals[expenseCostGroup(state, entry)].paid += paidAmountFor(entry);
  for (const row of Object.values(totals)) { row.plan = Math.round(row.plan * 100) / 100; row.paid = Math.round(row.paid * 100) / 100; }
  return totals;
}
