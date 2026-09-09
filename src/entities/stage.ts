import type { PlanBaseline, PlanChange } from './baseline';

export type StageStatus =
  | 'not_ready'
  | 'ready'
  | 'in_progress'
  | 'blocked'
  | 'awaiting_inspection'
  | 'accepted'
  | 'rework';

export interface Stage {
  id: string;
  order: number;
  name: string;
  shortName: string;
  status: StageStatus;
  weight: number;
  progress: number;
  planStart: string;
  planEnd: string;
  forecastEnd: string;
  actualEnd?: string;
  actualStart?: string;
  completedOn?: string;
  completionNote?: string;
  acceptedAt?: string;
  acceptedBy?: string;
  statusNote?: string;
  forecastReason?: string;
  forecastUpdatedAt?: string;
  forecastUpdatedBy?: string;
  statusHistory?: { at: string; actor: string; status: StageStatus; note: string }[];
  baseline?: PlanBaseline;
  planHistory?: PlanChange[];
  planChangeReason?: string;
  responsible: string;
  responsibleId?: string;
  dependencyId?: string;
  dependency?: string;
  blocker?: string;
}
