// stage-ref (rule 65): an edited plate or first frame, made on two edit
// models, picked by a person, and used by the shot it was picked for (a plate
// in place of its view in the R2V stack, or the start frame of an i2v
// re-take). No network: the edit client is a stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const { imageToVideoTwin, stagedFrameLane, getVideoModel, VIDEO_MODELS } = await import('../packages/core/dist/venice/models.js');
const { buildReferenceSlotPlan } = await import('../dist/mini-drama/reference-slots.js');
const { resolveVideoModel, buildVideoPrompt } = await import('../dist/mini-drama/prompt-builder.js');
const { buildGenerationPlan } = await import('../dist/mini-drama/generation-planner.js');
const { stagedClipIsStale, stagedPlate, stagedStartFrame, staleStagedShots } = await import('../dist/mini-drama/staging.js');
const stageRef = await import('../dist/mini-drama/stage-ref.js');

const ffmpegAvailable = spawnSync('ffmpeg', ['-version']).status === 0;
const cli = join(new URL('..', import.meta.url).pathname, 'dist', 'mini-drama', 'cli.js');

const AESTHETIC = { style: 'cinematic film still', palette: 'cobalt', lighting: 'haze', lensCharacteristics: '35mm', filmStock: 'digital' };

async function png(width, height, color = '#335577') {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

/** An edit model's answer: noise, so it clears the silent-reject size floor (30 KB). */
async function edited(width, height) {
  return sharp({ create: { width, height, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).png().toBuffer();
}

async function project(videoDefaults = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stage-ref-'));
  mkdirSync(join(dir, 'characters', 'anna'), { recursive: true });
  writeFileSync(join(dir, 'characters', 'anna', 'front.png'), await png(64, 64));
  const plates = join(dir, 'locations', 'harbour-steps');
  mkdirSync(plates, { recursive: true });
  for (const view of ['north', 'east', 'south', 'west']) writeFileSync(join(plates, `${view}.png`), await png(320, 180));
  writeFileSync(join(plates, 'north.provenance.json'), JSON.stringify({ generationModel: 'gpt-image-2', editModels: [], hasFace: false }));
  const series = {
    name: 't', slug: 't', concept: '', genre: '', setting: '', aesthetic: AESTHETIC,
    characters: [{ name: 'ANNA', gender: 'female', age: '30s', description: 'd', fullDescription: 'fd', wardrobe: 'grey coat', voiceDescription: '', locked: true, seed: 1 }],
    locations: [{ name: 'Harbour Steps', slug: 'harbour-steps', description: 'Stone water steps under an arcade.', seed: 1 }],
    episodes: [{ number: 1, title: 'one' }],
    videoDefaults: {
      actionModel: 'seedance-2-5-reference-to-video', atmosphereModel: 'seedance-2-5-reference-to-video',
      characterConsistencyModel: 'seedance-2-5-reference-to-video', montageMode: true, ...videoDefaults,
    },
    outputDir: dir, createdAt: '', updatedAt: '',
  };
  const shot = (n, extra = {}) => ({
    shotNumber: n, type: 'action', duration: '5s', videoModel: 'action',
    description: 'ANNA stands on the ferry deck at the water steps.', characters: ['ANNA'], location: 'harbour-steps', plateView: 'north',
    dialogue: null, sfx: null, cameraMovement: 'static', transition: 'CUT', ...extra,
  });
  const script = { episode: 1, title: 'one', seriesName: 't', totalDuration: '15s', status: 'approved', locations: [], shots: [shot(7), shot(8), shot(9)] };
  return { dir, series, script, shot, plates };
}

const startFrameRef = (path = 'x.png') => ({ path, use: 'start-frame', source: 'y.png', model: 'gpt-image-2-edit', prompt: 'p', sha256: 'x', session: 's', pickedAt: '' });

test('imageToVideoTwin finds the family\'s i2v lane', () => {
  assert.equal(imageToVideoTwin('seedance-2-5-reference-to-video'), 'seedance-2-5-image-to-video');
  assert.equal(imageToVideoTwin('seedance-2-0-enhanced-reference-to-video'), 'seedance-2-0-image-to-video');
  assert.equal(imageToVideoTwin('minimax-h3-max-reference-to-video'), 'minimax-h3-max-image-to-video');
  assert.equal(imageToVideoTwin('wan-3-0-enhanced-reference-to-video'), 'wan-3-0-image-to-video');
  assert.equal(imageToVideoTwin('seedance-2-5-image-to-video'), 'seedance-2-5-image-to-video');
  assert.equal(imageToVideoTwin('seedance-2-5-text-to-video'), 'seedance-2-5-image-to-video');
  assert.equal(imageToVideoTwin('no-such-reference-to-video'), undefined);
  // Private lanes stay private (rule 46).
  assert.equal(imageToVideoTwin('minimax-h3-max-text-to-video'), 'minimax-h3-max-image-to-video');
  assert.equal(imageToVideoTwin('grok-imagine-text-to-video-private'), 'grok-imagine-image-to-video-private');
  assert.equal(imageToVideoTwin('seedance-2-5-us-text-to-video-private'), 'seedance-2-5-us-image-to-video-private');
  assert.equal(imageToVideoTwin('seedance-2-5-us-reference-to-video-private'), 'seedance-2-5-us-image-to-video-private');
  assert.equal(imageToVideoTwin('kling-v3-4k-reference-to-video'), undefined, 'no i2v lane in its family');
  assert.equal(imageToVideoTwin('wan-2.2-a14b-text-to-video'), undefined, 'no private i2v lane in its family');
});

test('every lane in the registry maps to an image-to-video lane of its own privacy tier, or to none', () => {
  const lanes = VIDEO_MODELS.map(spec => spec.id);
  const isI2v = id => getVideoModel(id)?.type === 'image-to-video' && !id.includes('reference-to-video');
  for (const lane of lanes) {
    const tier = getVideoModel(lane).privacy;
    const twin = imageToVideoTwin(lane);
    if (twin) {
      assert.equal(getVideoModel(twin).privacy, tier, `${lane} -> ${twin}`);
      assert.ok(isI2v(twin), `${lane} -> ${twin} is not an image-to-video lane`);
    }
    // With every other lane offered as the project's own fallback.
    for (const fallback of lanes) {
      const picked = stagedFrameLane(lane, [fallback]);
      if (picked) assert.equal(getVideoModel(picked).privacy, tier, `${lane} (fallback ${fallback}) -> ${picked}`);
    }
  }
  assert.equal(stagedFrameLane('no-such-model'), undefined, 'an unknown lane has no known tier');
});

test('a staged start frame keeps its lane\'s privacy tier, or the shot is refused', async () => {
  const lanes = VIDEO_MODELS.filter(spec => !spec.offline).map(spec => spec.id);
  const { series, shot } = await project();
  for (const lane of lanes) {
    series.videoDefaults = { actionModel: lane, atmosphereModel: lane, characterConsistencyModel: lane };
    for (const characters of [['ANNA'], []]) {
      const unstaged = shot(8, { characters });
      const staged = shot(8, { characters, stagingRef: startFrameRef() });
      const laneTier = getVideoModel(resolveVideoModel(unstaged, series).modelId)?.privacy;
      const resolution = resolveVideoModel(staged, series);
      if (resolution.refused) continue;
      assert.equal(getVideoModel(resolution.modelId)?.privacy, laneTier, `${lane}: ${resolution.modelId}`);
    }
  }
  // A private lane with no private image-to-video lane is refused, not moved to the project's anonymized one.
  const mixed = await project({ actionModel: 'wan-2.2-a14b-text-to-video', characterConsistencyModel: 'wan-2.2-a14b-text-to-video', atmosphereModel: 'seedance-2-5-reference-to-video' });
  const refused = resolveVideoModel(mixed.shot(8, { stagingRef: startFrameRef() }), mixed.series);
  assert.match(refused.refused, /no image-to-video lane in the private tier/);
  assert.throws(() => buildVideoPrompt(mixed.shot(8, { stagingRef: startFrameRef() }), mixed.series), /cannot render from its staging ref: no image-to-video lane in the private tier/);
  const notes = await stageRef.stagingLaneNotes(mixed.series, mixed.shot(8, { stagingRef: startFrameRef() }), 1);
  assert.match(notes[0], /generate-videos will refuse this shot: no image-to-video lane in the private tier/);
});

test('a staged start frame on an exact lip-sync shot is refused unless its image-to-video lane takes the dialogue audio', async () => {
  const dialogue = { character: 'ANNA', line: 'Here it is.' };
  const seedance = await project({ audioStrategy: 'lip-sync', lipSyncModel: 'seedance-2-5-reference-to-video' });
  const refused = resolveVideoModel(seedance.shot(8, { dialogue, stagingRef: startFrameRef() }), seedance.series);
  assert.match(refused.refused, /exact lip-sync, and seedance-2-5-image-to-video .* takes no dialogue audio/);
  const wan = await project({ audioStrategy: 'lip-sync', lipSyncModel: 'wan-2-7-image-to-video' });
  const kept = resolveVideoModel(wan.shot(8, { dialogue, stagingRef: startFrameRef() }), wan.series);
  assert.equal(kept.refused, undefined);
  assert.equal(kept.modelId, 'wan-2-7-image-to-video');
});

test('a staged plate leads the location slots and its source view is not sent', async () => {
  const { dir, series, shot } = await project();
  const staged = join(dir, 'episodes', 'episode-001', 'staging', 'shot-008', 's1');
  mkdirSync(staged, { recursive: true });
  writeFileSync(join(staged, '2-nano-banana-2-edit.png'), await png(320, 180, '#224466'));
  const s8 = shot(8, { stagingRef: { path: 'episodes/episode-001/staging/shot-008/s1/2-nano-banana-2-edit.png', use: 'plate', source: 'locations/harbour-steps/north.png', replacesView: 'north', model: 'nano-banana-2-edit', prompt: 'p', sha256: 'x', session: 's', pickedAt: '' } });

  const before = buildReferenceSlotPlan(series, shot(8), 'seedance-2-5-reference-to-video').slots.filter(s => s.kind === 'location');
  assert.ok(before[0].path.endsWith('north.png'));

  const slots = buildReferenceSlotPlan(series, s8, 'seedance-2-5-reference-to-video').slots.filter(s => s.kind === 'location');
  assert.ok(slots[0].path.endsWith('2-nano-banana-2-edit.png'));
  assert.match(slots[0].roleClause, /edited for this shot/);
  assert.match(slots[0].roleClause, /this image is right/);
  assert.equal(slots.some(s => s.path.endsWith('north.png')), false, 'the replaced view is not sent');
  assert.equal(slots.length, 4);
  assert.match(slots[1].roleClause, /same place/);
  assert.ok(stagedPlate(series, s8));
});

test('a staged start frame renders i2v from the frame, without the location words', async () => {
  const { series, shot } = await project();
  const s8 = shot(8, { stagingRef: startFrameRef() });
  const resolution = resolveVideoModel(s8, series);
  assert.equal(resolution.modelId, 'seedance-2-5-image-to-video');
  assert.equal(resolution.useImageTags, false);
  assert.match(resolution.reason, /staged start frame/);
  const prompt = buildVideoPrompt(s8, series);
  assert.equal(prompt.model, 'seedance-2-5-image-to-video');
  assert.equal(prompt.referenceSlots, undefined);
  assert.match(prompt.prompt, /starts exactly on the first frame/);
  assert.doesNotMatch(prompt.prompt, /Location:/);
  // The unstaged shot keeps R2V and its location words.
  const normal = buildVideoPrompt(shot(8), series);
  assert.equal(normal.model, 'seedance-2-5-reference-to-video');
  assert.match(normal.prompt, /Location:/);
  assert.equal(stagedStartFrame(series, s8), null, 'missing file');
});

test('a staged shot renders on its own; its neighbours keep their run', async () => {
  const { script, series } = await project();
  script.shots[1].stagingRef = startFrameRef();
  script.shots[1].mustStaySingle = true;
  const plan = buildGenerationPlan(script, series);
  const unit8 = plan.units.find(u => u.shotNumbers.includes(8));
  assert.deepEqual(unit8.shotNumbers, [8]);
  assert.equal(unit8.unitType, 'single');
  assert.ok(unit8.decisionReasons.some(r => /staged start frame/.test(r)));
  assert.equal(unit8.startFrameStrategy, 'panel');
  assert.equal(unit8.endFrameStrategy, 'natural');
});

test('a staged shot stays a single even when its mustStaySingle is edited away', async () => {
  for (const montageMode of [true, false]) {
    const { script, series } = await project({ montageMode });
    script.shots[1].stagingRef = startFrameRef();
    const plan = buildGenerationPlan(script, series);
    assert.deepEqual(plan.units.find(u => u.shotNumbers.includes(8)).shotNumbers, [8], `montageMode ${montageMode}`);
  }
});

test('a clip is stale until it was rendered from the pick', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stage-clip-'));
  const clip = join(dir, 'shot-008.mp4');
  writeFileSync(clip, 'x');
  const shot = { stagingRef: { sha256: 'abc' } };
  assert.equal(stagedClipIsStale(clip, {}), false);
  assert.equal(stagedClipIsStale(clip, shot), true);
  writeFileSync(join(dir, 'shot-008.video.json'), JSON.stringify({ metadata: { stagingRef: { sha256: 'old' } } }));
  assert.equal(stagedClipIsStale(clip, shot), true);
  writeFileSync(join(dir, 'shot-008.video.json'), JSON.stringify({ metadata: { stagingRef: { sha256: 'abc' } } }));
  assert.equal(stagedClipIsStale(clip, shot), false);
});

test('runStageRef edits on every model at once, keeps the source aspect, writes sidecars and a pick page', async () => {
  const { dir, series, script } = await project();
  const calls = [];
  const square = await edited(512, 512);
  const client = {
    async postBinary(path, body) {
      calls.push({ path, model: body.modelId, images: body.images.length });
      if (body.modelId === 'nano-banana-2-edit') throw new Error('refused: content policy');
      return square;
    },
  };
  const ferry = join(dir, 'ferry.png');
  writeFileSync(ferry, await png(200, 100, '#112233'));
  const { session, sessionDir, pickPage } = await stageRef.runStageRef(client, series, script, {
    episode: 1, shot: '8', fromPlate: 'north', refs: [ferry], prompt: 'Replace the launches with the ferry from image 2. Keep everything else.',
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.path === '/api/v1/image/multi-edit' && call.images === 2));
  assert.equal(session.use, 'plate');
  assert.equal(session.replacesView, 'north');
  assert.equal(session.source, join('locations', 'harbour-steps', 'north.png'));
  const [gpt, nb] = session.candidates;
  assert.equal(gpt.model, 'gpt-image-2-edit');
  assert.ok(gpt.path && existsSync(join(dir, gpt.path)));
  assert.equal(Math.round((gpt.width / gpt.height) * 100), Math.round((320 / 180) * 100), 'cropped back to 16:9');
  assert.match(nb.error, /refused/);
  const provenance = JSON.parse(readFileSync(join(dir, gpt.path.replace(/\.png$/, '.provenance.json')), 'utf-8'));
  assert.equal(provenance.generationModel, 'gpt-image-2', 'continues the plate lineage');
  assert.deepEqual(provenance.editModels, ['gpt-image-2-edit']);
  // The plate shows no face, but the --ref has no record: the result may show one.
  assert.equal('hasFace' in provenance, false);
  assert.equal(session.hasFace, undefined);
  const recipe = JSON.parse(readFileSync(join(dir, gpt.path.replace(/\.png$/, '.recipe.json')), 'utf-8'));
  assert.equal(recipe.passes[0].kind, 'multi-edit');
  assert.ok(recipe.passes[0].referenceImagePaths[0].endsWith('north.png'));
  assert.ok(existsSync(join(sessionDir, 'session.json')));
  const html = readFileSync(pickPage, 'utf-8');
  assert.match(html, /--pick 1/);
  assert.match(html, /plates are not changed/);
});

test('hasFace is false only when the source and every ref are recorded face-free, or --no-face says so', async () => {
  assert.equal(stageRef.stagedHasFace(undefined, [false]), false);
  assert.equal(stageRef.stagedHasFace(undefined, [false, undefined]), undefined);
  assert.equal(stageRef.stagedHasFace(undefined, [false, true]), true);
  assert.equal(stageRef.stagedHasFace(undefined, [undefined]), undefined);
  assert.equal(stageRef.stagedHasFace(false, [true]), false, 'an explicit answer wins');

  const { dir, series, script } = await project();
  const client = { async postBinary() { return edited(320, 180); } };
  const faceOf = async (input) => {
    const { session } = await stageRef.runStageRef(client, series, script, { episode: 1, shot: '8', prompt: 'Remove the boat.', models: ['gpt-image-2-edit'], ...input });
    const sidecar = join(dir, session.candidates[0].path.replace(/\.png$/, '.provenance.json'));
    return JSON.parse(readFileSync(sidecar, 'utf-8')).hasFace;
  };
  const sheet = join(dir, 'characters', 'anna', 'front.png');
  writeFileSync(join(dir, 'characters', 'anna', 'front.provenance.json'), JSON.stringify({ generationModel: 'nano-banana-2', editModels: [], hasFace: true }));
  const emptyQuay = join(dir, 'empty-quay.png');
  writeFileSync(emptyQuay, await png(160, 90));
  writeFileSync(join(dir, 'empty-quay.provenance.json'), JSON.stringify({ generationModel: 'gpt-image-2', editModels: [], hasFace: false }));

  assert.equal(await faceOf({ fromPlate: 'north' }), false, 'a face-free plate, no refs');
  assert.equal(await faceOf({ fromPlate: 'north', refs: [emptyQuay] }), false, 'every input face-free');
  assert.equal(await faceOf({ fromPlate: 'north', refs: [sheet] }), true, 'a character sheet as --ref adds a face');
  assert.equal(await faceOf({ fromPlate: 'north', refs: [sheet], hasFace: false }), false, '--no-face');
  // A crop keeps the plate's lineage.
  assert.equal(await faceOf({ fromPlate: 'north', crop: '160:90:0:0' }), false);
});

test('the edit is refused before any call when a prompt is too long for a model, or there is no source', async () => {
  const { series, script } = await project();
  const client = { async postBinary() { throw new Error('must not be called'); } };
  await assert.rejects(
    stageRef.runStageRef(client, series, script, { episode: 1, shot: '8', fromPlate: 'north', prompt: 'x'.repeat(1600) }),
    /nano-banana-2-edit takes 1500/,
  );
  await assert.rejects(
    stageRef.runStageRef(client, series, script, { episode: 1, shot: '8', prompt: 'p' }),
    /Name one source/,
  );
  assert.equal(existsSync(join(series.outputDir, 'episodes', 'episode-001', 'staging')), false, 'nothing written');
});

test('a pick becomes the shot\'s staging ref, --use can change its role, and a clear restores the shot', async () => {
  const { dir, series, script } = await project();
  const client = { async postBinary() { return edited(320, 180); } };
  await stageRef.runStageRef(client, series, script, { episode: 1, shot: '8', fromPlate: 'east', prompt: 'Remove the flag.' });
  await assert.rejects(stageRef.pickStagingRef(series, script, '8', '7'), /No candidate "7"/);

  const { ref, session } = await stageRef.pickStagingRef(series, script, '8', 'nano-banana-2-edit');
  const shot = stageRef.findShot(script, '8');
  assert.equal(shot.stagingRef, ref);
  assert.equal(ref.use, 'plate');
  assert.equal(ref.replacesView, 'east');
  assert.equal(ref.model, 'nano-banana-2-edit');
  assert.equal(ref.sha256.length, 64);
  assert.equal(shot.mustStaySingle, true);
  assert.equal(ref.mustStaySingleBefore, undefined);
  assert.equal(session.picked, 2);
  assert.match(readFileSync(join(dir, ref.session, 'pick.html'), 'utf-8'), /picked/);

  // The same plate edit picked as a start frame (for a lane that takes no references).
  const asFrame = await stageRef.pickStagingRef(series, script, '8', '1', { use: 'start-frame' });
  assert.equal(asFrame.ref.use, 'start-frame');
  assert.equal(asFrame.ref.replacesView, undefined);

  // A hand-made image can be picked too; it joins the session.
  const hand = join(dir, 'hand.png');
  writeFileSync(hand, await png(320, 180, '#000000'));
  const again = await stageRef.pickStagingRef(series, script, '8', hand);
  assert.equal(again.ref.model, 'manual');
  assert.equal(again.ref.mustStaySingleBefore, undefined, 'the original value survives a re-pick');

  const removed = stageRef.clearStagingRef(shot);
  assert.equal(removed.model, 'manual');
  assert.equal(shot.stagingRef, undefined);
  assert.equal('mustStaySingle' in shot, false);
});

test('a hand-made pick becomes a PNG with its provenance; a session candidate named by its file is that candidate', async () => {
  const { dir, series, script } = await project();
  const client = { async postBinary() { return edited(320, 180); } };
  await stageRef.runStageRef(client, series, script, { episode: 1, shot: '8', fromPlate: 'east', prompt: 'Remove the flag.' });

  // A TIFF: its sidecars could not be named after it, so it is converted.
  const tif = join(dir, 'hand.tif');
  await sharp({ create: { width: 320, height: 180, channels: 3, background: '#203040' } }).tiff().toFile(tif);
  const fromTif = await stageRef.pickStagingRef(series, script, '8', tif);
  assert.match(fromTif.ref.path, /-picked\.png$/);
  const picked = readFileSync(join(dir, fromTif.ref.path));
  assert.equal(picked.subarray(1, 4).toString('latin1'), 'PNG', 'written as PNG');
  assert.equal(createHash('sha256').update(picked).digest('hex'), fromTif.ref.sha256, 'the hash is the image, not a sidecar');
  assert.ok(existsSync(join(dir, fromTif.ref.path.replace(/\.png$/, '.recipe.json'))), 'the recipe is a file of its own');

  // A JPEG with a provenance record keeps it.
  const jpg = join(dir, 'hand.jpg');
  await sharp({ create: { width: 320, height: 180, channels: 3, background: '#405060' } }).jpeg().toFile(jpg);
  writeFileSync(join(dir, 'hand.provenance.json'), JSON.stringify({ generationModel: 'gpt-image-2', editModels: [], hasFace: false }));
  const fromJpg = await stageRef.pickStagingRef(series, script, '8', jpg);
  assert.match(fromJpg.ref.path, /-picked\.png$/);
  const provenance = JSON.parse(readFileSync(join(dir, fromJpg.ref.path.replace(/\.png$/, '.provenance.json')), 'utf-8'));
  assert.equal(provenance.hasFace, false);

  // Naming a candidate's own file (absolute or project-relative) picks that candidate.
  const { session } = await stageRef.pickStagingRef(series, script, '8', '1');
  const count = session.candidates.length;
  const byPath = await stageRef.pickStagingRef(series, script, '8', join(dir, session.candidates[1].path));
  assert.equal(byPath.ref.model, 'nano-banana-2-edit');
  const byRelative = await stageRef.pickStagingRef(series, script, '8', session.candidates[0].path);
  assert.equal(byRelative.ref.model, 'gpt-image-2-edit');
  assert.equal(byRelative.session.candidates.length, count, 'no copy was added');
  await assert.rejects(stageRef.pickStagingRef(series, script, '8', join(dir, 'series-notes.txt')), /No candidate/);
  await assert.rejects(stageRef.pickStagingRef(series, script, '8', dir), /No candidate/, 'a folder is not an image');
  // A file that is no image is refused before anything is added.
  writeFileSync(join(dir, 'notes.tif'), 'not an image');
  await assert.rejects(stageRef.pickStagingRef(series, script, '8', join(dir, 'notes.tif')), /Could not read .* as an image to pick/);
  assert.equal(JSON.parse(readFileSync(join(dir, byRelative.ref.session, 'session.json'), 'utf-8')).candidates.length, count);
  assert.equal(existsSync(join(dir, byRelative.ref.session, `${count + 1}-picked.png`)), false);
});

test('every edit that lands is pickable, even when another cannot be saved', async () => {
  const { dir, series, script } = await project();
  const garbage = Buffer.alloc(40_000, 7);
  const client = {
    async postBinary(_path, body) { return body.modelId === 'gpt-image-2-edit' ? garbage : edited(320, 180); },
  };
  const { session, sessionDir } = await stageRef.runStageRef(client, series, script, { episode: 1, shot: '8', fromPlate: 'north', prompt: 'Remove the boat.' });
  assert.match(session.candidates[0].error, /could not be saved/);
  assert.ok(session.candidates[1].path);
  const saved = JSON.parse(readFileSync(join(sessionDir, 'session.json'), 'utf-8'));
  assert.equal(saved.candidates.length, 2);
  const { ref } = await stageRef.pickStagingRef(series, script, '8', '2');
  assert.ok(existsSync(join(dir, ref.path)));
});

test('a staged plate drops the storyboard plate and outranks the location\'s words', async () => {
  const { dir, series, shot } = await project();
  mkdirSync(join(dir, 'storyboards'), { recursive: true });
  writeFileSync(join(dir, 'storyboards', 'beat-1.png'), await png(320, 180, '#111111'));
  series.storyboardRefs = [{ slug: 'beat-1', description: 'd', characters: ['ANNA'], location: 'harbour-steps' }];
  const staged = join(dir, 'episodes', 'episode-001', 'staging', 'shot-008', 's1');
  mkdirSync(staged, { recursive: true });
  writeFileSync(join(staged, '1-gpt-image-2-edit.png'), await png(320, 180, '#224466'));
  const plateRef = { path: 'episodes/episode-001/staging/shot-008/s1/1-gpt-image-2-edit.png', use: 'plate', source: 'locations/harbour-steps/north.png', replacesView: 'north', model: 'gpt-image-2-edit', prompt: 'p', sha256: 'x', session: 's', pickedAt: '' };
  const plain = buildReferenceSlotPlan(series, shot(8, { storyboardRef: 'beat-1' }), 'seedance-2-5-reference-to-video');
  assert.ok(plain.slots.some(slot => slot.kind === 'storyboard'), 'the fixture has a storyboard plate');
  const plan = buildReferenceSlotPlan(series, shot(8, { storyboardRef: 'beat-1', stagingRef: plateRef }), 'seedance-2-5-reference-to-video');
  assert.equal(plan.slots.some(slot => slot.kind === 'storyboard'), false);
  assert.ok(plan.dropped.some(note => /staging ref replaces it/.test(note)));
  const prompt = buildVideoPrompt(shot(8, { stagingRef: plateRef }), series);
  const slot = prompt.referenceSlots.find(item => item.path.endsWith('1-gpt-image-2-edit.png'));
  assert.match(prompt.prompt, new RegExp(`Location \\(where these words describe something @Image${slot.imageIndex} does not show, leave it out: the staged image is right\\):`));
});

test('staleStagedShots lists staged shots whose clip is not from the pick, and nothing else', async () => {
  const { dir, series, script } = await project();
  const sceneDir = join(dir, 'episodes', 'episode-001', 'scene-001');
  mkdirSync(sceneDir, { recursive: true });
  for (const n of ['007', '008', '009']) writeFileSync(join(sceneDir, `shot-${n}.mp4`), 'clip');
  script.shots[1].stagingRef = { ...startFrameRef('gone.png'), sha256: 'abc' };
  script.shots[2].stagingRef = { ...startFrameRef('gone.png'), sha256: 'def' };
  writeFileSync(join(sceneDir, 'shot-009.video.json'), JSON.stringify({ metadata: { stagingRef: { sha256: 'def' } } }));
  const stale = staleStagedShots(series, script, sceneDir);
  assert.deepEqual(stale.map(item => item.shot), ['8'], 'shot 7 is not staged, shot 9 is rendered from its pick');
  assert.match(stale[0].reason, /not rendered from the pick; the picked image is not on disk/);
  script.shots[0].stagingRef = startFrameRef('gone.png');
  writeFileSync(join(sceneDir, 'shot-007.mp4'), 'clip');
  assert.deepEqual(staleStagedShots(series, script, sceneDir).map(item => item.shot), ['7', '8']);
});

test('the shot\'s montage cut in media-library is listed as the pre-pick archive', async () => {
  const { dir, series } = await project();
  const library = join(dir, 'episodes', 'episode-001', 'media-library', 'scene-01');
  mkdirSync(library, { recursive: true });
  writeFileSync(join(library, 'shot-008.mp4'), 'cut');
  assert.deepEqual(stageRef.mediaLibraryCopies(series, 1, '8'), [join(library, 'shot-008.mp4')]);
  assert.deepEqual(stageRef.mediaLibraryCopies(series, 1, '9'), []);
});

test('a frame source defaults to start-frame; --use and --replaces override', async () => {
  const { dir, series, script } = await project();
  const frame = join(dir, 'frame.png');
  writeFileSync(frame, await png(320, 180));
  const sessionDir = join(dir, 'tmp-session');
  const shot = stageRef.findShot(script, '8');
  const asFrame = await stageRef.prepareStageSource(series, script, shot, { episode: 1, shot: '8', from: frame, prompt: 'p' }, sessionDir);
  assert.equal(asFrame.use, 'start-frame');
  const asPlate = await stageRef.prepareStageSource(series, script, shot, { episode: 1, shot: '8', from: frame, use: 'plate', replacesView: 'north', prompt: 'p' }, sessionDir);
  assert.equal(asPlate.use, 'plate');
  assert.equal(asPlate.replacesView, 'north');
  const plateFile = await stageRef.prepareStageSource(series, script, shot, { episode: 1, shot: '8', from: join(dir, 'locations', 'harbour-steps', 'south.png'), prompt: 'p' }, sessionDir);
  assert.equal(plateFile.use, 'plate');
  assert.equal(plateFile.replacesView, 'south');
  const cropped = await stageRef.prepareStageSource(series, script, shot, { episode: 1, shot: '8', from: frame, crop: '160:90:10:10', prompt: 'p' }, sessionDir);
  assert.equal((await sharp(cropped.path).metadata()).width, 160);
  assert.equal(cropped.lineagePath, frame, 'a crop keeps the source\'s lineage');
  await assert.rejects(stageRef.prepareStageSource(series, script, shot, { episode: 1, shot: '8', from: frame, crop: '400:90:0:0', prompt: 'p' }, sessionDir), /outside/);
});

test('--from-shot takes a clip cut from a longer render a little after its first frame, and says so', { skip: !ffmpegAvailable }, async () => {
  const { dir, series, script } = await project();
  const sceneDir = join(dir, 'episodes', 'episode-001', 'scene-001');
  mkdirSync(sceneDir, { recursive: true });
  for (const n of ['007', '009']) {
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=2', '-pix_fmt', 'yuv420p', '-y', join(sceneDir, `shot-${n}.mp4`)]);
  }
  writeFileSync(join(sceneDir, 'shot-007.video.json'), JSON.stringify({ metadata: { generationUnit: 'montage-s01-007-009', generatedFromUnit: 'montage-s01-007-009.mp4' } }));
  const shot = stageRef.findShot(script, '8');

  const cut = await stageRef.prepareStageSource(series, script, shot, { episode: 1, shot: '8', fromShot: '7', prompt: 'p' }, join(dir, 's1'));
  assert.equal(cut.use, 'start-frame');
  assert.match(cut.note, /at 0\.50 s/);
  assert.match(cut.warning, /cut from montage-s01-007-009\.mp4/);
  const chosen = await stageRef.prepareStageSource(series, script, shot, { episode: 1, shot: '8', fromShot: '7', at: 0, prompt: 'p' }, join(dir, 's2'));
  assert.match(chosen.note, /at 0\.00 s/);
  assert.equal(chosen.warning, undefined, 'an explicit --at is taken as given');
  // A clip rendered on its own starts on its own first frame.
  const single = await stageRef.prepareStageSource(series, script, shot, { episode: 1, shot: '8', fromShot: '9', prompt: 'p' }, join(dir, 's3'));
  assert.match(single.note, /at 0\.00 s/);
  assert.equal(single.warning, undefined);

  // The warning reaches the session and its pick page.
  const client = { async postBinary() { return edited(160, 90); } };
  const { session, pickPage } = await stageRef.runStageRef(client, series, script, { episode: 1, shot: '8', fromShot: '7', prompt: 'Remove the flag.', models: ['gpt-image-2-edit'] });
  assert.match(session.sourceWarning, /first frames can belong to the shot before/);
  assert.match(readFileSync(pickPage, 'utf-8'), /first frames can belong to the shot before/);
});

test('a pick in a montage run lists the units it splits', async () => {
  const { script, series } = await project();
  const before = buildGenerationPlan(script, series);
  assert.deepEqual(before.units.map(u => u.unitId), ['montage-s01-007-009']);
  script.shots[1].stagingRef = startFrameRef();
  script.shots[1].mustStaySingle = true;
  const changes = stageRef.unitChanges(before, buildGenerationPlan(script, series));
  assert.deepEqual(changes.removed.map(u => u.unitId), ['montage-s01-007-009']);
  assert.deepEqual(changes.added.map(u => u.shotNumbers), [[7], [8], [9]]);
  assert.match(stageRef.describeUnit(changes.removed[0]), /montage-s01-007-009 \(montage, shots 7, 8, 9\)/);
  // A re-pick packages nothing differently.
  const after = buildGenerationPlan(script, series);
  assert.deepEqual(stageRef.unitChanges(after, buildGenerationPlan(script, series)), { removed: [], added: [] });
});

test('the stage-ref command records a pick, lists the units it splits, and --clear puts them back', async () => {
  const { dir, series, script } = await project();
  writeFileSync(join(dir, 'series.json'), JSON.stringify(series));
  const episodeDir = join(dir, 'episodes', 'episode-001');
  mkdirSync(episodeDir, { recursive: true });
  writeFileSync(join(episodeDir, 'script.json'), JSON.stringify(script));
  const client = { async postBinary() { return edited(320, 180); } };
  await stageRef.runStageRef(client, series, script, { episode: 1, shot: '8', fromPlate: 'north', prompt: 'Remove the moored boat.' });

  const pick = spawnSync(process.execPath, [cli, 'stage-ref', '-p', dir, '-e', '1', '--shot', '8', '--pick', '2'], { encoding: 'utf-8' });
  assert.equal(pick.status, 0, pick.stderr);
  assert.match(pick.stdout, /replaces the north view/);
  assert.match(pick.stdout, /was: montage-s01-007-009 \(montage, shots 7, 8, 9\)/);
  assert.match(pick.stdout, /now: unit-008 \(single, shot 8\)/);
  assert.match(pick.stdout, /can render again on the next generate-videos \(billed\)/);
  const saved = JSON.parse(readFileSync(join(episodeDir, 'script.json'), 'utf-8'));
  assert.equal(saved.shots[1].stagingRef.model, 'nano-banana-2-edit');
  assert.equal(saved.shots[1].mustStaySingle, true);

  const clear = spawnSync(process.execPath, [cli, 'stage-ref', '-p', dir, '-e', '1', '--shot', '8', '--clear'], { encoding: 'utf-8' });
  assert.equal(clear.status, 0, clear.stderr);
  assert.match(clear.stdout, /now: montage-s01-007-009/);
  const cleared = JSON.parse(readFileSync(join(episodeDir, 'script.json'), 'utf-8'));
  assert.equal(cleared.shots[1].stagingRef, undefined);
  assert.equal('mustStaySingle' in cleared.shots[1], false);
});

test('the pick says when its lane will refuse it: a face start frame on MiniMax i2v, a plate on a lane with no references', async () => {
  const { dir, series, shot } = await project({ characterConsistencyModel: 'minimax-h3-max-reference-to-video' });
  const staging = join(dir, 'episodes', 'episode-001', 'staging', 'shot-008', 's1');
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, '1-gpt-image-2-edit.png'), await png(160, 90));
  const path = 'episodes/episode-001/staging/shot-008/s1/1-gpt-image-2-edit.png';
  const frame = shot(8, { stagingRef: startFrameRef(path) });
  const [face] = await stageRef.stagingLaneNotes(series, frame, 1);
  assert.match(face, /minimax-h3-max-image-to-video is a MiniMax image-to-video lane/);
  assert.match(face, /generate-videos will refuse the shot/);
  writeFileSync(join(staging, '1-gpt-image-2-edit.provenance.json'), JSON.stringify({ generationModel: 'gpt-image-2', editModels: [], hasFace: false }));
  assert.match((await stageRef.stagingLaneNotes(series, frame, 1))[0], /recorded as showing no face/);

  const plateRef = { ...startFrameRef(path), use: 'plate', replacesView: 'north' };
  const onI2v = await project({ atmosphereModel: 'seedance-2-0-image-to-video' });
  const atmosphere = onI2v.shot(8, { characters: [], videoModel: 'atmosphere', stagingRef: plateRef });
  assert.match((await stageRef.stagingLaneNotes(onI2v.series, atmosphere, 1))[0], /sends no location reference/);
  assert.match((await stageRef.stagingLaneNotes(onI2v.series, atmosphere, 1))[0], /venice-video stage-ref -p "[^"]+" -e 1 --shot 8 --pick \S+ --session s --use start-frame/);
  const onKling = await project({ characterConsistencyModel: 'kling-o3-standard-reference-to-video' });
  assert.match((await stageRef.stagingLaneNotes(onKling.series, onKling.shot(8, { stagingRef: plateRef }), 1))[0], /scene image.*venice-video stage-ref -p "[^"]+" -e 1 --shot 8 --from "[^"]+shot-008\.png" --use start-frame/);
  const onSeedance = await project();
  assert.deepEqual(await stageRef.stagingLaneNotes(onSeedance.series, onSeedance.shot(8, { stagingRef: plateRef }), 1), []);
});
