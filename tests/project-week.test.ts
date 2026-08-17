import assert from 'node:assert/strict';
import test from 'node:test';
import { mondayOf, projectWeekNumber, projectWeekRange, stageWeekRange } from '../src/projectWeek.ts';

test('project weeks always start on Monday', () => {
  assert.equal(mondayOf('2026-08-17'), '2026-08-17');
  assert.equal(mondayOf('2026-08-23'), '2026-08-17');
  assert.equal(mondayOf('2026-08-24'), '2026-08-24');
});

test('project week numbering is relative to the project start week', () => {
  assert.equal(projectWeekNumber('2026-08-05', '2026-08-05'), 1);
  assert.equal(projectWeekNumber('2026-08-05', '2026-08-09'), 1);
  assert.equal(projectWeekNumber('2026-08-05', '2026-08-10'), 2);
  assert.equal(projectWeekNumber('2026-08-05', '2026-08-17'), 3);
});

test('current project week exposes the Monday to Sunday range', () => {
  assert.deepEqual(projectWeekRange('2026-08-05', '2026-08-17'), {
    number: 3,
    start: '2026-08-17',
    end: '2026-08-23',
  });
});

test('stage week range can span several project weeks', () => {
  assert.deepEqual(stageWeekRange('2026-08-05', '2026-08-17', '2026-08-28'), { start: 3, end: 4 });
});
