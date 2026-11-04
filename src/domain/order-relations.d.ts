import type { OrderRelationsState, OrderDirectoryKind, OrderSpecification, OrderObjectScope } from '../entities/index';
export type { OrderRelationsState } from '../entities/index';
export interface OrderRelationsProject {
  project: { id: string; status?: string; contractValue?: number; unknownFields?: string[] };
  orderRelations?: OrderRelationsState;
  stages?: { id: string }[];
  budgetLines?: { id: string }[];
  financeEntries?: { id: string; kind: string; amount?: number; status?: string; paidAmount?: number; payments?: { amount: number }[] }[];
  procurement?: { id: string }[];
  tasks?: { id: string }[];
  documents?: { id: string }[];
  leads?: { id: string }[];
  counterparties?: { id: string }[];
  financeLedger?: { operations?: { id: string }[]; loans?: { id: string }[]; retentions?: { id: string }[]; confirmations?: { id: string }[] };
}
export interface OrderRelationsIdentity { role: string; name?: string; id?: string; email?: string; isOwner?: boolean }
export function emptyOrderRelations(): OrderRelationsState;
/** Read-time defaults; not a replacement for write validation. */
export function normalizeOrderRelations(value: unknown): OrderRelationsState | undefined;
export function validOrderRelationId(value: unknown): value is string;
export function validOrderDate(value: unknown): value is string;
export function orderDirectoryReferences(value: OrderRelationsState | undefined): { id: string; kind: OrderDirectoryKind }[];
export function orderContractTotals(value: OrderRelationsState | undefined): { customerCents: number | null; supplierCents: number | null; financeCents: number | null };
export function orderContractValueCents(value: OrderRelationsState | undefined): number | null;
/** No mutations without now. On the server: canonical stamps, history and opted-in contractValue projection. */
export function validateOrderRelationsChanges(previous: OrderRelationsProject | null, next: OrderRelationsProject, identity: OrderRelationsIdentity, now?: string): string;
export function prepareOrderRelationsUpdate(state: OrderRelationsProject, nextRelations: OrderRelationsState, identity: OrderRelationsIdentity, reason: string):
  { ok: true; orderRelations: OrderRelationsState; projectStatus: 'draft' | 'active' | 'completed' | 'archived'; contractValue?: number } | { ok: false; error: string };
export type OrderRelationCollection = 'participants' | 'objects' | 'contracts' | 'mortgages' | 'changeRequests' | 'links' | 'warrantyCases' | 'costAllocations';
export function upsertOrderRelation<K extends OrderRelationCollection>(relations: OrderRelationsState, collection: K, row: NonNullable<OrderRelationsState[K]>[number]): OrderRelationsState;
export function createOrderSpecificationVersion(scope: OrderObjectScope, id: string, changeRequestId?: string): OrderSpecification;
