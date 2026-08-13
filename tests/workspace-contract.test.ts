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

test('the user-facing product is consistently branded as IKIOMA OS', () => {
  const userFacingFiles = [
    'index.html',
    'src/App.tsx',
    'src/components/CounterpartyModal.tsx',
    'src/components/HelpCenter.tsx',
    'src/pages/ClientPage.tsx',
    'src/pages/FinancePage.tsx',
    'src/pages/MarketingPage.tsx',
    'src/pages/ProjectPage.tsx',
    'src/pages/SettingsPage.tsx',
    'src/seed.ts',
    'sites/worker.js',
  ].map(source).join('\n');

  assert.doesNotMatch(userFacingFiles, /СтройОС|СТРОЙОС/);
  assert.match(source('src/App.tsx'), /ИКИОМА <span>ОС<\/span>/);
  assert.match(source('src/components/HelpCenter.tsx'), /Обучение ИКИОМА ОС/);
});

test('lead timing and conversational Telegram summaries are visible and supported', () => {
  const marketing = source('src/pages/MarketingPage.tsx');
  const settings = source('src/pages/SettingsPage.tsx');
  const worker = source('sites/worker.js');

  assert.match(marketing, /Поступила: \{formatDateTime\(lead\.createdAt\)\}/);
  assert.match(settings, /Формы на ikioma\.ru/);
  assert.match(worker, /command\.name === 'stages'/);
  assert.match(worker, /command\.name === 'done'/);
  assert.match(worker, /command\.name === 'finance'/);
  assert.match(worker, /command: 'finance'/);
  assert.match(worker, /naturalTelegramIntent/);
  assert.match(worker, /repliedToBot/);
});


test('Telegram common chat recheck is webhook-backed, observable and honestly labelled', () => {
  const settings = source('src/pages/SettingsPage.tsx');
  const worker = source('sites/worker.js');

  assert.match(worker, /CREATE TABLE IF NOT EXISTS telegram_chat_candidates/);
  assert.match(worker, /rememberTelegramChatCandidates\(env\.DB, update\)/);
  assert.match(worker, /readObservedTelegramChats/);
  assert.match(worker, /verifyAndStoreTelegramChat\(env, chat, bot\)/);
  assert.match(settings, /const recheckTelegram = async/);
  assert.match(settings, /integrationChecking \? 'Проверяем…'/);
  assert.match(settings, /telegramHeadquartersReady = Boolean\(integrationStatus\?\.telegramCommon && integrationStatus\?\.telegramInbound\)/);
  assert.match(settings, /aria-live="polite"/);
});


test('Telegram uses the VPS host network relay and reports real upstream failures', () => {
  const compose = source('compose.yaml');
  const relay = source('server/telegram-relay.js');
  const repair = source('server/repair-telegram.js');
  const worker = source('sites/worker.js');

  assert.match(compose, /telegram-relay:/);
  assert.match(compose, /network_mode: host/);
  assert.match(compose, /TELEGRAM_API_BASE: http:\/\/host\.docker\.internal:18787/);
  assert.match(compose, /TELEGRAM_RELAY_SECRET:/);
  assert.doesNotMatch(compose, /telegram_ipv6:/);
  assert.match(relay, /family: 6/);
  assert.match(relay, /isPrivateRelayClient/);
  assert.match(relay, /relay_secret_invalid/);
  assert.match(repair, /TELEGRAM_API_BASE/);
  assert.match(repair, /networkErrorDetails/);
  assert.match(repair, /сеть контейнера недоступна/);
  assert.match(worker, /telegramApiUrl/);
  assert.match(worker, /telegramTransportHeaders/);
});

test('Telegram explains exactly what is read, drafted, saved or ignored', () => {
  const worker = source('sites/worker.js');

  assert.match(worker, /command\.name === 'note'/);
  assert.match(worker, /action === 'nc'/);
  assert.match(worker, /state\.fieldReports = \[report/);
  assert.match(worker, /Ничего не записано в ИКИОМА ОС/);
  assert.match(worker, /Молчание никогда не означает сохранение/);
  assert.match(worker, /telegramCommandSuggestion/);
  assert.match(worker, /command: 'note'/);
  assert.match(worker, /naturalTelegramCommand/);
  assert.match(worker, /addressedToBot/);
});
