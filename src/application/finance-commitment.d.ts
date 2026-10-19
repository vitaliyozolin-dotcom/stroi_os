import type { AppState } from '../entities/index';
import type { FinanceActor, FinanceCommitmentInput } from '../domain/finance/index.js';
import type { StateChange } from '../domain/change';
import type { Clock, IdGenerator } from './ports';

export type CreateCommitmentInput = Omit<FinanceCommitmentInput, 'id'> & { id?: string };
export type CreateCommitmentResult = { ok: true; entryId: string; change: StateChange | null } | { ok: false; error: string };
export function createProjectCommitment(state: AppState, input: CreateCommitmentInput, context: { identity: FinanceActor; clock: Clock; ids: IdGenerator }): CreateCommitmentResult;
