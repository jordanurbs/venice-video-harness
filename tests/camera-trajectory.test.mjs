// camera_trajectory wiring: buildModelParams attaches it only for the
// multi-angle model, validates it, and the ergonomic builders produce
// server-legal paths. Field name + limits confirmed against the live strict
// queue schema on 2026-09-15 (see scripts/probe-minimax-multi-angle.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildModelParams,
  buildOrbitTrajectory,
  buildStartEndTrajectory,
  validateCameraTrajectory,
  supportsCameraTrajectory,
  CAMERA_MAX_AZIMUTH_TRAVEL_DEG,
} from '../packages/core/dist/venice/models.js';

const MODEL = 'minimax-h3-max-multi-angle';

test('buildModelParams attaches camera_trajectory for the multi-angle model', () => {
  const traj = buildStartEndTrajectory(
    { azimuth: 0, elevation: 0, distance: 1 },
    { azimuth: 360, elevation: 10, distance: 0.85 },
  );
  const params = buildModelParams(MODEL, { resolution: '768P', cameraTrajectory: traj });
  assert.equal(params.resolution, '768P');
  assert.deepEqual(params.camera_trajectory, traj);
  // i2v inherits aspect from the start frame — never send aspect_ratio.
  assert.equal(params.aspect_ratio, undefined);
});

test('buildModelParams drops camera_trajectory for models that do not support it', () => {
  const traj = buildStartEndTrajectory(
    { azimuth: 0, elevation: 0, distance: 1 },
    { azimuth: 90, elevation: 0, distance: 1 },
  );
  const params = buildModelParams('seedance-2-5-reference-to-video', { cameraTrajectory: traj });
  assert.equal(params.camera_trajectory, undefined);
});

test('buildModelParams throws on an invalid trajectory (fail fast before a paid queue)', () => {
  assert.throws(
    () => buildModelParams(MODEL, {
      cameraTrajectory: [{ time: 0, azimuth: 0, elevation: 0, distance: 1 }], // < 2 keyframes
    }),
    /Invalid camera_trajectory/,
  );
});

test('supportsCameraTrajectory is exclusive to the multi-angle model', () => {
  assert.equal(supportsCameraTrajectory(MODEL), true);
  assert.equal(supportsCameraTrajectory('minimax-h3-max-image-to-video'), false);
  assert.equal(supportsCameraTrajectory('unknown-model'), false);
});

test('buildOrbitTrajectory speed ramp keeps a full turn but eases the angular rate', () => {
  const linear = buildOrbitTrajectory({ azimuthTravel: 360, ramp: 'linear' });
  assert.equal(linear.length, 2); // linear defaults to a 2-keyframe start→finish

  const eased = buildOrbitTrajectory({ azimuthTravel: 360, ramp: 'ease-in', keyframes: 5 });
  assert.equal(eased.length, 5);
  assert.equal(Math.round(eased[eased.length - 1].azimuth), 360); // still a full turn
  // ease-in: slow start → by t=0.25 the camera has covered < a linear quarter (90°).
  assert.ok(eased[1].azimuth < 90, `expected eased quarter < 90°, got ${eased[1].azimuth}`);
  assert.ok(validateCameraTrajectory(eased).ok);
});

test('buildOrbitTrajectory supports a crane (elevation) + dolly (distance) across the turn', () => {
  const traj = buildOrbitTrajectory({
    azimuthTravel: 360, startElevation: 0, endElevation: 30, startDistance: 1.2, endDistance: 0.8, keyframes: 4,
  });
  assert.ok(traj[0].elevation === 0 && Math.round(traj[traj.length - 1].elevation) === 30);
  assert.ok(traj[0].distance > traj[traj.length - 1].distance); // dollies in
  assert.ok(validateCameraTrajectory(traj).ok);
});

test('validator enforces the 32-turn azimuth-travel ceiling', () => {
  const under = buildStartEndTrajectory(
    { azimuth: 0, elevation: 0, distance: 1 },
    { azimuth: CAMERA_MAX_AZIMUTH_TRAVEL_DEG, elevation: 0, distance: 1 },
  );
  assert.ok(validateCameraTrajectory(under).ok);
  const over = buildStartEndTrajectory(
    { azimuth: 0, elevation: 0, distance: 1 },
    { azimuth: CAMERA_MAX_AZIMUTH_TRAVEL_DEG + 361, elevation: 0, distance: 1 },
  );
  assert.equal(validateCameraTrajectory(over).ok, false);
});
