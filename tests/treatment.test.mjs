// The treatment page is the operator's window into a run: it has to reflect
// what is actually on disk after every step, and it must never be able to fail
// the production command that triggered it.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { hasTreatment, refreshTreatment, shotKey } from '../dist/mini-drama/treatment.js';
import { approveWorkshop, saveWorkshop } from '../dist/mini-drama/workshop.js';
import { createSeries, getEpisodeDir, saveSeries } from '../dist/series/manager.js';
import { collectProjectStatus, qualifyCommand } from '../dist/session/status.js';

function film(workspace) {
  return createSeries('Rocketship', 'A private spacecraft races toward an impossible signal', 'science fiction', 'Earth orbit', {
    workspace, projectType: 'film', audioStrategy: 'native', videoFamilyPreference: 'seedance',
  });
}

function shot(shotNumber, extra = {}) {
  return {
    shotNumber,
    type: 'establishing',
    environment: 'DAY_EXTERIOR',
    location: 'orbital-capsule',
    duration: '15s',
    videoModel: 'atmosphere',
    description: `Shot ${shotNumber}.`,
    characters: [],
    dialogue: null,
    sfx: null,
    cameraMovement: 'static',
    transition: 'CUT',
    ...extra,
  };
}

function draft(series, shots = [shot(1), shot(2)]) {
  return {
    version: 1, status: 'draft', revision: 1, generatedAt: new Date().toISOString(),
    projectName: series.name, projectType: 'film',
    inputs: { objective: 'Make a film', targetDuration: '480s', audience: 'sci-fi fans', mustInclude: '', avoid: '', references: '', delivery: 'standard', referenceSources: [] },
    logline: 'A pilot follows a signal.',
    synopsis: 'A complete story.', themes: ['wonder'],
    structure: [{ name: 'Launch', purpose: 'Commit', beats: ['Ignition'] }],
    aesthetic: { style: 'documentary science fiction', palette: 'cold blue', lighting: 'hard sunlight', lensCharacteristics: 'large format', filmStock: 'fine grain' },
    characters: [{ name: 'MARA', gender: 'female', age: '40s', description: 'pilot', fullDescription: 'A veteran pilot.', wardrobe: 'pressure suit', voiceDescription: 'low alto', locked: false, seed: 1 }],
    locations: [{ name: 'Capsule', slug: 'orbital-capsule', description: 'cockpit', lightingNotes: 'amber', seed: 2 }],
    script: { episode: 1, title: 'Rocketship', seriesName: series.name, totalDuration: '480s', status: 'draft', locations: [], shots },
    productionNotes: { delivery: 'standard', audioApproach: 'native dialogue', continuityPriorities: [], risks: [], openQuestions: [] },
    feedbackHistory: [],
  };
}

/** A real 16:9 PNG, so sharp genuinely encodes a thumbnail. */
async function writePanel(path, colour) {
  await writeFile(path, await sharp({
    create: { width: 320, height: 180, channels: 3, background: colour },
  }).png().toBuffer());
}

async function project(shots) {
  const workspace = await mkdtemp(join(tmpdir(), 'venice-treatment-'));
  const series = film(workspace);
  await saveSeries(series);
  const workshop = draft(series, shots);
  await saveWorkshop(series, workshop);
  await approveWorkshop(series, workshop);
  const sceneDir = join(getEpisodeDir(series, 1), 'scene-001');
  await mkdir(sceneDir, { recursive: true });
  return { series, sceneDir, episodeDir: getEpisodeDir(series, 1) };
}

test('shot keys carry the inserted-shot suffix', () => {
  assert.equal(shotKey({ shotNumber: 3 }), '003');
  assert.equal(shotKey({ shotNumber: 3, shotIdSuffix: 'b' }), '003b');
});

test('a suggested command is qualified with the project so it can be pasted anywhere', () => {
  assert.equal(
    qualifyCommand('qa-storyboard -e 1', '/films/rocketship'),
    'qa-storyboard -p "/films/rocketship" -e 1',
  );
  // Already qualified commands are left alone.
  assert.equal(qualifyCommand('qa-approve -p /x -e 1', '/films/x'), 'qa-approve -p /x -e 1');
  // A trailing hint survives, and stays trailing.
  assert.match(
    qualifyCommand('explore-aesthetic   # then: set-aesthetic', '/films/x'),
    /^explore-aesthetic -p "\/films\/x"\s+# then: set-aesthetic$/,
  );
  // A bare command still gets the project.
  assert.equal(qualifyCommand('new-episode', '/films/x'), 'new-episode -p "/films/x"');
});

test('the page reports the live stage and the exact next command', async () => {
  const { series } = await project();
  await refreshTreatment(series);
  const html = await readFile(join(series.outputDir, 'WORKSHOP.html'), 'utf-8');

  assert.match(html, /Production progress/);
  assert.match(html, /ready to storyboard/);
  // Copy-pasteable: carries -p and -e, not a bare verb or a slash command.
  assert.match(html, /storyboard-episode -p &quot;.+&quot; -e 1/);
  assert.doesNotMatch(html, /\/qa-storyboard/);
});

