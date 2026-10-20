import type { CounterpartyProfile, ProjectDocument } from '../entities/index';
import type { ContactsSnapshot, ContactsPatch } from '../domain/contexts.ts';
import { moduleChange, executeModule, type ModuleChange, type ModuleRepository } from './module-repository.ts';
import { counterpartySnapshot, normalizeCounterparty } from '../domain/counterparties.ts';
import { prepareCounterpartyDocument, type CounterpartyDocumentDraft } from '../domain/counterparty-documents.ts';
import type { Clock, IdGenerator } from './ports.ts';

export interface SaveCounterpartyInput { draft: CounterpartyProfile; expected: string }
export type CounterpartyCommandResult = { ok: true; profile: CounterpartyProfile; change: ModuleChange<ContactsPatch> | null } | { ok: false; error: string };
export interface AddCounterpartyDocumentInput { counterpartyId: string; expected: string; draft: CounterpartyDocumentDraft }
export type CounterpartyDocumentResult = { ok: true; document: ProjectDocument; change: ModuleChange<ContactsPatch> } | { ok: false; error: string };

export const addProjectCounterpartyDocument = (state: ContactsSnapshot, input: AddCounterpartyDocumentInput, actor: string, clock: Clock, ids: IdGenerator): CounterpartyDocumentResult => {
  if (!state.counterparties.some(profile => profile.id === input.counterpartyId)) return { ok: false, error: 'Контрагент недоступен. Закройте форму и обновите справочник.' };
  if (input.expected !== counterpartySnapshot(state, input.counterpartyId)) return { ok: false, error: 'Карточка контрагента обновилась. Закройте форму и откройте её заново.' };
  const timestamp = clock.now();
  const result = prepareCounterpartyDocument(input.draft, input.counterpartyId, ids.next('document'), timestamp);
  if (!result.ok) return result;
  const summary = `Добавлен документ ${result.document.name}`;
  return { ok: true, document: result.document, change: moduleChange(state, { appendDocuments: [result.document] }, 'document_updated', summary, { identity: { name: actor }, clock: { now: () => timestamp }, ids }) };
};

export const saveProjectCounterparty = (state: ContactsSnapshot, input: SaveCounterpartyInput, actor: string, clock: Clock, ids: IdGenerator): CounterpartyCommandResult => {
  const existing = input.draft.id ? state.counterparties.find(item => item.id === input.draft.id) : undefined;
  if (input.draft.id && !existing) return { ok: false, error: 'Карточка удалена. Закройте форму и обновите справочник.' };
  if (input.expected !== counterpartySnapshot(state, input.draft.id)) return { ok: false, error: 'Карточка обновилась. Закройте форму и откройте её заново.' };
  const result = normalizeCounterparty(input.draft);
  if (!result.ok) return result;
  const profile = { ...result.profile, id: existing?.id || ids.next('counterparty') };
  if (existing && JSON.stringify(profile) === JSON.stringify(existing)) return { ok: true, profile: existing, change: null };
  const timestamp = clock.now();
  const summary = `${existing ? 'Обновлена' : 'Создана'} карточка контрагента ${profile.name}`;
  return { ok: true, profile, change: moduleChange(state, { counterparties: existing ? state.counterparties.map(item => item.id === profile.id ? profile : item) : [profile, ...state.counterparties] }, 'counterparty_updated', summary, { identity: { name: actor }, clock: { now: () => timestamp }, ids }) };
};

// Authorization, revisions and persistence remain enforced by the existing server/sync boundary.
export const createCounterpartyUseCases = (repository: ModuleRepository<ContactsSnapshot, ContactsPatch>, actor: string, clock: Clock, ids: IdGenerator) => ({
 addDocument: (input: AddCounterpartyDocumentInput) => executeModule(repository, state => addProjectCounterpartyDocument(state, input, actor, clock, ids)),
 saveProfile: (input: SaveCounterpartyInput) => executeModule(repository, state => saveProjectCounterparty(state, input, actor, clock, ids)),
});
