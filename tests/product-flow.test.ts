import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('owner workspace exposes logout and hides client cabinet navigation', async () => {
  const app = await read('src/App.tsx');
  assert.match(app, /fetch\('\/api\/auth\/logout'/);
  assert.match(app, /Выйти из аккаунта/);
  assert.match(app, /!\['settings', 'client'\]\.includes\(item\.id\)/);
  const overview = await read('src/pages/OverviewPage.tsx');
  assert.doesNotMatch(overview, /Кабинет клиента/);
  assert.doesNotMatch(overview, /onNavigate\('client'\)/);
});

test('training can be dismissed and is replaced by durable developer feedback', async () => {
  const help = await read('src/components/HelpCenter.tsx');
  const app = await read('src/App.tsx');
  const feedback = await read('src/components/DeveloperFeedback.tsx');
  assert.match(help, /stroios\.help\.completed\.v1/);
  assert.match(help, /Закрыть обучение/);
  assert.match(app, /<DeveloperFeedback/);
  assert.match(feedback, /developerRequests: \[request, \.\.\.state\.developerRequests\]/);
});

test('public website leads are accepted and announced to Telegram', async () => {
  const worker = await read('sites/worker.js');
  assert.match(worker, /PUBLIC_LEAD_ORIGINS = new Set\(\['https:\/\/ikioma\.ru', 'https:\/\/www\.ikioma\.ru'\]\)/);
  assert.match(worker, /ИКИОМА ОС · новая заявка с сайта/);
  assert.match(worker, /publicWebsiteForm: true/);
});
