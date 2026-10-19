import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the financial domain has no UI, transport, SQL or runtime adapter dependencies', () => {
  for (const file of readdirSync(new URL('../src/domain/finance/', import.meta.url)).filter(file => file.endsWith('.js'))) {
    const code = source(`src/domain/finance/${file}`);
    const imports = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1]);
    assert.ok(imports.every(path => path.startsWith('./') || path === '../finance-totals.js'), file);
    assert.doesNotMatch(code, /\bfetch\(|\bwindow\.|\bdocument\.(?:querySelector|getElementById|createElement|body|head)\b|\.DB\b|\.prepare\(|process\.env|from ['"]react/, file);
  }
});

test('finance commands go through the domain and preserve the existing revision-aware persistence boundary', () => {
  const application = source('src/application/finance.ts');
  assert.match(application, /from '..\/domain\/finance\/index\.js'/);
  assert.match(application, /commitStateChange\(result\.change, sink\)/);
  assert.doesNotMatch(application, /\bfetch\(|from ['"]react|infrastructure|\.prepare\(/);
  const page = source('src/pages/FinancePage.tsx');
  assert.match(page, /finance\.approveExpense\(entry\.id\)/);
  assert.match(page, /finance\.recordPayment\(input\)/);
  assert.doesNotMatch(page, /approvedAt:|acceptedAmount:|paidAmount:/);
});

test('HTTP and Telegram share authoritative financial policy through the public domain module', () => {
  assert.match(source('sites/projects/finance.js'), /from '..\/..\/src\/domain\/finance\/index\.js'/);
  assert.match(source('sites/projects/write.js'), /validateFinanceChanges\(previousSnapshot\?\.state \?\? null, mergedState, identity, now\)/);
  assert.match(source('sites/telegram/project-store.js'), /validateFinanceChanges\(previous, state, \{ role, name: actor \}, now\)/);
});

test('both deployment artifacts include every runtime file in the financial module', () => {
  const prepare = source('scripts/prepare-sites-build.mjs');
  const dockerfile = source('Dockerfile');
  assert.match(dockerfile, /COPY --from=build \/app\/src\/domain\/finance \.\/src\/domain\/finance/);
  for (const file of readdirSync(new URL('../src/domain/finance/', import.meta.url)).filter(file => file.endsWith('.js'))) {
    assert.ok(prepare.includes(`'${file.slice(0, -3)}'`), file);
  }
  assert.match(prepare, /src\/domain\/finance\/\$\{name\}\.js.*dist\/src\/domain\/finance\/\$\{name\}\.js/);
});
