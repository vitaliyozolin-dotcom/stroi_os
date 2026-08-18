import assert from 'node:assert/strict';
import test from 'node:test';

import { createFileHandlers } from '../sites/files/routes.js';

const state = (role: 'management' | 'foreman' | 'client', clientVisible = false) => ({
  project: { id: 'project-a' },
  settings: {
    users: [{ id: 'user-1', email: 'user@example.test', name: 'Пользователь', role, status: 'active' }],
  },
  checkpoints: [{
    id: 'checkpoint-1',
    clientVisible,
    photos: [{ fileKey: 'project-a/quality/checkpoint-1/photo.png', fileName: 'photo.png' }],
  }],
  documents: [{ fileKey: 'project-a/document.pdf', fileName: 'document.pdf', clientVisible }],
  fieldReports: [{
    clientVisible,
    attachments: [{ key: 'project-a/field/report.pdf', name: 'report.pdf' }],
  }],
});

const request = (path: string, authenticated = true) => new Request(`https://app.example.test${path}`, {
  headers: authenticated ? { 'oai-authenticated-user-email': 'user@example.test' } : {},
});

const handlers = (snapshot: unknown) => createFileHandlers({
  ensureSchema: async () => undefined,
  readSnapshot: async () => ({ state: snapshot }),
});

test('file routes reject unauthenticated access before reading the bucket', async () => {
  let reads = 0;
  const response = await handlers(state('management')).documentFile(
    request('/api/documents/file?projectId=project-a&key=project-a%2Fdocument.pdf', false),
    { DB: {}, BUCKET: { get: async () => { reads += 1; return null; } } },
  );

  assert.equal(response.status, 403);
  assert.equal(reads, 0);
});

test('file routes reject cross-project keys before storage access', async () => {
  let reads = 0;
  const response = await handlers(state('management')).documentFile(
    request('/api/documents/file?projectId=project-a&key=project-b%2Fdocument.pdf'),
    { DB: {}, BUCKET: { get: async () => { reads += 1; return null; } } },
  );

  assert.equal(response.status, 422);
  assert.equal(reads, 0);
});

test('client-hidden file metadata fails closed without revealing bucket existence', async () => {
  let reads = 0;
  const response = await handlers(state('client', false)).fieldReportFile(
    request('/api/field-reports/file?projectId=project-a&key=project-a%2Ffield%2Freport.pdf'),
    { DB: {}, BUCKET: { get: async () => { reads += 1; return null; } } },
  );

  assert.equal(response.status, 404);
  assert.equal(reads, 0);
});
