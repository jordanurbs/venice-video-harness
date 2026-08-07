// Smoke test: cutMontageIntoShots against a synthetic 30s clip.
// Run scripts/smoke-montage-plan.ts's sibling setup first (see shell), then:
//   npx tsx scripts/smoke-montage-cut.ts
import { cutMontageIntoShots } from '../src/mini-drama/montage.js';
import type { GenerationUnit, ShotScript } from '../src/series/types.js';

const sceneDir = '/tmp/montage-cut-test/episode-1/scene-001';
const episodeDir = '/tmp/montage-cut-test/episode-1';
const montagePath = `${sceneDir}/montage-s01-001-003.mp4`;

const unit: GenerationUnit = {
  unitId: 'montage-s01-001-003',
  unitType: 'montage',
  shotNumbers: [1, 2, 3],
  outputFile: 'montage-s01-001-003.mp4',
  model: 'seedance-2-5-reference-to-video',
  duration: '30s',
  startFrameStrategy: 'panel',
  endFrameStrategy: 'natural',
  decisionReasons: ['smoke'],
  fallbackToSingles: false,
  sceneNumber: 1,
  montageBeats: [
    { shotNumber: 1, startSec: 0, endSec: 10 },
    { shotNumber: 2, startSec: 10, endSec: 22 },
    { shotNumber: 3, startSec: 22, endSec: 30 },
  ],
};

const shots = new Map<number, ShotScript>([1, 2, 3].map(n => [n, {
  shotNumber: n,
  type: 'action',
  duration: `${[10, 12, 8][n - 1]}s`,
  videoModel: 'action',
  description: `beat ${n}`,
  characters: [],
  dialogue: null,
  sfx: null,
  cameraMovement: 'static',
  transition: 'CUT',
} as ShotScript]));

const result = cutMontageIntoShots({
  montagePath,
  unit,
  shotsByNumber: shots,
  sceneDir,
  episodeDir,
  archiveExisting: () => {},
});

console.log('segments:', JSON.stringify(result.segments, null, 2));
console.log('shotPaths:', result.shotPaths);
console.log('libraryPaths:', result.libraryPaths);
