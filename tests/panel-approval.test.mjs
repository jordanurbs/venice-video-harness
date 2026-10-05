// QA approval is bound to the panels a human reviewed.
//
// `qa-approve` records, per shot, a sha256 of the panel bytes and a digest of
// the settings the panel depends on (image prompt, references, image models).
// `generate-videos` recomputes both and refuses any shot that no longer
// matches, before touching the API key or billing anything.
//
// Pure digest tests, then the two CLI commands against a scratch project.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareApproval,
  settingsDigest,
  sha256Hex,
  panelSettingsForShot,
  approvalForShot,
  verifyApproval,
} from '../dist/mini-drama/panel-approval.js';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'mini-drama', 'cli.js');

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
// A different valid-looking PNG payload (header + different trailing bytes).
const PNG_OTHER = Buffer.concat([PNG_1PX.subarray(0, 16), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])]);

// ---- Pure ------------------------------------------------------------------

const SETTINGS = {
  prompt: 'p', negativePrompt: 'n', seed: 1, generationModel: 'g', editModel: 'e', aspectRatio: '16:9',
  referenceImages: ['characters/aria/front.png'],
};

test('settingsDigest is stable across key order and ignores undefined fields', () => {
  const a = settingsDigest(SETTINGS);
  const b = settingsDigest({ referenceImages: [...SETTINGS.referenceImages], aspectRatio: '16:9', editModel: 'e', generationModel: 'g', seed: 1, negativePrompt: 'n', prompt: 'p', skipRefine: undefined });
  assert.equal(a, b);
  assert.notEqual(a, settingsDigest({ ...SETTINGS, prompt: 'p2' }));
  assert.notEqual(a, settingsDigest({ ...SETTINGS, generationModel: 'other' }));
  assert.notEqual(a, settingsDigest({ ...SETTINGS, referenceImages: [] }));
});

test('compareApproval names exactly what changed', () => {
  const recorded = { panelSha256: sha256Hex(PNG_1PX), settingsDigest: settingsDigest(SETTINGS) };
  const same = { panelSha256: sha256Hex(PNG_1PX), settingsDigest: settingsDigest(SETTINGS) };
  assert.deepEqual(compareApproval(recorded, same), []);
  assert.deepEqual(compareApproval(recorded, { ...same, panelSha256: sha256Hex(PNG_OTHER) }), [{ kind: 'panel-changed' }]);
  assert.deepEqual(compareApproval(recorded, { ...same, panelSha256: undefined }), [{ kind: 'panel-missing' }]);
  assert.deepEqual(compareApproval(recorded, { ...same, settingsDigest: 'x' }), [{ kind: 'settings-changed' }]);
  assert.deepEqual(
    compareApproval(recorded, { panelSha256: sha256Hex(PNG_OTHER), settingsDigest: 'x' }).map(m => m.kind).sort(),
    ['panel-changed', 'settings-changed'],
  );
  assert.deepEqual(compareApproval(undefined, same), [{ kind: 'not-recorded' }]);
});

// ---- Scratch project -------------------------------------------------------

