import test from 'node:test';
import assert from 'node:assert/strict';
import { seedState } from '../src/seed.ts';
import { uploadFieldReport } from '../src/application/field-reports.ts';
const now = '2026-10-20T12:00:00Z', clock = { now: () => now }, identity = { name: 'Прораб', role: 'foreman' as const };
const ids = () => { let index = 0; return { next: (prefix: string) => `${prefix}-${++index}` }; };
const input = (projectId: string) => ({ projectId, files: [new File(['test'], 'photo.jpg', {type: 'image/jpeg'})], date: '2026-10-20', note: 'Факт на объекте', stageId: '', sourceLink: 'https://t.me/project/1' });
const metadata = (projectId: string) => ({ key: `${projectId}/photo.jpg`, name: 'photo.jpg', type: 'image/jpeg', size: 4, uploadedAt: now });
test('photo workflow keeps latest records, creates a private report and does not fabricate acceptance', async () => {
 const state = structuredClone(seedState); let writes = 0;
 const result = await uploadFieldReport(() => state, input(state.project.id), identity, clock, ids(), { upload: async projectId => { state.activity.unshift({id: 'parallel', timestamp: now, actor: 'Другой', text: 'Изменение', tone: 'neutral'}); return metadata(projectId); } }, (next, audit) => { writes++; assert.equal(next.activity[1].id, 'parallel'); assert.equal(audit?.action, 'field_report_uploaded'); }, new AbortController().signal);
 assert.ok(result.ok); if (!result.ok) return; assert.equal(writes, 1); assert.equal(result.change.state.fieldReports[0].clientVisible, false); assert.equal(result.change.state.fieldReports[0].attachments.length, 1); assert.deepEqual(result.change.state.checkpoints, state.checkpoints); assert.deepEqual(result.change.state.financeEntries, state.financeEntries);
});
test('invalid photo/date/source and duplicate source are rejected before upload', async () => {
 for (const mode of ['file', 'date', 'url', 'duplicate', 'role']) {
  const state = structuredClone(seedState), command = input(state.project.id); let uploads = 0;
  if (mode === 'file') command.files = [new File(['test'], 'fake.pdf', {type: 'application/pdf'})];
  if (mode === 'date') command.date = '2027-01-01'; if (mode === 'url') command.sourceLink = 'https://example.test/1';
  if (mode === 'duplicate') state.fieldReports.unshift({id: 'existing', createdAt: now, note: command.sourceLink, author: 'Прораб', source: 'web', clientVisible: false, attachments: []});
  const result = await uploadFieldReport(() => state, command, mode === 'role' ? { ...identity, role: 'client' } : identity, clock, ids(), { upload: async projectId => { uploads++; return metadata(projectId); } }, () => { throw new Error('Unexpected write'); }, new AbortController().signal);
  assert.equal(result.ok, false); assert.equal(uploads, 0);
 }
});
test('cancel, cross-project attachment, late duplicate and project switch never register a partial report', async () => {
 for (const mode of ['cancel','foreign','duplicate','project']) {
  const state = structuredClone(seedState), command = input(state.project.id), controller = new AbortController(); let writes = 0;
  const result = await uploadFieldReport(() => state, command, identity, clock, ids(), { upload: async projectId => {
   if (mode === 'cancel') controller.abort(); if (mode === 'project') state.project.id = 'other';
   if (mode === 'duplicate') state.fieldReports.unshift({id: 'existing', createdAt: now, note: command.sourceLink, author: 'Прораб', source: 'web', clientVisible: false, attachments: []});
   return metadata(mode === 'foreign' ? 'other' : projectId);
  } }, () => { writes++; }, controller.signal);
  assert.equal(result.ok, false); assert.equal(writes, 0);
 }
});
