import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('management overview has no route into the client cabinet', async () => {
  const overview = await read('src/pages/OverviewPage.tsx');
  assert.doesNotMatch(overview, /Кабинет клиента/);
  assert.doesNotMatch(overview, /onNavigate\('client'\)/);
});