function makeProject() {
  const projectDir = mkdtempSync(join(tmpdir(), 'panel-approval-'));
  const series = {
    name: 'Bind', slug: 'bind', concept: 'c', genre: 'drama', setting: 's', outputDir: projectDir,
    aesthetic: { style: 'Cinematic photography', palette: 'warm amber', lighting: 'natural', lensCharacteristics: 'shallow', filmStock: 'digital' },
    storyboardAspectRatio: '16:9',
    videoDefaults: { imageDefaults: { generationModel: 'nano-banana-2', editModel: 'nano-banana-2-edit' } },
    characters: [{ name: 'ARIA', gender: 'female', age: '20s', description: 'inventor', fullDescription: 'ARIA', wardrobe: 'jacket', locked: true, seed: 1 }],
    locations: [],
    episodes: [{ number: 1, title: 'Bind', status: 'approved' }],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  writeFileSync(join(projectDir, 'series.json'), JSON.stringify(series));
  mkdirSync(join(projectDir, 'characters', 'aria'), { recursive: true });
  writeFileSync(join(projectDir, 'characters', 'aria', 'front.png'), PNG_1PX);

  const episodeDir = join(projectDir, 'episodes', 'episode-001');
  const sceneDir = join(episodeDir, 'scene-001');
  mkdirSync(sceneDir, { recursive: true });
  const shots = [
    { shotNumber: 1, type: 'action', duration: '5s', videoModel: 'action', environment: 'DAY_EXTERIOR', description: 'ARIA walks in.', characters: ['ARIA'], cameraMovement: 'static', transition: 'CUT' },
    { shotNumber: 2, type: 'action', duration: '5s', videoModel: 'atmosphere', environment: 'DAY_EXTERIOR', description: 'Empty street.', characters: [], cameraMovement: 'static', transition: 'CUT' },
  ];
  const writeScript = (s) => writeFileSync(join(episodeDir, 'script.json'), JSON.stringify({ episodeNumber: 1, title: 'Bind', status: 'approved', shots: s }));
  writeScript(shots);
  writeFileSync(join(sceneDir, 'shot-001.png'), PNG_1PX);
  writeFileSync(join(sceneDir, 'shot-002.png'), PNG_1PX);
  writeFileSync(join(episodeDir, 'qa-report.json'), JSON.stringify({ episode: 1, summary: { total: 2, pass: 2, flagCritical: 0, flagModerate: 0, flagLow: 0, errored: 0 }, results: [] }));

  return {
    projectDir, episodeDir, sceneDir, series, shots, writeScript,
    // Isolate the user config: an empty VENICE_API_KEY is NOT enough — the CLI
    // hydrates a stored key from the config dir when the env var is falsy, and
    // generate-videos would then queue a real billed render. Point the config
    // dir at the scratch project so no stored key (or pending-job record) can
    // reach the operator's real one.
    run: (...args) => spawnSync(process.execPath, [cli, ...args, '-p', projectDir, '-e', '1'], { encoding: 'utf-8', env: { ...process.env, VENICE_API_KEY: '', VENICE_VIDEO_CONFIG_DIR: join(projectDir, '.test-config') } }),
    cleanup: () => rmSync(projectDir, { recursive: true, force: true }),
  };
}

function loadSeries(p) {
  return JSON.parse(readFileSync(join(p.projectDir, 'series.json'), 'utf-8'));
}

test('panelSettingsForShot folds in the prompt, references and image models', () => {
  const p = makeProject();
  try {
    const s = panelSettingsForShot(loadSeries(p), p.shots[0]);
    assert.match(s.prompt, /ARIA walks in/);
    assert.equal(s.generationModel, 'nano-banana-2');
    assert.equal(s.editModel, 'nano-banana-2-edit');
    assert.deepEqual(s.referenceImages, ['characters/aria/front.png']);
    // The no-character shot has no references.
    assert.deepEqual(panelSettingsForShot(loadSeries(p), p.shots[1]).referenceImages, []);
  } finally {
    p.cleanup();
  }
});

test('approvalForShot and verifyApproval round-trip on an unchanged project', () => {
  const p = makeProject();
  try {
    const series = loadSeries(p);
    const artifact = { episode: 1, approvedAt: 'now', notes: '', shots: {} };
    for (const shot of p.shots) artifact.shots[String(shot.shotNumber).padStart(3, '0')] = approvalForShot(series, shot, p.sceneDir);
    assert.deepEqual(verifyApproval(artifact, series, p.shots, p.sceneDir), []);
  } finally {
    p.cleanup();
  }
});

test('qa-approve writes a per-shot binding; generate-videos accepts it without an API key being needed first', () => {
  const p = makeProject();
  try {
    const approve = p.run('qa-approve');
    assert.equal(approve.status, 0, approve.stderr);
    assert.match(approve.stdout, /2 panel\(s\) bound/);
    const artifact = JSON.parse(readFileSync(join(p.episodeDir, 'qa-approved.json'), 'utf-8'));
    assert.deepEqual(Object.keys(artifact.shots).sort(), ['001', '002']);
    assert.equal(artifact.shots['001'].panelSha256, sha256Hex(PNG_1PX));
    assert.match(artifact.shots['001'].settingsDigest, /^[0-9a-f]{64}$/);

    // Unchanged: the gate passes and we fall through to the API-key prompt
    // (no key in the env), proving the approval check ran first and passed.
    const gen = p.run('generate-videos');
    assert.notEqual(gen.status, 0);
    assert.doesNotMatch(gen.stderr, /changed after QA approval/);
    assert.doesNotMatch(gen.stderr, /QA gate has not been cleared/);
  } finally {
    p.cleanup();
  }
});

test('a panel regenerated after approval blocks generate-videos until re-approved', () => {
  const p = makeProject();
  try {
    assert.equal(p.run('qa-approve').status, 0);
    writeFileSync(join(p.sceneDir, 'shot-001.png'), PNG_OTHER);

    const blocked = p.run('generate-videos');
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /1 shot\(s\) changed after QA approval/);
    assert.match(blocked.stderr, /shot 001: panel was regenerated or edited after approval/);
    assert.doesNotMatch(blocked.stderr, /shot 002/);
    assert.match(blocked.stderr, /qa-approve/);

    assert.equal(p.run('qa-approve').status, 0, 're-approve');
    const after = p.run('generate-videos');
    assert.doesNotMatch(after.stderr, /changed after QA approval/);
  } finally {
    p.cleanup();
  }
});

