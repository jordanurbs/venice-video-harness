// `"5s"` shot-duration strings: the helpers moved from the Node-only planner
// into core so a browser host holding the schema can read them, and the
// planner re-exports `parseShotDuration` so its importers are unchanged.

import test from 'node:test';
import assert from 'node:assert/strict';

import { formatShotDuration, parseShotDuration } from '../packages/core/dist/series/duration.js';
import * as barrel from '../packages/core/dist/index.js';
import { parseShotDuration as fromPlanner } from '../dist/mini-drama/generation-planner.js';

test('parseShotDuration reads whole-second strings and defaults everything else to 5', () => {
  assert.equal(parseShotDuration('5s'), 5);
  assert.equal(parseShotDuration('30s'), 30);
  assert.equal(parseShotDuration('4.5s'), 5);
  assert.equal(parseShotDuration('7'), 5);
  assert.equal(parseShotDuration(''), 5);
});

test('formatShotDuration rounds to a whole second and never goes below 1', () => {
  assert.equal(formatShotDuration(5), '5s');
  assert.equal(formatShotDuration(4.4), '4s');
  assert.equal(formatShotDuration(4.5), '5s');
  assert.equal(formatShotDuration(0), '1s');
  assert.equal(parseShotDuration(formatShotDuration(12)), 12);
});

test('both are on the core barrel, and the planner re-exports the parser', () => {
  assert.equal(barrel.parseShotDuration, parseShotDuration);
  assert.equal(barrel.formatShotDuration, formatShotDuration);
  assert.equal(fromPlanner, parseShotDuration);
});
