// Node-test runner. Exercises the structured deprecation-warning surfacing
// added in src/venice/client.ts so the harness no longer silently ignores
// Venice's `x-venice-model-deprecation-*` headers.
//
// Run with: node --test tests/test-deprecation-header.mjs
//          (or:  npm exec node --test tests/test-deprecation-header.mjs)
//
// The harness ships TypeScript only — tests/ historically use .mjs that
// imports the compiled JS from dist/. Run `npm run build` first.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  reportVeniceDeprecation,
  _resetDeprecationDedupeForTests,
} from '../dist/venice/client.js';

function captureWarn(fn) {
  const original = console.warn;
  const lines = [];
  console.warn = (...args) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return lines;
}

test('reportVeniceDeprecation returns null and emits no log when header is absent', () => {
  _resetDeprecationDedupeForTests();
  const headers = new Headers({ 'x-venice-balance-usd': '10.00' });
  let result;
  const lines = captureWarn(() => {
    result = reportVeniceDeprecation(headers, '/api/v1/chat/completions');
  });
  assert.equal(result, null);
  assert.deepEqual(lines, []);
});

test('reportVeniceDeprecation parses the structured notice and warns once', () => {
  _resetDeprecationDedupeForTests();
  const headers = new Headers({
    'x-venice-model-id': 'qwen-2.5-vl',
    'x-venice-model-name': 'Qwen 2.5 VL',
    'x-venice-model-deprecation-warning': 'Model retires; migrate to mistral-31-24b.',
    'x-venice-model-deprecation-date': '2025-09-22T00:00:00.000Z',
  });

  let result;
  const lines = captureWarn(() => {
    result = reportVeniceDeprecation(headers, '/api/v1/chat/completions');
  });

  assert.deepEqual(result, {
    modelId: 'qwen-2.5-vl',
    modelName: 'Qwen 2.5 VL',
    warning: 'Model retires; migrate to mistral-31-24b.',
    date: '2025-09-22T00:00:00.000Z',
  });
  assert.ok(lines.some((l) => /MODEL DEPRECATION/.test(l)), 'first line includes the structured tag');
  assert.ok(lines.some((l) => /qwen-2\.5-vl/.test(l)));
  assert.ok(lines.some((l) => /2025-09-22/.test(l)));
  assert.ok(lines.some((l) => /migrate/i.test(l)));
});

test('reportVeniceDeprecation dedupes by (model, date) within the process', () => {
  _resetDeprecationDedupeForTests();
  const headers = new Headers({
    'x-venice-model-id': 'qwen-2.5-vl',
    'x-venice-model-deprecation-warning': 'Model retires.',
    'x-venice-model-deprecation-date': '2025-09-22T00:00:00.000Z',
  });

  const firstCall = captureWarn(() => {
    reportVeniceDeprecation(headers, '/api/v1/chat/completions');
  });
  const secondCall = captureWarn(() => {
    reportVeniceDeprecation(headers, '/api/v1/chat/completions');
  });
  const thirdCall = captureWarn(() => {
    reportVeniceDeprecation(headers, '/api/v1/image/generate');
  });

  assert.ok(firstCall.length > 0, 'first occurrence warns');
  assert.equal(secondCall.length, 0, 'identical second occurrence is silent');
  assert.equal(thirdCall.length, 0, 'same (model, date) on a different path is still silent — the deprecation is the same');
});

test('reportVeniceDeprecation warns again when the deprecation date changes', () => {
  _resetDeprecationDedupeForTests();
  const headersA = new Headers({
    'x-venice-model-id': 'qwen-2.5-vl',
    'x-venice-model-deprecation-warning': 'Model retires.',
    'x-venice-model-deprecation-date': '2025-09-22T00:00:00.000Z',
  });
  const headersB = new Headers({
    'x-venice-model-id': 'qwen-2.5-vl',
    'x-venice-model-deprecation-warning': 'Sunset rescheduled.',
    'x-venice-model-deprecation-date': '2025-10-15T00:00:00.000Z',
  });

  const firstWarn = captureWarn(() => reportVeniceDeprecation(headersA, '/api/v1/chat/completions'));
  const secondWarn = captureWarn(() => reportVeniceDeprecation(headersB, '/api/v1/chat/completions'));

  assert.ok(firstWarn.length > 0);
  assert.ok(secondWarn.length > 0, 'rescheduled sunset re-warns');
});

test('reportVeniceDeprecation handles missing model id / name / date gracefully', () => {
  _resetDeprecationDedupeForTests();
  const headers = new Headers({
    'x-venice-model-deprecation-warning': 'Generic notice.',
  });

  let result;
  const lines = captureWarn(() => {
    result = reportVeniceDeprecation(headers, '/api/v1/chat/completions');
  });

  assert.equal(result?.warning, 'Generic notice.');
  assert.equal(result?.modelId, null);
  assert.equal(result?.modelName, null);
  assert.equal(result?.date, null);
  assert.ok(lines.length > 0);
  assert.ok(lines.some((l) => /unknown id|Generic notice/.test(l)));
});
