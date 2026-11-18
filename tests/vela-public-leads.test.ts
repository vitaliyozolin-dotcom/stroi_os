import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createLeadHandlers } from '../sites/leads/routes.js';

const origin = 'https://ikioma.ru';
const catalog = {
  version: '2026-11-13.1', validFrom: '2026-11-13',
  base: { id: 'kit', title: 'Домокомплект ВЕЛА', price: 1725000 },
  groups: [{ services: [{ id: 'foundation', title: 'Фундамент', price: 228000 }, { id: 'well', title: 'Скважина', price: null }] }],
};
const payload = () => ({
  version: 2, project: 'ВЕЛА', requestId: crypto.randomUUID(), kind: 'estimate',
  phone: '+70000000000', email: 'vela-test@example.com', name: 'TEST ВЕЛА', comment: 'Проверка',
  land: 'own', selection: ['foundation', 'well'], catalogVersion: catalog.version, page: '/na-svoem-uchastke/',
  attribution: { utm: { utm_source: 'qa', utm_campaign: 'release' } },
  mortgage: { budget: 3000000, down: 25, years: 10, rate: 0 },
  consent: { accepted: true, version: 'pd-20261113-v2' },
});
function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE lead_inbox (id TEXT PRIMARY KEY, project_id TEXT, created_at TEXT, name TEXT, phone TEXT, email TEXT, source TEXT, message TEXT, status TEXT, vela_details TEXT);
    CREATE TABLE public_lead_rate_limits (key TEXT, window_start TEXT, attempts INTEGER, updated_at TEXT, PRIMARY KEY(key,window_start));
  `);
  const DB = { prepare: (sql: string) => ({ bind: (...params: string[]) => ({
    async first() { return sqlite.prepare(sql).get(...params); },
    async run() { return sqlite.prepare(sql).run(...params); },
  }) }) };
  const alerts: string[] = [];
  const handlers = createLeadHandlers({
    ensureSchema: async () => {},
    readSnapshot: async () => null,
    resolveTelegramConnection: async () => ({ chat: { id: 'local-test' } }),
    telegramSend: async (_token: string, _chat: string, text: string) => { alerts.push(text); return { ok: true }; },
    deepLink: (_origin: string, _project: string, _section: string, id: string) => 'https://example.test/' + id,
    loadVelaCatalog: async () => catalog,
  });
  const submit = (body: unknown) => handlers.publicLead(new Request(origin + '/api/public/leads', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'oai-client-ip': '192.0.2.1' }, body: JSON.stringify(body),
  }), { DB, TELEGRAM_BOT_TOKEN: 'local-test' });
  return { sqlite, alerts, submit };
}

test('VELA persists the authoritative quote and mortgage in the existing funnel; concurrent retries return the same ID', async () => {
  const { sqlite, alerts, submit } = setup();
  const item = payload();
  const responses = await Promise.all([submit({ ...item, total: 1 }), submit(item)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 201]);
  for (const response of responses) assert.equal((await response.json()).leadId, item.requestId);
  const rows = sqlite.prepare('SELECT * FROM lead_inbox').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].project_id, 'ikioma-sales');
  assert.equal(rows[0].source, 'website');
  assert.equal(rows[0].name, 'TEST ВЕЛА');
  const { detail } = JSON.parse(String(rows[0].vela_details));
  assert.equal(detail.total, 1953000);
  assert.deepEqual(detail.pending, [{ id: 'well', title: 'Скважина' }]);
  assert.equal(detail.mortgage.payment, 18750);
  assert.equal(detail.consent.version, 'pd-20261113-v2');
  assert.equal(detail.attribution.utm.utm_campaign, 'release');
  assert.equal(alerts.length, 1);
  assert.doesNotMatch(alerts[0], /00000000|vela-test|Проверка/);
  assert.equal((await submit({ ...item, comment: 'Other' })).status, 409);
  sqlite.close();
});

test('VELA rejects changed price versions and missing consent before creating a funnel record', async () => {
  const { sqlite, submit } = setup();
  const item = payload();
  const stale = await submit({ ...item, catalogVersion: '2026-10-01.1' });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, 'catalog_changed');
  assert.equal((await submit({ ...item, consent: null })).status, 422);
  assert.equal((await submit({ ...item, selection: ['unknown'] })).status, 422);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM lead_inbox').get()?.n, 0);
  sqlite.close();
});
