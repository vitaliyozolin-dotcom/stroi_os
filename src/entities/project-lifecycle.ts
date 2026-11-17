export type LifecycleItemStatus = 'pending' | 'done' | 'not_applicable';
export interface LifecycleItem {
  key: string;
  status: LifecycleItemStatus;
  required: boolean;
  basis: string;
  documentIds: string[];
  owner?: string;
  planStart?: string;
  planEnd?: string;
  completedOn?: string;
  confirmedAt?: string;
  confirmedBy?: string;
}
export interface ProjectLifecycle {
  version: 1;
  phase: 'preparation' | 'construction' | 'handover' | 'closed' | 'warranty';
  usesEscrow: 'unknown' | 'yes' | 'no';
  scope: 'unknown' | 'warm_shell' | 'engineering' | 'turnkey' | 'custom';
  items: LifecycleItem[];
  startedAt: string;
  sourceLeadId?: string;
  sourceProjectId?: string;
  /** Originals remain in sourceProjectId; no binary duplication or permission changes. */
  sourceDocumentIds?: string[];
  legacyReview?: boolean;
  history: { at: string; actor: string; text: string }[];
}
