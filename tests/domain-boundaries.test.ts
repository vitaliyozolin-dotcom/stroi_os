import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { isTaskClosed, isTaskOverdue, normalizeAppStateWithFallback } from '../src/domain/index.ts';
import type { AppState } from '../src/entities/index.ts';
import { seedState } from '../src/seed.ts';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('task predicates are deterministic for an explicitly supplied date', () => {
  const current = { ...structuredClone(seedState.tasks[0]), status: 'todo' as const, dueDate: '2026-08-19' };

  assert.equal(isTaskClosed(current.status), false);
  assert.equal(isTaskOverdue(current, '2026-08-19'), false);
  assert.equal(isTaskOverdue(current, '2026-08-20'), true);
  assert.equal(isTaskClosed('done'), true);
  assert.equal(isTaskClosed('canceled'), true);
});

test('state normalization uses an explicit fallback without mutating either input', () => {
  const fallback = structuredClone(seedState);
  const input = structuredClone(seedState) as AppState;
  const fallbackBefore = structuredClone(fallback);
  const inputBefore = structuredClone(input);

  const normalized = normalizeAppStateWithFallback(input, fallback);

  assert.notEqual(normalized, input);
  assert.deepEqual(input, inputBefore);
  assert.deepEqual(fallback, fallbackBefore);
});

test('legacy root files are compatibility facades, not parallel implementations', () => {
  assert.match(source('src/domain.ts'), /from '\.\/domain\/index\.ts'/);
  assert.match(source('src/progressEngine.ts'), /from '\.\/domain\/progress\.ts'/);
  assert.match(source('src/conflict.ts'), /from '\.\/domain\/merge\.ts'/);
  assert.doesNotMatch(source('src/domain.ts'), /new Intl\.|Date\.now\(|Math\.random\(/);
});
