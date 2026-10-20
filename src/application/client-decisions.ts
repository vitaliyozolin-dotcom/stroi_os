import type { UserRole } from '../entities/index';
import { confirmClientDecision } from '../domain/client-decisions.ts';
import type { DecisionsSnapshot, DecisionsPatch } from '../domain/contexts.ts';
import { moduleChange, executeModule, type ModuleChange, type ModuleRepository } from './module-repository.ts';
import type { Clock, IdGenerator } from './ports.ts';

export interface ConfirmClientDecisionInput { decisionId: string; expected: string; choice: string }
export type ClientDecisionResult = { ok: true; change: ModuleChange<DecisionsPatch> | null } | { ok: false; error: string };
export const confirmProjectClientDecision = (state: DecisionsSnapshot, input: ConfirmClientDecisionInput, identity: { name: string; role: UserRole }, clock: Clock, ids: IdGenerator): ClientDecisionResult => {
  if (!['management', 'client'].includes(identity.role)) return { ok: false, error: 'Подтверждение решения доступно клиенту и управлению.' };
  const result = confirmClientDecision(state, input);
  if (!result.ok) return result;
  if (!result.changed) return { ok: true, change: null };
  const summary = `Решение клиента: ${result.decision.title} — ${result.decision.choice}`;
  return { ok: true, change: moduleChange(state, { decisions: state.decisions.map(row => row.id === result.decision.id ? result.decision : row) }, 'client_decision_updated', summary, { identity, clock, ids }, 'positive') };
};
export const createClientDecisionUseCases = (repository: ModuleRepository<DecisionsSnapshot, DecisionsPatch>, identity: { name: string; role: UserRole }, clock: Clock, ids: IdGenerator) => ({
 confirm: (input: ConfirmClientDecisionInput) => executeModule(repository, state => confirmProjectClientDecision(state, input, identity, clock, ids)),
});
