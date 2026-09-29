import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDate } from '../src/presentation/formatting.ts';

test('a document without a date does not crash the project card', () => {
  assert.equal(formatDate('', true), 'Дата не указана');
  assert.equal(formatDate('invalid', true), 'Дата не указана');
});

test('document calendar dates do not move to the preceding day in western time zones', () => {
  const previous = process.env.TZ;
  try {
    for (const zone of ['America/Los_Angeles', 'Europe/Moscow', 'Pacific/Auckland']) {
      process.env.TZ = zone;
      assert.match(formatDate('2026-09-07', true), /^7 сент\. 2026/);
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
