/** A project is an order. This module adds relations without copying money or assets. */
export type OrderMode = 'client_land' | 'land_and_build' | 'ready_sale' | 'additional_work';
export type OrderStatus = 'draft' | 'active' | 'on_hold' | 'completed' | 'canceled';
export type OrderParticipantRole = 'customer' | 'co_customer' | 'land_owner' | 'payer' | 'borrower' | 'guarantor' | 'contractor' | 'supplier' | 'bank' | 'agent' | 'representative' | 'other';

export interface OrderParticipant {
  id: string;
  partyId: string;
  role: OrderParticipantRole;
  /** Optional mapping to the existing, project-local counterparty register. */
  projectCounterpartyId?: string;
  notes?: string;
}

export interface OrderRecordedFact { recordedAt?: string; recordedBy?: string }
export interface OrderSpecification extends OrderRecordedFact {
  id: string;
  version: number;
  status: 'draft' | 'approved';
  title: string;
  scope: string;
  model?: string;
  houseAreaSqm?: number;
  terraceAreaSqm?: number;
  floors?: number;
  technology?: string;
  finish?: string;
  plannedStart?: string;
  plannedEnd?: string;
  source?: string;
  documentIds: string[];
  /** An approved change is required when replacing an approved specification. */
  changeRequestId?: string;
  approvedAt?: string;
  approvedBy?: string;
}

export interface OrderObjectScope extends OrderRecordedFact {
  id: string;
  /** Shared physical asset; repeat orders reuse this identifier. */
  assetId: string;
  title: string;
  status: 'planned' | 'active' | 'completed' | 'canceled';
  specifications: OrderSpecification[];
  activeSpecificationId?: string;
  actualStart?: string;
  actualEnd?: string;
}

export interface OrderContract extends OrderRecordedFact {
  id: string;
  kind: 'customer' | 'supplier' | 'finance';
  title: string;
  number?: string;
  partyIds: string[];
  /** Server snapshot of the signed parties; canonical contact edits cannot rewrite it. */
  partySnapshots?: { partyId: string; name: string; partyType: 'person' | 'company'; inn?: string; legalName?: string }[];
  objectIds: string[];
  status: 'draft' | 'signed' | 'completed' | 'terminated';
  amountCents?: number;
  currency: 'RUB';
  signedDate?: string;
  effectiveDate?: string;
  endDate?: string;
  documentIds: string[];
  source?: string;
  /** A replacement states the FULL contract amount, never an additive delta. */
  supersedesId?: string;
  /** Canonical supplier master; amountCents is ONLY this order's allocated share. */
  sharedAgreementId?: string;
  changeRequestId?: string;
  closureChangeId?: string;
  closedReason?: string;
  signedAt?: string;
  signedBy?: string;
  closedAt?: string;
  closedBy?: string;
}

export interface OrderMortgage extends OrderRecordedFact {
  id: string;
  bankPartyId?: string;
  borrowerPartyIds: string[];
  contractId?: string;
  program: string;
  fundingRoute?: 'direct' | 'escrow';
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'funded' | 'canceled';
  requestedAmountCents?: number;
  approvedAmountCents?: number;
  downPaymentCents?: number;
  submittedDate?: string;
  decisionDate?: string;
  fundedDate?: string;
  /** Evidence only: the payment remains in the existing financial register. */
  financeEntryId?: string;
  documentIds: string[];
  source?: string;
  notes?: string;
  approvedAt?: string;
  approvedBy?: string;
  fundedAt?: string;
  fundedBy?: string;
}

export interface OrderChangeRequest extends OrderRecordedFact {
  id: string;
  title: string;
  reason: string;
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'applied';
  objectIds: string[];
  priceDeltaCents?: number;
  costDeltaCents?: number;
  scheduleDeltaDays?: number;
  documentIds: string[];
  source?: string;
  implementationNote?: string;
  approvedAt?: string;
  approvedBy?: string;
  appliedAt?: string;
  appliedBy?: string;
}

export type OrderLinkKind = 'stage' | 'budget' | 'finance' | 'procurement' | 'task' | 'document' | 'lead' | 'counterparty';
export interface OrderLink {
  id: string;
  kind: OrderLinkKind;
  /** Must exist in this project's authoritative register. */
  entityId: string;
  objectId?: string;
  contractId?: string;
  participantId?: string;
  changeRequestId?: string;
  warrantyCaseId?: string;
  notes?: string;
}

