import assert from 'node:assert/strict';
import test from 'node:test';
import { VIDEO_FAMILY_CHOICES } from '../dist/mini-drama/choices.js';

test('wizard model families follow the intended order', () => {
  assert.deepEqual(
    VIDEO_FAMILY_CHOICES.map(choice => choice.label),
    ['Automatic', 'Seedance 2.0', 'MiniMax H3', 'HappyHorse 1.1', 'Grok Imagine', 'Kling O3'],
  );
  assert.deepEqual(
    VIDEO_FAMILY_CHOICES.map(choice => choice.value),
    ['auto', 'seedance', 'minimax-h3', 'happyhorse', 'grok-imagine', 'kling-o3'],
  );
});
