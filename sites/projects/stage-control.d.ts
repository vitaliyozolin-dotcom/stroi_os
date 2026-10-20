import type { AppState, UserRole } from '../../src/entities/index';
export function validateStageControl(previous: AppState | null, next: AppState, identity: { role: UserRole; id?: string; name?: string }, now?: string): string | null;
