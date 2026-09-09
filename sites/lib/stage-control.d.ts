import type { AppState, Stage, ProjectTask } from '../../src/entities/index';
export function stageCanStart(state: AppState, stage: Stage): boolean;
export function stageGaps(state: AppState, id: string): { tasks: ProjectTask[]; checkpoints: AppState['checkpoints'] };
export function stageRadar(state: AppState, today?: string): { running: Stage[]; due: Stage[]; upcoming: Stage[]; lowerBound: string | null; forecast: string | null; stale: boolean; conflict: boolean; complete: boolean };
