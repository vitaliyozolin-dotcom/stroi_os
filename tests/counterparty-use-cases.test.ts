import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { seedState } from '../src/seed.ts';
import type { CounterpartyProfile } from '../src/entities/index.ts';
import { counterpartySnapshot, normalizeCounterparty } from '../src/domain/counterparties.ts';
import { createCounterpartyUseCases, saveProjectCounterparty } from './support/module-project.ts';

const now = '2026-10-19T12:00:00Z';
const clock = { now: () => now };
const ids = { next: (prefix: string) => `${prefix}-test` };
const draft = (): CounterpartyProfile => ({ id: '', name: '  Поставщик  ', type: 'supplier', status: 'probation', phone: ' +7 000 ', inn: ' 123 ', tags: [' материалы ', ' ', 'склад'], notes: ' Заметка ' });
const fixture = () => { const state = structuredClone(seedState); state.counterparties = []; return state; };

test('creation normalizes details, injects time/IDs and keeps all unrelated state immutable', () => {
  const state = fixture(), before = structuredClone(state);
  const result = saveProjectCounterparty(state, { draft: draft(), expected: counterpartySnapshot(state, '') }, 'Управляющий', clock, ids);
  assert.ok(result.ok && result.change);
  if (!result.ok || !result.change) return;
  assert.deepEqual(state, before);
  assert.equal(result.profile.id, 'counterparty-test');
  assert.equal(result.profile.name, 'Поставщик');
  assert.equal(result.profile.inn, '123');
  assert.deepEqual(result.profile.tags, ['материалы', 'склад']);
  assert.equal(result.change.action, 'counterparty_updated');
  assert.deepEqual(result.change.state.financeEntries, state.financeEntries);
  assert.deepEqual(result.change.state.documents, state.documents);
  assert.equal(result.change.state.activity[0].timestamp, now);
  assert.equal(result.change.state.activity[0].actor, 'Управляющий');
});

test('update keeps identity and linked records and never recreates a deleted card', () => {
  const state = fixture(); state.counterparties = [{ ...draft(), id: 'existing' }];
  const input = { draft: { ...state.counterparties[0], name: 'Новое название' }, expected: counterpartySnapshot(state, 'existing') };
  const result = saveProjectCounterparty(state, input, 'Автор', clock, ids);
  assert.ok(result.ok && result.change);
  if (!result.ok || !result.change) return;
  assert.equal(result.profile.id, 'existing');
  assert.equal(result.change.state.counterparties.length, 1);
  assert.deepEqual(result.change.state.stages, state.stages);
  state.counterparties = [];
  assert.equal(saveProjectCounterparty(state, input, 'Автор', clock, ids).ok, false);
});

test('changed card or project invalidates an open form; unrelated changes remain intact', () => {
  const state = fixture(); state.counterparties = [{ ...draft(), id: 'existing' }];
  const input = { draft: { ...state.counterparties[0], name: 'Черновик' }, expected: counterpartySnapshot(state, 'existing') };
  state.counterparties[0].phone = 'Изменён другим участником';
  assert.equal(saveProjectCounterparty(state, input, 'Автор', clock, ids).ok, false);
  const another = fixture(), creation = { draft: draft(), expected: counterpartySnapshot(another, '') };
  another.project.id = 'other';
  assert.equal(saveProjectCounterparty(another, creation, 'Автор', clock, ids).ok, false);
  const latest = fixture(), fresh = { draft: draft(), expected: counterpartySnapshot(latest, '') };
  latest.activity.unshift({ id: 'unrelated', text: 'Задача изменена', actor: 'Другой', timestamp: now, tone: 'neutral' });
  latest.counterparties.push({ ...draft(), id: 'other' });
  const result = saveProjectCounterparty(latest, fresh, 'Автор', clock, ids);
  assert.ok(result.ok && result.change);
  if (result.ok && result.change) {
    assert.equal(result.change.state.activity[1].id, 'unrelated');
    assert.equal(result.change.state.counterparties[1].id, 'other');
  }
});

test('invalid profiles do not write, and unchanged cards create no audit', () => {
  const state = fixture();
  let writes = 0;
  const useCases = createCounterpartyUseCases(state, 'Автор', clock, ids, () => { writes++; });
  assert.equal(useCases.saveProfile({ draft: { ...draft(), name: '  ' }, expected: counterpartySnapshot(state, '') }).ok, false);
  assert.equal(writes, 0);
  const normalized = normalizeCounterparty(draft());
  assert.ok(normalized.ok);
  if (!normalized.ok) return;
  const profile = { ...normalized.profile, id: 'existing' };
  state.counterparties.push(profile);
  const result = createCounterpartyUseCases(state, 'Автор', clock, ids, () => { writes++; }).saveProfile({ draft: structuredClone(profile), expected: counterpartySnapshot(state, 'existing') });
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.change, null);
  assert.equal(writes, 0);
});

test('successful profile commands submit explicit audit metadata to the existing sync sink', () => {
  const state = fixture();
  let writes = 0;
  createCounterpartyUseCases(state, 'Автор', clock, ids, (next, metadata) => {
    writes++;
    assert.equal(next.counterparties[0].name, 'Поставщик');
    assert.equal(metadata?.action, 'counterparty_updated');
  }).saveProfile({ draft: draft(), expected: counterpartySnapshot(state, '') });
  assert.equal(writes, 1);
});

test('profile editor delegates state changes and domain depends only on entities', () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const page = read('src/pages/CounterpartiesPage.tsx');
  const profileHandler = page.slice(page.indexOf('  const saveProfile'), page.indexOf('  const addDocument'));
  assert.match(profileHandler, /counterparties\.saveProfile/);
  assert.doesNotMatch(profileHandler, /counterparties:|activity:|uid\(|new Date/);
  assert.match(page, /role="alert"/);
  assert.doesNotMatch(read('src/domain/counterparties.ts'), /from ['"][^'"]*(?:application|infrastructure|react)|\bfetch\(/);
});
