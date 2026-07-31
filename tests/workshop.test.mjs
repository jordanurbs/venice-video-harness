import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  approveWorkshop,
  buildWorkshopSystemPrompt,
  buildWorkshopUserPrompt,
  loadWorkshop,
  renderWorkshopMarkdown,
  saveWorkshop,
} from '../dist/mini-drama/workshop.js';
import { createSeries, loadSeries, saveSeries } from '../dist/series/manager.js';

function film(workspace) {
  return createSeries('Rocketship', 'A private spacecraft races toward an impossible signal', 'science fiction', 'Earth orbit and deep space', {
    workspace, projectType: 'film', audioStrategy: 'native', videoFamilyPreference: 'seedance',
  });
}

function draft(series) {
  return {
    version: 1, status: 'draft', revision: 1, generatedAt: new Date().toISOString(),
    projectName: series.name, projectType: 'film',
    inputs: { objective: 'Make a complete film', targetDuration: '8 minutes', audience: 'science-fiction fans', mustInclude: 'rocket launch', avoid: 'cliffhanger', references: 'Apollo photography', delivery: '4k' },
    logline: 'A pilot follows a signal beyond the edge of mapped space.',
    synopsis: 'A complete story with a final resolution.', themes: ['wonder', 'choice'],
    structure: [{ name: 'Launch', purpose: 'Commit to the journey', beats: ['Ignition', 'Signal'] }],
    aesthetic: { style: 'documentary science fiction', palette: 'cold blue and warm cabin amber', lighting: 'hard sunlight', lensCharacteristics: 'large-format documentary lenses', filmStock: 'fine digital grain' },
    characters: [{ name: 'MARA', gender: 'female', age: '40s', description: 'disciplined pilot', fullDescription: 'A disciplined veteran pilot carrying quiet grief.', wardrobe: 'white pressure suit', voiceDescription: 'measured low alto', locked: false, seed: 123 }],
    locations: [{ name: 'Orbital Capsule', slug: 'orbital-capsule', description: 'compact worn spacecraft cockpit', lightingNotes: 'amber practicals against hard sunlight', seed: 456 }],
    script: { episode: 1, title: 'Rocketship', seriesName: series.name, totalDuration: '480s', status: 'draft', locations: [], shots: [{ shotNumber: 1, type: 'establishing', environment: 'DAY_EXTERIOR', location: 'orbital-capsule', duration: '15s', videoModel: 'atmosphere', description: 'The rocket clears the tower. No background music, no sound effects, no soundtrack, dry recording.', characters: [], dialogue: null, sfx: null, cameraMovement: 'long-lens tracking', transition: 'CUT' }] },
    productionNotes: { delivery: '4k', audioApproach: 'native dialogue with voice donor', continuityPriorities: ['capsule geography'], risks: ['launch scale'], openQuestions: ['How old is the signal?'] },
    feedbackHistory: [],
  };
}

test('workshop prompt develops the complete project, not only shots', () => {
  const series = film('/tmp');
  const system = buildWorkshopSystemPrompt(series);
  assert.match(system, /complete creative-development team/);
  assert.match(system, /premise, audience, target duration, logline, synopsis, themes, structure/);
  assert.match(system, /visual language, cast, locations/);
  assert.match(system, /Never call it an episode or series/);

  const user = buildWorkshopUserPrompt(series, draft(series).inputs);
  assert.match(user, /existingAesthetic/);
  assert.match(user, /existingCharacters/);
  assert.match(user, /productionNotes/);
  assert.match(user, /intendedAudienceResponse/);
});

test('workshop draft saves a readable review and approval materializes production state', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'venice-workshop-'));
  const series = film(workspace);
  await saveSeries(series);
  const workshop = draft(series);
  await saveWorkshop(series, workshop);
  assert.deepEqual((await loadWorkshop(series)).logline, workshop.logline);
  const markdown = await readFile(join(series.outputDir, 'WORKSHOP.md'), 'utf-8');
  assert.match(markdown, /## Logline/);
  assert.match(markdown, /## Aesthetic/);
  assert.match(markdown, /Delivery: 4K master/);
  assert.match(markdown, /## Characters/);
  assert.match(renderWorkshopMarkdown(workshop), /## Open questions/);

  await approveWorkshop(series, workshop);
  const saved = await loadSeries(series.outputDir);
  assert.equal(saved.aesthetic.style, 'documentary science fiction');
  assert.equal(saved.characters[0].name, 'MARA');
  assert.equal(saved.locations[0].slug, 'orbital-capsule');
  assert.equal(saved.episodes[0].title, 'Rocketship');
  const script = JSON.parse(await readFile(join(series.outputDir, 'episodes', 'episode-001', 'script.json'), 'utf-8'));
  assert.equal(script.status, 'approved');
  assert.equal(script.totalDuration, '480s');
});
