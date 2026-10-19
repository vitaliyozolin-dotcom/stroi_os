import type { AppState, CounterpartyProfile } from '../entities/index';
import type { StateChange } from '../domain/change';
import { counterpartySnapshot, normalizeCounterparty } from '../domain/counterparties.ts';
import type { Clock, IdGenerator } from './ports';
import { commitStateChange, type StateChangeSink } from './state-change.ts';

export interface SaveCounterpartyInput { draft: CounterpartyProfile; expected: string }
export type CounterpartyCommandResult = { ok: true; profile: CounterpartyProfile; change: StateChange | null } | { ok: false; error: string };

export const saveProjectCounterparty = (state: AppState, input: SaveCounterpartyInput, actor: string, clock: Clock, ids: IdGenerator): CounterpartyCommandResult => {
  const existing = input.draft.id ? state.counterparties.find(item => item.id === input.draft.id) : undefined;
  if (input.draft.id && !existing) return { ok: false, error: 'Карточка удалена. Закройте форму и обновите справочник.' };
  if (input.expected !== counterpartySnapshot(state, input.draft.id)) return { ok: false, error: 'Карточка обновилась. Закройте форму и откройте её заново.' };
  const result = normalizeCounterparty(input.draft);
  if (!result.ok) return result;
  const profile = { ...result.profile, id: existing?.id || ids.next('counterparty') };
  if (existing && JSON.stringify(profile) === JSON.stringify(existing)) return { ok: true, profile: existing, change: null };
  const timestamp = clock.now();
  const summary = `${existing ? 'Обновлена' : 'Создана'} карточка контрагента ${profile.name}`;
  return { ok: true, profile, change: {
    action: 'counterparty_updated', summary,
    state: {
      ...state,
      counterparties: existing ? state.counterparties.map(item => item.id === profile.id ? profile : item) : [profile, ...state.counterparties],
      activity: [{ id: ids.next('activity'), timestamp, actor, text: summary, tone: 'neutral' }, ...state.activity],
    },
  } };
};

// Authorization, revisions and persistence remain enforced by the existing server/sync boundary.
export const createCounterpartyUseCases = (state: AppState, actor: string, clock: Clock, ids: IdGenerator, sink: StateChangeSink) => ({
  saveProfile: (input: SaveCounterpartyInput) => {
    const result = saveProjectCounterparty(state, input, actor, clock, ids);
    if (result.ok && result.change) commitStateChange(result.change, sink);
    return result;
  },
});
