import type { PlanBaseline, PlanChange } from './baseline';

export interface StageSchedule {
  kind: 'work' | 'supply' | 'control' | 'summary';
  phase: string;
  summaryOf: string[];
  dependencies: { stageId: string; gate: 'completed' | 'accepted'; lagDays: number }[];
  calendar: 'daily' | 'weekdays' | 'six-day';
  daysOff: string[];
  crew: string;
  reporterId: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface StageSiteUpdate {
  asOf: string;
  reviewOn: string;
  remainingDays: number | null;
  readyOn: string;
  acceptanceOn: string;
  note: string;
  nextAction: string;
  issueOwner: string;
  requestId?: string;
  confirmationId?: string;
  confirmedStatus?: string;
  confirmedFacts?: string;
  confirmedBlocker?: string;
  confirmedSchedule?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export type StageStatus =
  | 'not_ready'
  | 'ready'
  | 'in_progress'
  | 'blocked'
  | 'awaiting_inspection'
  | 'accepted'
  | 'rework';

export interface Stage {
  schedule?: StageSchedule;
  siteUpdate?: StageSiteUpdate;
  scheduleHistory?: { at: string; actor: string; kind: 'structure' | 'site'; note: string }[];
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
  completionObservedOn?: string;
  completionNote?: string;
  acceptedAt?: string;
  acceptedBy?: string;
  statusNote?: string;
  factRecoveryNote?: string;
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
