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
  responsible: string;
  responsibleId?: string;
  dependencyId?: string;
  dependency?: string;
  blocker?: string;
}
