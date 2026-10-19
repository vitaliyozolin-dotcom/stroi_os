import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { seedState } from '../src/seed.ts';
import { counterpartySnapshot } from '../src/domain/counterparties.ts';
import type { CounterpartyDocumentDraft } from '../src/domain/counterparty-documents.ts';
import { addProjectCounterpartyDocument, createCounterpartyUseCases } from '../src/application/counterparties.ts';

const now = '2026-10-19T12:00:00.000Z';
const clock = { now: () => now };
const ids = { next: (prefix: string) => `${prefix}-test` };
const fixture = () => {
  const state = structuredClone(seedState);
  state.counterparties = [{ id: 'supplier', name: 'Поставщик', type: 'supplier', status: 'active' }];
  return state;
};
const draft = (): CounterpartyDocumentDraft => ({ name: '  Договор поставки  ', category: 'contract', number: ' 42 ', documentDate: '2026-10-19', status: 'current', direction: 'incoming', storageLocation: '  Офис  ' });
const command = (state: ReturnType<typeof fixture>) => ({ draft: draft(), counterpartyId: 'supplier', expected: counterpartySnapshot(state, 'supplier') });

test('counterparty document creation keeps original state and linked finances intact and audits one private record', () => {
  const state = fixture(), before = structuredClone(state);
  const result = addProjectCounterpartyDocument(state, command(state), 'Автор', clock, ids);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(state, before);
  assert.equal(result.document.id, 'document-test');
  assert.equal(result.document.name, 'Договор поставки');
  assert.equal(result.document.number, '42');
  assert.equal(result.document.storageLocation, 'Офис');
  assert.equal(result.document.counterpartyId, 'supplier');
  assert.equal(result.document.type, 'contract');
  assert.equal(result.document.clientVisible, false);
  assert.equal(result.document.receivedAt, now);
  assert.equal(result.document.sentAt, undefined);
  assert.equal(result.document.signedAt, undefined);
  assert.equal(result.document.fileKey, undefined);
  assert.equal(result.change.state.documents.length, state.documents.length + 1);
  assert.deepEqual(result.change.state.financeEntries, state.financeEntries);
  assert.deepEqual(result.change.state.counterparties, state.counterparties);
  assert.deepEqual(result.change.state.activity[0], { id: 'activity-test', timestamp: now, actor: 'Автор', text: 'Добавлен документ Договор поставки', tone: 'neutral' });
  assert.equal(result.change.action, 'document_updated');
});

test('incoming/outgoing/internal and signed/draft statuses retain their existing timestamp semantics', () => {
  for (const direction of ['incoming', 'outgoing', 'internal'] as const) {
    for (const status of ['signed', 'draft', 'current'] as const) {
      const state = fixture(), input = command(state);
      input.draft = { ...input.draft, direction, status };
      const result = addProjectCounterpartyDocument(state, input, 'Автор', clock, ids);
      assert.ok(result.ok);
      if (!result.ok) continue;
      assert.equal(result.document.receivedAt, direction === 'incoming' ? now : undefined);
      assert.equal(result.document.sentAt, direction === 'outgoing' ? now : undefined);
      assert.equal(result.document.signedAt, status === 'signed' ? now : undefined);
      assert.equal(result.document.clientVisible, false);
    }
  }
});

test('unknown/deleted counterparty, modified card and changed project reject the draft', () => {
  for (const mutate of [
    (state: ReturnType<typeof fixture>) => { state.counterparties = []; },
    (state: ReturnType<typeof fixture>) => { state.counterparties[0].name = 'Изменено'; },
    (state: ReturnType<typeof fixture>) => { state.project.id = 'other'; },
  ]) {
    const state = fixture(), input = command(state);
    mutate(state);
    const before = structuredClone(state);
    assert.equal(addProjectCounterpartyDocument(state, input, 'Автор', clock, ids).ok, false);
    assert.deepEqual(state, before);
  }
  const state = fixture();
  assert.equal(addProjectCounterpartyDocument(state, { ...command(state), counterpartyId: 'unknown' }, 'Автор', clock, ids).ok, false);
});

test('unrelated new documents/activity remain intact when submitting an open form', () => {
  const state = fixture(), input = command(state);
  state.documents.unshift({ id: 'another', name: 'Другой документ', type: 'other', status: 'current', updatedAt: now, clientVisible: false });
  state.activity.unshift({ id: 'another', actor: 'Другой', text: 'Обновление', timestamp: now, tone: 'neutral' });
  const result = addProjectCounterpartyDocument(state, input, 'Автор', clock, ids);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.change.state.documents[1].id, 'another');
  assert.equal(result.change.state.activity[1].id, 'another');
});

test('blank names, impossible dates and unsupported enums produce no writes', () => {
  for (const invalid of [
    { name: '  ' }, { documentDate: '2026-02-30' }, { documentDate: '2026-13-01' }, { documentDate: '2026-1-1' },
    { category: 'invalid' as CounterpartyDocumentDraft['category'] },
    { direction: 'invalid' as CounterpartyDocumentDraft['direction'] },
    { status: 'invalid' as CounterpartyDocumentDraft['status'] },
  ]) {
    const state = fixture(); let writes = 0;
    const result = createCounterpartyUseCases(state, 'Автор', clock, ids, () => { writes++; }).addDocument({ ...command(state), draft: { ...draft(), ...invalid } });
    assert.equal(result.ok, false);
    assert.equal(writes, 0);
  }
});

test('optional blank metadata stays absent and a successful command uses the revision-aware sink', () => {
  const state = fixture(); let writes = 0;
  const result = createCounterpartyUseCases(state, 'Автор', clock, ids, (next, metadata) => {
    writes++;
    assert.equal(metadata?.action, 'document_updated');
    assert.equal(next.documents[0].documentDate, undefined);
    assert.equal(next.documents[0].number, undefined);
    assert.equal(next.documents[0].storageLocation, undefined);
  }).addDocument({ ...command(state), draft: { ...draft(), documentDate: '', number: ' ', storageLocation: ' ' } });
  assert.ok(result.ok);
  assert.equal(writes, 1);
});

test('counterparty page only submits commands and has no generic whole-state write facade', () => {
  const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const page = read('src/pages/CounterpartiesPage.tsx');
  assert.match(page, /counterparties\.addDocument\(/);
  assert.match(page, /documentError && <p role="alert"/);
  assert.doesNotMatch(page, /createCounterpartyCommands|saveChange\(|documents:|activity:|uid\(/);
  assert.doesNotMatch(read('src/application/page-commands.ts'), /createCounterpartyCommands/);
});
