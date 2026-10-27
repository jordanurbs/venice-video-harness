import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  generateWorkshop,
  inventoryReferencePath,
  MAX_TEXT_CHARS_PER_FILE,
  parseRuntimeSeconds,
  WORKSHOP_MIN_TOKENS,
  workshopTokenBudget,
} from '../dist/mini-drama/workshop.js';
import { getTextModel } from '../packages/core/dist/venice/text-models.js';
import { createSeries } from '../dist/series/manager.js';

test('runtime is read the way people write it', () => {
  assert.equal(parseRuntimeSeconds('4 minutes 55 seconds'), 295);
  assert.equal(parseRuntimeSeconds('90 seconds'), 90);
  assert.equal(parseRuntimeSeconds('8 minutes'), 480);
  assert.equal(parseRuntimeSeconds('about 5 min'), 300);
  assert.equal(parseRuntimeSeconds('4:55'), 295);
  assert.equal(parseRuntimeSeconds('1:02:00'), 3720);
  assert.equal(parseRuntimeSeconds('2m30s'), 150);
  assert.equal(parseRuntimeSeconds('1.5 minutes'), 90);
  assert.equal(parseRuntimeSeconds('300s'), 300);
  assert.equal(parseRuntimeSeconds('a short film'), null);
  assert.equal(parseRuntimeSeconds(''), null);
  assert.equal(parseRuntimeSeconds(undefined), null);
});

test('the workshop budget scales with the runtime, up to the model ceiling', () => {
  // Short pieces keep the old fixed budget.
  assert.equal(workshopTokenBudget('30 seconds', 'kimi-k3'), WORKSHOP_MIN_TOKENS);
  assert.equal(workshopTokenBudget('', 'kimi-k3'), WORKSHOP_MIN_TOKENS);
  // A five-minute film gets room for its script and the reasoning that writes it.
  const fiveMinutes = workshopTokenBudget('4 minutes 55 seconds', 'kimi-k3');
  assert.ok(fiveMinutes > 100_000, `five minutes: ${fiveMinutes}`);
  assert.ok(fiveMinutes <= getTextModel('kimi-k3').maxOutputTokens);
  // Never past the model's own ceiling.
  assert.equal(workshopTokenBudget('20 minutes', 'kimi-k3'), getTextModel('kimi-k3').maxOutputTokens);
  assert.equal(workshopTokenBudget('20 minutes', 'grok-4-5'), getTextModel('grok-4-5').maxOutputTokens);
  // Never below the old budget, even on a model with a smaller ceiling.
  assert.equal(workshopTokenBudget('20 minutes', 'llama-3.3-70b'), WORKSHOP_MIN_TOKENS);
  // A model the registry has no ceiling for keeps the old budget.
  assert.equal(workshopTokenBudget('20 minutes', 'some-unlisted-model'), WORKSHOP_MIN_TOKENS);
  // An explicit budget wins.
  assert.equal(workshopTokenBudget('20 minutes', 'some-unlisted-model', 50_000), 50_000);
});

test('every selectable text model states its output ceiling', async () => {
  const { selectableTextModels } = await import('../packages/core/dist/venice/text-models.js');
  for (const model of selectableTextModels()) {
    assert.ok(model.maxOutputTokens > 0, `${model.id} has no maxOutputTokens`);
  }
});

test('generateWorkshop asks for the scaled budget, or the one it is given', async () => {
  const series = createSeries('Long Film', 'A long film', 'drama', 'A city', {
    workspace: '/tmp', projectType: 'film', audioStrategy: 'native', videoFamilyPreference: 'seedance',
  });
  const inputs = { objective: '', targetDuration: '4 minutes 55 seconds', audience: '', mustInclude: '', avoid: '', references: '', delivery: 'standard', referenceSources: [] };
  const asked = [];
  const client = {
    async chatJson(options) {
      asked.push(options.maxTokens);
      return {
        logline: 'x', synopsis: 'x', themes: [], structure: [], aesthetic: {}, characters: [], locations: [],
        script: { episode: 1, title: 'x', totalDuration: '295s', shots: [{ shotNumber: 1, type: 'establishing', duration: '5s', description: 'x', characters: [] }] },
        productionNotes: { openQuestions: [] },
      };
    },
  };
  await generateWorkshop(client, series, inputs, 'kimi-k3', null, undefined, { planCheck: false });
  await generateWorkshop(client, series, inputs, 'kimi-k3', null, undefined, { planCheck: false, maxTokens: 40_000 });
  assert.deepEqual(asked, [workshopTokenBudget('4 minutes 55 seconds', 'kimi-k3'), 40_000]);
});

test('a full treatment is read whole, past the old 20k cut', async () => {
  const root = await mkdtemp(join(tmpdir(), 'venice-refs-'));
  const path = join(root, 'TREATMENT.md');
  const body = `# Treatment\n${'A beat in the night. '.repeat(2_200)}\n## Scene 11 · Endcard\nThe wordmark.\n`;
  assert.ok(body.length > 40_000 && body.length < MAX_TEXT_CHARS_PER_FILE);
  await writeFile(path, body);
  const [source] = await inventoryReferencePath(path);
  assert.match(source.content, /Scene 11 · Endcard/);
  assert.equal(source.truncated, undefined);
});
