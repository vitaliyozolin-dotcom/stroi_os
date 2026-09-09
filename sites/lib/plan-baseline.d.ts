import type { AppState, ProjectTask, Stage } from '../../src/entities/index';
export function validPlanDate(value: unknown): value is string;
export function planDays(current?: string | null, original?: string | null): number | null;
export function planToday(date?: Date): string;
export function restoreKnownPprBaseline(state: AppState): AppState;
export function taskBaselineEnd(task: ProjectTask): string | null;
export function taskBaselineDelay(task: ProjectTask, today?: string): number | null;
export function baselineOverview(state: AppState): { end: string | null; currentEnd: string | null; shift: number | null; pprComplete: boolean; recorded: number; total: number; shiftedStages: Stage[]; shiftedTasks: ProjectTask[] };
