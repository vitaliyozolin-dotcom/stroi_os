import type { ConstructionSnapshot } from '../contexts';
import type { ProjectTask, ActivityEvent, Stage } from '../../entities/index';
export function validPlanDate(value: unknown): value is string;
export function planDays(current?: string | null, original?: string | null): number | null;
export function planToday(date?: Date): string;
export function restoreKnownPprBaseline<T extends Pick<ConstructionSnapshot, 'project' | 'stages' | 'tasks'> & { activity?: ActivityEvent[] }>(state: T): T;
export function taskBaselineEnd(task: ProjectTask): string | null;
export function taskBaselineDelay(task: ProjectTask, today?: string): number | null;
export function baselineOverview(state: Pick<ConstructionSnapshot, 'project' | 'stages' | 'tasks'>): { end: string | null; currentEnd: string | null; shift: number | null; pprComplete: boolean; currentComplete: boolean; recorded: number; currentRecorded: number; total: number; shiftedStages: Stage[]; shiftedTasks: ProjectTask[] };
