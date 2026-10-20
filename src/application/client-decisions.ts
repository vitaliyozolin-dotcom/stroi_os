import type { AppState, UserRole } from '../entities/index';
import { confirmClientDecision } from '../domain/client-decisions.ts';
import type { StateChange } from '../domain/change';
import type { Clock, IdGenerator } from './ports';
import { commitStateChange, type StateChangeSink } from './state-change.ts';

export interface ConfirmClientDecisionInput { decisionId: string; expected: string; choice: string }
export type ClientDecisionResult = { ok: true; change: StateChange | null } | { ok: false; error: string };
export const confirmProjectClientDecision = (state: AppState, input: ConfirmClientDecisionInput, identity: { name: string; role: UserRole }, clock: Clock, ids: IdGenerator): ClientDecisionResult => {
  if (!['management', 'client'].includes(identity.role)) return { ok: false, error: 'Подтверждение решения доступно клиенту и управлению.' };
  const result = confirmClientDecision(state, input);
  if (!result.ok) return result;
  if (!result.changed) return { ok: true, change: null };
  const summary = `Решение клиента: ${result.decision.title} — ${result.decision.choice}`;
  return { ok: true, change: {
    action: 'client_decision_updated', summary,
    state: { ...state, decisions: state.decisions.map(row => row.id === result.decision.id ? result.decision : row), activity: [{ id: ids.next('activity'), timestamp: clock.now(), actor: identity.name, text: summary, tone: 'positive' }, ...state.activity] },
  } };
};
export const createClientDecisionUseCases = (state: AppState, identity: { name: string; role: UserRole }, clock: Clock, ids: IdGenerator, sink: StateChangeSink) => ({
  confirm: (input: ConfirmClientDecisionInput) => {
    const result = confirmProjectClientDecision(state, input, identity, clock, ids);
    if (result.ok && result.change) commitStateChange(result.change, sink);
    return result;
  },
});
