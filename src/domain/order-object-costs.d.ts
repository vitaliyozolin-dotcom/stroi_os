import type { AppState, AuthenticatedUser, OrderObjectCostAllocation } from '../entities/index';
export interface OrderObjectCostSource {
  sourceType: OrderObjectCostAllocation['sourceType']; sourceId: string; label: string; amountCents: number; sign: 1 | -1;
  navigateTo: 'budget' | 'finance' | 'ledger'; entityId: string; source: string; counterparty?: string; date?: string;
  parentSourceId?: string; sharedPaymentId?: string; participantDirect?: boolean;
}
export interface OrderObjectCostTotals { budget: number | null; commitment: number | null; payment: number | null }
export interface OrderObjectCostSummary {
  objects: (OrderObjectCostTotals & { objectId: string; title: string; unresolvedCount: number })[];
  sources: (OrderObjectCostSource & { allocatedCents: number | null; remainingCents: number | null })[];
  totals: OrderObjectCostTotals; unallocated: OrderObjectCostTotals; warnings: string[];
}
export function orderObjectCostSourceKey(source: Pick<OrderObjectCostSource, 'sourceType' | 'sourceId'>): string;
export function orderObjectCostSources(state: AppState): OrderObjectCostSource[];
export function validateOrderObjectCostAllocations(previous: AppState | null, next: AppState, identity: Pick<AuthenticatedUser, 'role' | 'name'>, now?: string): string;
export function orderObjectCostSummary(state: AppState): OrderObjectCostSummary;
