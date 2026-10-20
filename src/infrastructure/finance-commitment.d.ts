import type { AppState } from '../entities/index';
import type { StateChange } from '../domain/change';
import type { FinanceCommandContext } from '../application/finance-context';
import type { CreateCommitmentInput, FinanceCommitmentSnapshot, FinanceCommitmentCommandResult } from '../application/finance-context-commitment.js';
export type { CreateCommitmentInput } from '../application/finance-context-commitment.js';

export type CreateCommitmentResult = { ok: true; entryId: string; change: StateChange | null } | { ok: false; error: string };
export function financeCommitmentSnapshot(state: AppState): FinanceCommitmentSnapshot;
export function applyFinanceCommitmentResult(state: AppState, result: FinanceCommitmentCommandResult): CreateCommitmentResult;
export function createProjectCommitment(state: AppState, input: CreateCommitmentInput, context: FinanceCommandContext): CreateCommitmentResult;
