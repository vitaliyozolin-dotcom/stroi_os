import type { AppState, Stage, ProjectTask } from '../../src/entities/index';
export interface RecordedScheduleGroup<T> {
  recordCount: number;
  overdue: { record: T; days: number; baselineDays: number | null }[];
  baselineOverdue: { record: T; days: number | null; baselineDays: number }[];
  maxDays: number;
  maxBaselineDays: number;
  awaitingReview: number;
  missingDue: number;
  missingBaseline: number;
}
export function recordedScheduleStatus(state: AppState, today?: string): { today: string; stages: RecordedScheduleGroup<Stage>; tasks: RecordedScheduleGroup<ProjectTask> };
export function stageCanStart(state: AppState, stage: Stage): boolean;
export function stageGaps(state: AppState, id: string): { tasks: ProjectTask[]; checkpoints: AppState['checkpoints'] };
export function stageRadar(state: AppState, today?: string): { running: Stage[]; due: Stage[]; upcoming: Stage[]; lowerBound: string | null; forecast: string | null; stale: boolean; conflict: boolean; complete: boolean };
