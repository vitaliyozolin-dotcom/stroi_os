import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('management workspace has a real profile logout and no client-cabinet navigation', () => {
  const app = source('src/App.tsx');
  const overview = source('src/pages/OverviewPage.tsx');

  assert.match(app, /action="\/api\/auth\/logout" method="post"/);
  assert.match(app, /return fullNavigation\.filter\(\(item\) => item\.id !== 'settings' && item\.id !== 'client'\)/);
  assert.match(app, /Object\.keys\(pageLabels\)\.filter\(\(item\) => item !== 'client'\)/);
  assert.doesNotMatch(overview, /onNavigate\('client'\)/);
});

test('training can be dismissed and is replaced with developer feedback', () => {
  const help = source('src/components/HelpCenter.tsx');

  assert.match(help, /aria-label="Закрыть обучение и открыть правки разработчику"/);
  assert.match(help, /showFeedbackFab \? setFeedbackOpen\(true\) : setOpen\(true\)/);
  assert.match(help, /fetch\('\/api\/developer-feedback'/);
  assert.match(help, /completed\.length >= topics\.length/);
  assert.match(help, /else onCloseProjects\(\)/);
});

test('IKIOMA lead ingress is public only for the dedicated endpoint and protected origins', () => {
  const routes = source('server/public-routes.js');
  const worker = source('sites/worker.js');

  assert.match(routes, /'\/api\/public\/leads'/);
  assert.match(worker, /https:\/\/ikioma\.ru/);
  assert.match(worker, /https:\/\/www\.ikioma\.ru/);
  assert.match(worker, /PUBLIC_LEAD_PROJECT_ID = 'ikioma-sales'/);
  assert.match(worker, /telegramNotified/);
  assert.match(worker, /duplicateAfter/);
  assert.match(worker, /timeoutMs: 3_000/);
});
