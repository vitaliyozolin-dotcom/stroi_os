import type { AppState, UserRole } from '../entities/index';
export function validateProjectFundingChanges(previous: AppState | null, state: AppState, identity: { role: UserRole; name: string }, now: string): string;
