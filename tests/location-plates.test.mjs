// Tests for the compass location plates (north/south/east/west, 2026-10-05).
// Asserts the canonical plate set, the legacy-name back-compat, and the
// reference-slot allocator's plate ordering and role clauses.
// Runs under `npm test` (node --test) after `npm run build`.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DEFAULT_LOCATION_ANGLES,
  DERIVED_ANGLES,
  HERO_ANGLE,
  LEGACY_LOCATION_ANGLES,
  LOCATION_ANGLES,
} from '../dist/mini-drama/location-generator.js';
import { buildReferenceSlotPlan } from '../dist/mini-drama/reference-slots.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test('plate set is exactly north/south/east/west', () => {
  assert.deepEqual([...DEFAULT_LOCATION_ANGLES], ['north', 'south', 'east', 'west']);
  assert.equal(HERO_ANGLE, 'north');
  assert.deepEqual([...DERIVED_ANGLES], ['south', 'east', 'west']);
  // Back-compat alias stays pointed at the default set.
  assert.deepEqual([...LOCATION_ANGLES], [...DEFAULT_LOCATION_ANGLES]);
});

test('legacy pre-compass names remain recognized', () => {
  for (const legacy of ['wide', 'angle-2', 'angle-3', 'angle-4', 'medium', 'detail']) {
    assert.ok(LEGACY_LOCATION_ANGLES.includes(legacy), `missing legacy name ${legacy}`);
  }
  // The compass names are NOT legacy.
  for (const angle of DEFAULT_LOCATION_ANGLES) {
    assert.ok(!LEGACY_LOCATION_ANGLES.includes(angle));
  }
});

test('slot allocator orders plates north first and labels walls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'venice-plates-'));
  try {
    mkdirSync(join(dir, 'characters', 'bob'), { recursive: true });
    writeFileSync(join(dir, 'characters', 'bob', 'front.png'), PNG);
    mkdirSync(join(dir, 'locations', 'courtyard'), { recursive: true });
    for (const f of ['north.png', 'south.png', 'east.png', 'west.png']) {
      writeFileSync(join(dir, 'locations', 'courtyard', f), PNG);
    }

    const series = {
      name: 't', slug: 't', concept: '', genre: '', setting: '', aesthetic: null,
      characters: [{
        name: 'BOB', gender: 'male', age: '30s', description: 'd',
        fullDescription: 'fd', wardrobe: 'w', voiceDescription: '', locked: true, seed: 1,
      }],
      locations: [{ name: 'Courtyard', slug: 'courtyard', description: 'castle courtyard', seed: 1 }],
      episodes: [], videoDefaults: { actionModel: 'x', atmosphereModel: 'x' },
      outputDir: dir, createdAt: '', updatedAt: '',
    };
    const shot = {
      shotNumber: 1, type: 'action', duration: '10s', videoModel: 'action',
      description: 'BOB crosses the courtyard.',
      characters: ['BOB'], location: 'courtyard',
      dialogue: null, sfx: null, cameraMovement: 'static', transition: 'CUT',
    };

    const plan = buildReferenceSlotPlan(series, shot, 'seedance-2-0-enhanced-reference-to-video');
    const locationSlots = plan.slots.filter(s => s.kind === 'location');
    assert.equal(locationSlots.length, 4);
    assert.ok(locationSlots[0].path.endsWith('north.png'));
    assert.ok(locationSlots[1].path.endsWith('south.png'));
    assert.ok(locationSlots[2].path.endsWith('east.png'));
    assert.ok(locationSlots[3].path.endsWith('west.png'));
    // The first plate carries the generic environment clause; the derived
    // plates are labeled by wall.
    assert.match(locationSlots[0].roleClause, /location environment reference/);
    assert.match(locationSlots[1].roleClause, /south wall/);
    assert.match(locationSlots[2].roleClause, /east wall/);
    assert.match(locationSlots[3].roleClause, /west wall/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('slot allocator still reads legacy plate names on old projects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'venice-plates-legacy-'));
  try {
    mkdirSync(join(dir, 'locations', 'courtyard'), { recursive: true });
    for (const f of ['wide.png', 'angle-2.png']) {
      writeFileSync(join(dir, 'locations', 'courtyard', f), PNG);
    }

    const series = {
      name: 't', slug: 't', concept: '', genre: '', setting: '', aesthetic: null,
      characters: [],
      locations: [{ name: 'Courtyard', slug: 'courtyard', description: 'castle courtyard', seed: 1 }],
      episodes: [], videoDefaults: { actionModel: 'x', atmosphereModel: 'x' },
      outputDir: dir, createdAt: '', updatedAt: '',
    };
    const shot = {
      shotNumber: 1, type: 'establishing', duration: '10s', videoModel: 'atmosphere',
      description: 'The courtyard at dawn.',
      characters: [], location: 'courtyard',
      dialogue: null, sfx: null, cameraMovement: 'static', transition: 'CUT',
    };

    const plan = buildReferenceSlotPlan(series, shot, 'seedance-2-0-enhanced-reference-to-video');
    const locationSlots = plan.slots.filter(s => s.kind === 'location');
    assert.equal(locationSlots.length, 2);
    assert.ok(locationSlots[0].path.endsWith('wide.png'));
    assert.ok(locationSlots[1].path.endsWith('angle-2.png'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
