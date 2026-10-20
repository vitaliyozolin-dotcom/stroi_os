import type { DecisionsSnapshot } from './contexts';
import type { ClientDecision } from '../entities/index';

// Existing UI choices remain unchanged until decision-specific options enter the data contract.
export const clientDecisionOptions = (id: string): string[] => id === 'decision-1'
  ? ['Натуральный дуб', 'Графит', 'Терракота']
  : ['Вариант A', 'Вариант B', 'Нужна консультация'];
export const clientDecisionSnapshot = (state: DecisionsSnapshot, id: string) => JSON.stringify([state.project.id, state.decisions.find(decision => decision.id === id)]);
export const confirmClientDecision = (state: DecisionsSnapshot, input: { decisionId: string; expected: string; choice: string }): { ok: true; changed: boolean; decision: ClientDecision } | { ok: false; error: string } => {
  const decision = state.decisions.find(row => row.id === input.decisionId);
  if (!decision || input.expected !== clientDecisionSnapshot(state, input.decisionId)) return { ok: false, error: 'Решение обновилось. Закройте форму и откройте её заново.' };
  if (!clientDecisionOptions(decision.id).includes(input.choice)) return { ok: false, error: 'Выберите один из предложенных вариантов.' };
  if (decision.status === 'decided') return decision.choice === input.choice
    ? { ok: true, changed: false, decision }
    : { ok: false, error: 'Решение уже подтверждено. Согласуйте изменение с управлением.' };
  if (decision.status !== 'waiting') return { ok: false, error: 'Решение недоступно для подтверждения.' };
  return { ok: true, changed: true, decision: { ...decision, status: 'decided', choice: input.choice } };
};
