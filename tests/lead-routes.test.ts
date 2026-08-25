import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { createLeadHandlers } from '../sites/leads/routes.js';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const handlers = () => createLeadHandlers({
  ensureSchema: async () => { throw new Error('unexpected_schema_access'); },
  readSnapshot: async () => { throw new Error('unexpected_snapshot_access'); },
  resolveTelegramConnection: async () => { throw new Error('unexpected_telegram_access'); },
  telegramSend: async () => { throw new Error('unexpected_telegram_send'); },
  deepLink: () => 'https://example.test',
});

test('public lead ingress rejects untrusted origins before storage access', async () => {
  const response = await handlers().publicLead(new Request('https://app.test/api/public/leads', {
    method: 'POST',
    headers: { Origin: 'https://attacker.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Иван', phone: '+7 999 000-00-00' }),
  }), { DB: {} });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { ok: false, error: 'forbidden_origin' });
});

test('public lead preflight is limited to the approved origin and methods', async () => {
  const response = await handlers().publicLead(new Request('https://app.test/api/public/leads', {
    method: 'OPTIONS',
    headers: { Origin: 'https://ikioma.ru' },
  }), {});

  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://ikioma.ru');
  assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
});

test('public lead validates method, storage and fields before persistence', async () => {
  const origin = { Origin: 'https://www.ikioma.ru' };
  assert.equal((await handlers().publicLead(new Request('https://app.test/api/public/leads', { headers: origin }), {})).status, 405);
  assert.equal((await handlers().publicLead(new Request('https://app.test/api/public/leads', {
    method: 'POST', headers: { ...origin, 'Content-Type': 'application/json' }, body: '{}',
  }), {})).status, 503);
  assert.equal((await handlers().publicLead(new Request('https://app.test/api/public/leads', {
    method: 'POST', headers: { ...origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Иван', phone: '123' }),
  }), { DB: {} })).status, 422);
});

test('honeypot submissions are accepted without touching storage', async () => {
  const response = await handlers().publicLead(new Request('https://app.test/api/public/leads', {
    method: 'POST',
    headers: { Origin: 'https://ikioma.ru', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Bot', phone: '+7 999 000-00-00', company: 'spam' }),
  }), { DB: {} });

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true });
});

test('lead routes stay outside the Worker and retain their security boundary', () => {
  const worker = source('sites/worker.js');
  const leads = source('sites/leads/routes.js');

  assert.match(worker, /from '\.\/leads\/routes\.js'/);
  assert.doesNotMatch(worker, /const handlePublicLead/);
  assert.doesNotMatch(worker, /INSERT INTO lead_inbox/);
  assert.match(leads, /PUBLIC_LEAD_ORIGINS = new Set\(\['https:\/\/ikioma\.ru', 'https:\/\/www\.ikioma\.ru'\]\)/);
  assert.match(leads, /payload = await readJsonBodyLimited\(request, PUBLIC_LEAD_BODY_LIMIT\)/);
  assert.match(leads, /authenticatedIdentity\(request, env\)/);
  assert.match(leads, /projectIdentity\(request, env, snapshot\.state\)/);
});
