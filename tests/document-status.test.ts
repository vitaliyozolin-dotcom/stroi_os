import test from 'node:test';
import assert from 'node:assert/strict';
import { updateProjectDocumentStatus } from '../src/application/project-records.js';
import { createDocumentsRepository } from '../src/infrastructure/module-project.ts';
import { seedState } from '../src/seed.ts';

test('signature status requires management, original and confirmation, retaining file and audit', () => {
  let state = structuredClone(seedState);
  state.documents = [{ id: 'doc', name: 'Договор', type: 'Договор', status: 'draft', updatedAt: '2026-11-01', clientVisible: false }];
  const repository = createDocumentsRepository(() => state, next => { state = next; });
  const context = { identity: { name: 'Владелец', role: 'management' as const }, clock: { now: () => '2026-11-17T10:00:00.000Z' }, ids: { next: () => 'status-event' } };
  assert.equal(updateProjectDocumentStatus(repository, { id: 'doc', status: 'signed', confirmSignedOriginal: true }, context).ok, false);
  state.documents[0].fileKey = `${state.project.id}/contract.pdf`;
  assert.equal(updateProjectDocumentStatus(repository, { id: 'doc', status: 'signed' }, context).ok, false);
  assert.equal(updateProjectDocumentStatus(repository, { id: 'doc', status: 'signed', confirmSignedOriginal: true }, { ...context, identity: { name: 'Прораб', role: 'foreman' } }).ok, false);
  assert.equal(state.documents[0].status, 'draft');
  assert.equal(updateProjectDocumentStatus(repository, { id: 'doc', status: 'signed', confirmSignedOriginal: true }, context).ok, true);
  assert.equal(state.documents[0].status, 'signed');
  assert.equal(state.documents[0].fileKey, `${state.project.id}/contract.pdf`);
  assert.match(state.activity[0].text, /Подписан/);
  assert.equal(state.activity[0].actor, 'Владелец');
});
