import type { AppState, CounterpartyProfile, ProjectDocument } from '../entities/index';
import type { StateChange } from '../domain/change';
import { counterpartySnapshot, normalizeCounterparty } from '../domain/counterparties.ts';
import { prepareCounterpartyDocument, type CounterpartyDocumentDraft } from '../domain/counterparty-documents.ts';
import type { Clock, IdGenerator } from './ports';
import { commitStateChange, type StateChangeSink } from './state-change.ts';

export interface SaveCounterpartyInput { draft: CounterpartyProfile; expected: string }
export type CounterpartyCommandResult = { ok: true; profile: CounterpartyProfile; change: StateChange | null } | { ok: false; error: string };
export interface AddCounterpartyDocumentInput { counterpartyId: string; expected: string; draft: CounterpartyDocumentDraft }
export type CounterpartyDocumentResult = { ok: true; document: ProjectDocument; change: StateChange } | { ok: false; error: string };

export const addProjectCounterpartyDocument = (state: AppState, input: AddCounterpartyDocumentInput, actor: string, clock: Clock, ids: IdGenerator): CounterpartyDocumentResult => {
  if (!state.counterparties.some(profile => profile.id === input.counterpartyId)) return { ok: false, error: 'Контрагент недоступен. Закройте форму и обновите справочник.' };
  if (input.expected !== counterpartySnapshot(state, input.counterpartyId)) return { ok: false, error: 'Карточка контрагента обновилась. Закройте форму и откройте её заново.' };
  const timestamp = clock.now();
  const result = prepareCounterpartyDocument(input.draft, input.counterpartyId, ids.next('document'), timestamp);
  if (!result.ok) return result;
  const summary = `Добавлен документ ${result.document.name}`;
  return { ok: true, document: result.document, change: {
    action: 'document_updated', summary,
    state: { ...state, documents: [result.document, ...state.documents], activity: [{ id: ids.next('activity'), timestamp, actor, text: summary, tone: 'neutral' }, ...state.activity] },
  } };
};

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
  addDocument: (input: AddCounterpartyDocumentInput) => {
    const result = addProjectCounterpartyDocument(state, input, actor, clock, ids);
    if (result.ok) commitStateChange(result.change, sink);
    return result;
  },
  saveProfile: (input: SaveCounterpartyInput) => {
    const result = saveProjectCounterparty(state, input, actor, clock, ids);
    if (result.ok && result.change) commitStateChange(result.change, sink);
    return result;
  },
});
