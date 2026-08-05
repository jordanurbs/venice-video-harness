// Tests for the intelligence layer: which reasoning model runs the pipeline,
// how a text-only choice gets paired with a panel reader, and the JSON /
// error-message handling that made swapping in reasoning models safe.
//
// The live-catalog facts these encode (privacy tier, vision support) were
// verified against api.venice.ai on 2026-08-05. If Venice changes a model's
// tier, the tier assertions here are what should fail first.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_INTELLIGENCE_MODEL,
  TEXT_MODELS,
  describeIntelligence,
  getTextModel,
  resolveIntelligence,
  selectableTextModels,
} from '../dist/venice/text-models.js';
import { INTELLIGENCE_CHOICES } from '../dist/mini-drama/choices.js';
import { createSeries } from '../dist/series/manager.js';
import { describeApiError, extractJsonBlock } from '../dist/venice/client.js';
import { renderWorkshopHtml } from '../dist/mini-drama/workshop.js';

// ---- The registry itself ----------------------------------------------------

test('every model Jordan asked for is registered under the right privacy tier', () => {
  const expected = {
    'kimi-k3': 'private',
    'zai-org-glm-5-2': 'private',
    'grok-4-5': 'private',
    'claude-fable-5': 'anonymized',
    'claude-opus-5': 'anonymized',
    'openai-gpt-56-sol': 'anonymized',
    'qwen-3-8-max': 'anonymized',
  };
  for (const [id, privacy] of Object.entries(expected)) {
    const spec = getTextModel(id);
    assert.ok(spec, `${id} should be registered`);
    assert.equal(spec.privacy, privacy, `${id} should be ${privacy}`);
  }
});

test('the wizard offers exactly those seven, private tier first', () => {
  assert.equal(INTELLIGENCE_CHOICES.length, 7);
  const tiers = INTELLIGENCE_CHOICES.map(choice => getTextModel(choice.value).privacy);
  const firstAnonymized = tiers.indexOf('anonymized');
  assert.ok(firstAnonymized > 0, 'private models should come first');
  assert.ok(
    tiers.slice(firstAnonymized).every(tier => tier === 'anonymized'),
    'tiers should not interleave',
  );
});

test('the legacy default is resolvable but not offered', () => {
  assert.ok(getTextModel('llama-3.3-70b'), 'still resolvable for old projects');
  assert.ok(
    !selectableTextModels().some(spec => spec.id === 'llama-3.3-70b'),
    'should not be offered to new projects',
  );
});

// ---- Pairing: the privacy invariant ----------------------------------------

test('a text-only model never borrows vision from a weaker privacy tier', () => {
  for (const spec of TEXT_MODELS) {
    const { visionModel } = resolveIntelligence(spec.id);
    const companion = getTextModel(visionModel);
    assert.ok(companion, `${spec.id} paired with an unregistered ${visionModel}`);
    assert.equal(
      companion.privacy,
      spec.privacy,
      `${spec.id} (${spec.privacy}) must not send panels to a ${companion.privacy} model`,
    );
    assert.equal(companion.vision, true, `${spec.id} paired with a model that cannot see`);
  }
});

test('a model that sees reads its own panels', () => {
  for (const spec of TEXT_MODELS.filter(model => model.vision)) {
    const resolved = resolveIntelligence(spec.id);
    assert.equal(resolved.visionModel, spec.id);
  }
});

test('GLM 5.2 pairs with the cheapest private model that can see', () => {
  assert.deepEqual(resolveIntelligence('zai-org-glm-5-2'), {
    model: 'zai-org-glm-5-2',
    visionModel: 'grok-4-5',
  });
});

test('an unregistered id still writes, but QA falls back to a known reader', () => {
  const resolved = resolveIntelligence('some-model-shipped-next-week');
  assert.equal(resolved.model, 'some-model-shipped-next-week');
  assert.equal(getTextModel(resolved.visionModel).vision, true);
});

test('the default is private and reads panels unaided', () => {
  const spec = getTextModel(DEFAULT_INTELLIGENCE_MODEL);
  assert.equal(spec.privacy, 'private');
  assert.equal(spec.vision, true);
});

// ---- Wiring into a project --------------------------------------------------

test('createSeries records the choice, and defaults without one', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'vv-intel-'));
  const chosen = createSeries('Chosen', 'c', 'drama', 's', {
    workspace,
    intelligenceModel: 'zai-org-glm-5-2',
  });
  assert.deepEqual(chosen.intelligence, {
    model: 'zai-org-glm-5-2',
    visionModel: 'grok-4-5',
  });

  const defaulted = createSeries('Defaulted', 'c', 'drama', 's', { workspace });
  assert.equal(defaulted.intelligence.model, DEFAULT_INTELLIGENCE_MODEL);
});

test('describeIntelligence names the borrowed reader so the pairing is visible', () => {
  assert.match(describeIntelligence('zai-org-glm-5-2'), /QA via Grok 4\.5/);
  assert.match(describeIntelligence('kimi-k3'), /private, reads panels/);
});

test('the treatment page shows which model is behind the project', () => {
  const draft = {
    version: 1, status: 'draft', revision: 1, generatedAt: '', projectName: 'P',
    projectType: 'film',
    inputs: { objective: '', audience: '', targetDuration: '60s', mustInclude: '', avoid: '', references: '', delivery: 'standard', referenceSources: [] },
    logline: 'L', synopsis: 'S', themes: ['t'], structure: [], aesthetic: {
      style: '', palette: '', lighting: '', lensCharacteristics: '', filmStock: '',
    },
    characters: [], locations: [],
    script: { episode: 1, title: 'T', totalDuration: '60s', shots: [] },
    productionNotes: { delivery: 'standard', audioApproach: '', continuityPriorities: [], risks: [], openQuestions: [] },
    feedbackHistory: [],
  };
  const html = renderWorkshopHtml(draft, new Map(), undefined, describeIntelligence('zai-org-glm-5-2'));
  assert.match(html, /GLM 5\.2 \(private, QA via Grok 4\.5\)/);
});

// ---- JSON handling ----------------------------------------------------------

test('extractJsonBlock survives fences and stray narration', () => {
  assert.deepEqual(JSON.parse(extractJsonBlock('{"a":1}')), { a: 1 });
  assert.deepEqual(JSON.parse(extractJsonBlock('```json\n{"a":1}\n```')), { a: 1 });
  assert.deepEqual(JSON.parse(extractJsonBlock('Sure!\n{"a":1}\nHope that helps.')), { a: 1 });
  assert.deepEqual(JSON.parse(extractJsonBlock('```\n[1,2]\n```')), [1, 2]);
});

// ---- Error surfacing --------------------------------------------------------

test('every Venice error shape yields a reason, not a bare status code', () => {
  // Routing error: a string, carrying the "did you mean" list. Reading only
  // error.message threw this away and left users with "HTTP 404".
  assert.match(
    describeApiError({ error: 'Specified model not found: qwen-2.5-vl. Did you mean: a, b?' }, 404),
    /Did you mean: a, b\?/,
  );
  // Validation error: the reason lives under issues[], not error.
  assert.equal(
    describeApiError({ issues: [{ message: 'Image content is not supported by this model.' }] }, 400),
    'Image content is not supported by this model.',
  );
  // Provider error: the original shape.
  assert.equal(describeApiError({ error: { message: 'upstream exploded' } }, 502), 'upstream exploded');
  // Nothing usable: fall back to the status.
  assert.match(describeApiError({}, 500), /HTTP 500/);
});
