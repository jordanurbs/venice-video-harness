// Smoke test: montage-first planning + timestamped SEQUENCE prompt.
// Run: npx tsx scripts/smoke-montage-plan.ts
import { buildGenerationPlan } from '../src/mini-drama/generation-planner.js';
import { buildMontagePrompt } from '../src/mini-drama/prompt-builder.js';
import { groupShotsIntoScenes, layoutMontageBeats } from '../src/mini-drama/montage.js';
import type { EpisodeScript, SeriesState, ShotScript } from '../src/series/types.js';

function shot(n: number, over: Partial<ShotScript> = {}): ShotScript {
  return {
    shotNumber: n,
    type: 'action',
    duration: '4s',
    videoModel: 'action',
    description: `THE DRIVER grips the wheel, beat ${n}`,
    characters: ['DRIVER'],
    dialogue: null,
    sfx: 'engine snarl',
    cameraMovement: 'tracking',
    transition: 'CUT',
    location: 'canyon-highway',
    ...over,
  };
}

const script: EpisodeScript = {
  episode: 1,
  title: 'Dust Line',
  logline: 'smoke',
  shots: [
    shot(1, { type: 'establishing', duration: '3s', characters: [] }),
    shot(2, { duration: '2s' }),
    shot(3, { duration: '3s' }),
    shot(4, { duration: '4s' }),
    shot(5, { duration: '4s' }),
    shot(6, { duration: '3s' }),
    shot(7, { duration: '4s' }),
    shot(8, { duration: '4s' }),
    shot(9, { duration: '3s' }),
    // location change → new scene
    shot(10, { duration: '5s', location: 'ridge' }),
    shot(11, { duration: '5s', location: 'ridge' }),
    // title card → single fallback
    shot(12, { type: 'insert', duration: '3s', description: 'title card: DUST LINE', characters: [], location: 'ridge' }),
  ],
} as unknown as EpisodeScript;

const series = {
  outputDir: '/tmp/smoke-montage-project',
  videoDefaults: {},
  aesthetic: {
    style: 'anamorphic 35mm, warm golden highlights and cool teal shadows',
    palette: 'ochre, teal, bone white',
    lighting: 'hard golden-hour backlight',
  },
  characters: [
    {
      name: 'DRIVER',
      gender: 'female',
      age: 'mid-30s',
      description: 'sun-weathered brown skin, sharp jaw, short black hair under an amber bandana',
      wardrobe: 'dust-caked tan canvas jacket over a grey henley, fingerless leather gloves',
    },
  ],
  locations: [],
  episodes: [],
  storyboardAspectRatio: '16:9',
} as unknown as SeriesState;

console.log('=== scene grouping ===');
for (const scene of groupShotsIntoScenes(script.shots)) {
  console.log(`scene ${scene.sceneNumber} (${scene.location ?? 'untagged'}): shots ${scene.shots.map(s => s.shotNumber).join(',')}`);
}

console.log('\n=== generation plan (montage-first default) ===');
const plan = buildGenerationPlan(script, series);
for (const unit of plan.units) {
  console.log(`${unit.unitId}  [${unit.unitType}]  model=${unit.model}  duration=${unit.duration}  shots=${unit.shotNumbers.join(',')}`);
  if (unit.montageBeats) {
    console.log(`  beats: ${unit.montageBeats.map(b => `#${b.shotNumber}@${b.startSec}-${b.endSec}`).join('  ')}`);
  }
}

console.log('\n=== plan with montageMode: false (legacy) ===');
const legacy = buildGenerationPlan(script, { videoDefaults: { ...series.videoDefaults, montageMode: false } });
for (const unit of legacy.units) {
  console.log(`${unit.unitId}  [${unit.unitType}]  duration=${unit.duration}  shots=${unit.shotNumbers.join(',')}`);
}

console.log('\n=== montage prompt (first montage unit) ===');
const mUnit = plan.units.find(u => u.unitType === 'montage')!;
const shots = mUnit.shotNumbers.map(n => script.shots.find(s => s.shotNumber === n)!);
const prompt = buildMontagePrompt(shots, mUnit, series);
console.log(`model=${prompt.model} duration=${prompt.duration} chars=${prompt.prompt.length}`);
console.log('---');
console.log(prompt.prompt);
console.log('---');

// Beat layout sanity
const beats = layoutMontageBeats(shots);
const last = beats[beats.length - 1];
if (`${last.endSec}s` !== mUnit.duration) {
  console.log(`NOTE: unit duration ${mUnit.duration} vs beat total ${last.endSec}s`);
}
console.log('\nsmoke OK');
