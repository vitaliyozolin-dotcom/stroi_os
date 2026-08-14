import assert from 'node:assert/strict';
import test from 'node:test';

import { createBackgroundTaskTracker, createExclusiveTaskRunner } from '../server/background-tasks.js';

test('background tracker drains work before shutdown', async () => {
  const tracker = createBackgroundTaskTracker({ onError: () => {} });
  let finish;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });

  tracker.waitUntil(pending);
  assert.equal(tracker.size, 1);
  const draining = tracker.drain(500);
  finish?.();
  assert.equal(await draining, true);
  assert.equal(tracker.size, 0);
});

test('background tracker also drains tasks registered by a tracked parent', async () => {
  const tracker = createBackgroundTaskTracker({ onError: () => {} });
  let releaseParent;
  let releaseChild;
  const child = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  const parent = new Promise<void>((resolve) => {
    releaseParent = () => {
      tracker.waitUntil(child);
      resolve();
    };
  });

  tracker.waitUntil(parent);
  let drainResult: boolean | undefined;
  const draining = tracker.drain(500).then((result) => {
    drainResult = result;
    return result;
  });
  releaseParent?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(drainResult, undefined);
  assert.ok(tracker.size >= 1);
  releaseChild?.();
  assert.equal(await draining, true);
  assert.equal(tracker.size, 0);
});

test('exclusive runner does not accumulate timer ticks', async () => {
  const tracker = createBackgroundTaskTracker({ onError: () => {} });
  let runs = 0;
  let finish;
  const runner = createExclusiveTaskRunner(async () => {
    runs += 1;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  }, tracker.waitUntil);

  const first = runner();
  const second = runner();
  const third = runner();
  assert.equal(first, second);
  assert.equal(first, third);
  assert.equal(runs, 0);

  await Promise.resolve();
  assert.equal(runs, 1);
  finish?.();
  await first;
  await Promise.resolve();
  assert.equal(tracker.size, 0);
});