export interface OrderWarrantyCase extends OrderRecordedFact {
  id: string;
  objectId: string;
  title: string;
  description: string;
  status: 'open' | 'in_progress' | 'resolved' | 'closed';
  openedDate: string;
  dueDate?: string;
  resolvedDate?: string;
  responsiblePartyId?: string;
  documentIds: string[];
  resolution?: string;
  source?: string;
  closedAt?: string;
  closedBy?: string;
}

export interface OrderRelationsHistoryEntry {
  id: string;
  at: string;
  by: string;
  actorEmail?: string;
  reason: string;
  /** Names of changed sections; immutable evidence stays in the versioned rows. */
  sections: string[];
  changes: { path: string; before: unknown; after: unknown }[];
}

export interface OrderRelationsState {
  version: 1;
  customerId?: string;
  mode: OrderMode;
  status: OrderStatus;
  /** Explicit opt-in only; absent/false preserves legacy project.contractValue. */
  contractPricing?: boolean;
  plotIds: string[];
  participants: OrderParticipant[];
  objects: OrderObjectScope[];
  contracts: OrderContract[];
  mortgages: OrderMortgage[];
  changeRequests: OrderChangeRequest[];
  links: OrderLink[];
  warrantyCases: OrderWarrantyCase[];
  costAllocations?: OrderObjectCostAllocation[];
  changeReason?: string;
  history: OrderRelationsHistoryEntry[];
}
export type OrderRelations = OrderRelationsState;

export interface OrderObjectCostAllocation extends OrderRecordedFact {
  id: string;
  objectId: string;
  sourceType: 'budget' | 'commitment' | 'payment';
  sourceId: string;
  amountCents: number;
  source: string;
  status: 'active' | 'canceled';
  canceledReason?: string;
  canceledAt?: string;
  canceledBy?: string;
}

export type OrderDirectoryKind = 'party' | 'plot' | 'asset' | 'agreement';
export interface OrderPartyData {
  name: string;
  partyType: 'person' | 'company';
  phone?: string;
  email?: string;
  inn?: string;
  legalName?: string;
  source?: string;
  notes?: string;
}
export interface OrderPlotData {
  name: string;
  address?: string;
  cadastralNumber?: string;
  areaSqm?: number;
  ownerPartyIds?: string[];
  communications?: string;
  constraints?: string;
  source?: string;
  notes?: string;
}
export interface OrderAssetData {
  name: string;
  assetType: 'house' | 'bath' | 'garage' | 'other';
  plotId?: string;
  houseAreaSqm?: number;
  terraceAreaSqm?: number;
  floors?: number;
  technology?: string;
  source?: string;
  notes?: string;
}
/** Shared supplier contract. Signed terms are immutable; allocated parts live on orders. */
export interface OrderAgreementData {
  name: string;
  number?: string;
  partyIds: string[];
  totalAmountCents?: number;
  currency: 'RUB';
  status: 'draft' | 'signed';
  signedDate?: string;
  effectiveDate?: string;
  endDate?: string;
  /** Documents in originProjectId; omitted from responses when origin is inaccessible. */
  documentIds?: string[];
  source?: string;
  notes?: string;
  partySnapshots?: NonNullable<OrderContract['partySnapshots']>;
}
export interface OrderDirectoryDataMap { party: OrderPartyData; plot: OrderPlotData; asset: OrderAssetData; agreement: OrderAgreementData }
export type OrderDirectoryRecord = { [K in OrderDirectoryKind]: {
  id: string;
  kind: K;
  data: OrderDirectoryDataMap[K];
  revision: number;
  /** Omitted when origin is outside the viewer's management scope. */
  originProjectId?: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  canEdit: boolean;
  /** Shared agreement terms requiring wider financial access are omitted. */
  limitedScope?: boolean;
} }[OrderDirectoryKind];

export interface OrderDirectoryOrderSummary {
  id: string;
  code: string;
  name: string;
  status: string;
  revision: number;
  customerId?: string;
  mode?: OrderMode;
  participantPartyIds: string[];
  assetIds: string[];
  plotIds: string[];
  /** Existing project's amount in RUB; no parallel financial totals. */
  contractValue: number | null;
}
export interface OrderDirectoryResponse { ok: true; records: OrderDirectoryRecord[]; orders: OrderDirectoryOrderSummary[] }
