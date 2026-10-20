import type { ConstructionSnapshot } from '../contexts';
import type { Stage } from '../../entities/index';
export function plannedStageDays(stage: Stage): number | null;
export interface AutomaticSchedule {
  end: string | null;
  kind: 'incomplete' | 'actual' | 'observed' | 'estimated' | 'confirmed';
  baselineEnd: string | null;
  baselineShift: number | null;
  remainingDays: number | null;
  remainingStages: number;
  rows: { id: string; start: string; end: string; source: 'plan' | 'remaining' | 'observation' | 'fact' | 'summary'; remainingDays: number; workDates: string[] }[];
  issues: { stageId: string; message: string }[];
  notes: string[];
  unmappedWork: string[];
}
export function automaticSchedule(state: ConstructionSnapshot, today?: string): AutomaticSchedule;