test('a changed prompt, reference or image model after approval blocks generate-videos', () => {
  const p = makeProject();
  try {
    assert.equal(p.run('qa-approve').status, 0);

    // Prompt: edit the shot description.
    p.writeScript([{ ...p.shots[0], description: 'ARIA runs in.' }, p.shots[1]]);
    let r = p.run('generate-videos');
    assert.match(r.stderr, /shot 001: prompt, references or image model changed after approval/);
    p.writeScript(p.shots);

    // Reference: an anchor.png now outranks front.png for ARIA.
    writeFileSync(join(p.projectDir, 'characters', 'aria', 'anchor.png'), PNG_OTHER);
    r = p.run('generate-videos');
    assert.match(r.stderr, /shot 001: prompt, references or image model changed/);
    rmSync(join(p.projectDir, 'characters', 'aria', 'anchor.png'));

    // Image model: both shots depend on it.
    const series = loadSeries(p);
    series.videoDefaults.imageDefaults.generationModel = 'seedream-v5-lite';
    writeFileSync(join(p.projectDir, 'series.json'), JSON.stringify(series));
    r = p.run('generate-videos');
    assert.match(r.stderr, /2 shot\(s\) changed after QA approval/);
  } finally {
    p.cleanup();
  }
});

test('a shot added after approval, or a legacy artifact without bindings, is refused as not-recorded', () => {
  const p = makeProject();
  try {
    assert.equal(p.run('qa-approve').status, 0);
    writeFileSync(join(p.sceneDir, 'shot-003.png'), PNG_1PX);
    p.writeScript([...p.shots, { ...p.shots[1], shotNumber: 3 }]);
    let r = p.run('generate-videos');
    assert.match(r.stderr, /shot 003: approval predates per-shot binding \(or shot was added after approval\)/);

    // Legacy artifact: existence used to be enough. Not any more.
    writeFileSync(join(p.episodeDir, 'qa-approved.json'), JSON.stringify({ episode: 1, approvedAt: 'then', notes: 'legacy' }));
    r = p.run('generate-videos');
    assert.match(r.stderr, /3 shot\(s\) changed after QA approval/);
  } finally {
    p.cleanup();
  }
});

test('--skip-qa still bypasses the binding check (and says so)', () => {
  const p = makeProject();
  try {
    assert.equal(p.run('qa-approve').status, 0);
    writeFileSync(join(p.sceneDir, 'shot-001.png'), PNG_OTHER);
    const r = p.run('generate-videos', '--skip-qa');
    assert.doesNotMatch(r.stderr, /changed after QA approval/);
    assert.ok(existsSync(join(p.episodeDir, 'qa-approved.json')));
  } finally {
    p.cleanup();
  }
});
