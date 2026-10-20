import type { ConstructionSnapshot } from '../contexts';
import type { Stage, ProjectTask, QualityCheckpoint } from '../../entities/index';
export function stageControlFingerprint(stage: Stage): string;
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
export function recordedScheduleStatus(state: ConstructionSnapshot, today?: string): { today: string; stages: RecordedScheduleGroup<Stage>; tasks: RecordedScheduleGroup<ProjectTask> };
export function stageCanStart(state: ConstructionSnapshot, stage: Stage): boolean;
export function stageGaps(state: ConstructionSnapshot, id: string): { tasks: ProjectTask[]; checkpoints: QualityCheckpoint[] };
export function stageRadar(state: ConstructionSnapshot, today?: string): { running: Stage[]; due: Stage[]; upcoming: Stage[]; lowerBound: string | null; forecast: string | null; stale: boolean; conflict: boolean; complete: boolean };