test('panels, clips, dialogue and QA verdicts appear as they land on disk', async () => {
  const { series, sceneDir, episodeDir } = await project();

  await refreshTreatment(series);
  let html = await readFile(join(series.outputDir, 'WORKSHOP.html'), 'utf-8');
  assert.match(html, /Not generated yet/, 'an unstarted shot reads as pending');
  assert.doesNotMatch(html, /data:image\/webp/, 'nothing to preview yet');

  await writePanel(join(sceneDir, 'shot-001.png'), '#204060');
  await writePanel(join(sceneDir, 'shot-002.png'), '#602040');
  await refreshTreatment(series);
  html = await readFile(join(series.outputDir, 'WORKSHOP.html'), 'utf-8');
  assert.match(html, /data:image\/webp;base64,/, 'panels are embedded, not linked');
  assert.match(html, /panels complete/);
  assert.match(html, /qa-storyboard -p/);

  await writeFile(join(episodeDir, 'qa-report.json'), JSON.stringify({
    episode: 1,
    results: [
      { shotNumber: 1, verdict: 'PASS', issues: [] },
      { shotNumber: 2, verdict: 'FLAG-CRITICAL', issues: ['Wrong hair colour'] },
    ],
  }));
  await refreshTreatment(series);
  html = await readFile(join(series.outputDir, 'WORKSHOP.html'), 'utf-8');
  assert.match(html, /qa-pass/);
  assert.match(html, /qa-critical/);
  assert.match(html, /Wrong hair colour/, 'the issue rides along as a tooltip');

  const markdown = await readFile(join(series.outputDir, 'WORKSHOP.md'), 'utf-8');
  assert.match(markdown, /## Production progress/);
  assert.match(markdown, /- Panels: 2 \/ 2/);
});

test('shots added after approval show up, since the live script wins', async () => {
  const { series, episodeDir } = await project();
  const scriptPath = join(episodeDir, 'script.json');
  const script = JSON.parse(await readFile(scriptPath, 'utf-8'));
  script.shots.push(shot(2, { shotIdSuffix: 'b', description: 'A spliced insert.' }));
  await writeFile(scriptPath, JSON.stringify(script));

  await refreshTreatment(series);
  const html = await readFile(join(series.outputDir, 'WORKSHOP.html'), 'utf-8');
  assert.match(html, /A spliced insert/);
  // The draft on disk is the workshop's to revise; a refresh must not edit it.
  const workshop = JSON.parse(await readFile(join(series.outputDir, 'workshop.json'), 'utf-8'));
  assert.equal(workshop.script.shots.length, 2);
  assert.equal(workshop.revision, 1);
});

test('a project with no workshop has no treatment page and refreshing is a no-op', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'venice-treatment-bare-'));
  const series = film(workspace);
  await saveSeries(series);
  assert.equal(hasTreatment(series), false);
  assert.equal(await refreshTreatment(series), undefined);
  assert.equal(existsSync(join(series.outputDir, 'WORKSHOP.html')), false);
});

test('a broken artifact cannot fail the command that triggered the refresh', async () => {
  const { series, sceneDir, episodeDir } = await project();
  // A PNG that sharp cannot decode, and a QA report that is not valid JSON.
  await writeFile(join(sceneDir, 'shot-001.png'), Buffer.from('not really a png'));
  await writeFile(join(episodeDir, 'qa-report.json'), '{ truncated');

  const path = await refreshTreatment(series);
  assert.ok(path, 'the page is still written');
  const html = await readFile(path, 'utf-8');
  assert.match(html, /Production progress/);
  assert.match(html, /Shot script/);
});

test('re-encoding is skipped when a panel has not changed', async () => {
  const { series, sceneDir } = await project([shot(1)]);
  await writePanel(join(sceneDir, 'shot-001.png'), '#204060');

  await refreshTreatment(series);
  const cachePath = join(series.outputDir, '.treatment-thumbs.json');
  const first = JSON.parse(await readFile(cachePath, 'utf-8'));
  const key = Object.keys(first)[0];
  assert.ok(key.endsWith('shot-001.png'));

  const started = Date.now();
  await refreshTreatment(series);
  const cached = JSON.parse(await readFile(cachePath, 'utf-8'));
  assert.equal(cached[key].dataUri, first[key].dataUri);
  assert.ok(Date.now() - started < 2_000);

  // A regenerated panel invalidates its entry.
  await writePanel(join(sceneDir, 'shot-001.png'), '#f0c040');
  await refreshTreatment(series);
  const refreshed = JSON.parse(await readFile(cachePath, 'utf-8'));
  assert.notEqual(refreshed[key].dataUri, first[key].dataUri);
});

test('a workshop-approved script counts as approved without the artifact file', async () => {
  // `approve-script` writes script-approved.json; `workshop --approve` only
  // sets the script's own status. Both have to satisfy the storyboard gate,
  // or the status line loops asking for an approval that already happened.
  const { series, episodeDir } = await project();
  assert.equal(existsSync(join(episodeDir, 'script-approved.json')), false);

  const status = await collectProjectStatus(series.outputDir);
  assert.equal(status.episodes[0].scriptApproved, true);
  assert.match(status.episodes[0].nextCommand, /^storyboard-episode/);
});
