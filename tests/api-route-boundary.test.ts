import assert from 'node:assert/strict';
import test from 'node:test';

import { createApiHandler } from '../sites/routes/api.js';

const handlers = () => {
  const calls: string[] = [];
  const handler = (name: string) => async () => { calls.push(name); return new Response(name); };
  return {
    calls,
    values: {
      session: handler('session'), accessUsers: handler('accessUsers'), getState: handler('getState'), putState: handler('putState'), projects: handler('projects'),
      integrationStatus: handler('integrationStatus'), integrationTest: handler('integrationTest'), telegramChatSelect: handler('telegramChatSelect'), telegramLink: handler('telegramLink'), telegramUnlink: handler('telegramUnlink'), telegramBootstrap: handler('telegramBootstrap'), telegramUpdate: handler('telegramUpdate'),
      cameraStatus: handler('cameraStatus'), cameraView: handler('cameraView'), qualityPhotoUpload: handler('qualityPhotoUpload'), qualityPhotoFile: handler('qualityPhotoFile'), documentUpload: handler('documentUpload'), documentFile: handler('documentFile'), fieldReportFile: handler('fieldReportFile'), leadInbox: handler('leadInbox'), publicLead: handler('publicLead'), developerFeedback: handler('developerFeedback'), audit: handler('audit'),
    },
  };
};

test('API boundary dispatches only exact paths and methods', async () => {
  const setup = handlers();
  const api = createApiHandler(setup.values);
  assert.equal((await api(new Request('https://example.test/api/state'), {}, {})).status, 200);
  assert.deepEqual(setup.calls, ['getState']);
  assert.equal((await api(new Request('https://example.test/api/state', { method: 'POST' }), {}, {})).status, 404);
  assert.equal((await api(new Request('https://example.test/api/state/extra'), {}, {})).status, 404);
  assert.deepEqual(setup.calls, ['getState']);
});

test('authenticated API routes reject cross-origin requests before their handler', async () => {
  const setup = handlers();
  const api = createApiHandler(setup.values);
  const response = await api(new Request('https://example.test/api/projects', { headers: { Origin: 'https://attacker.test' } }), {}, {});
  assert.equal(response.status, 403);
  assert.deepEqual(setup.calls, []);
});

test('public lead ingress reaches only its dedicated boundary', async () => {
  const setup = handlers();
  const api = createApiHandler(setup.values);
  const response = await api(new Request('https://example.test/api/public/leads', { method: 'OPTIONS', headers: { Origin: 'https://ikioma.ru' } }), {}, {});
  assert.equal(response.status, 200);
  assert.deepEqual(setup.calls, ['publicLead']);
});
