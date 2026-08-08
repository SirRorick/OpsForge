// Coordinate conversion tests.
//
// Unity is left-handed, three.js is right-handed. Get this wrong and the whole
// map mirrors, which is only obvious on asymmetric pieces like BarrierCorner.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  convertPosition, unityEulerToQuat, quatToUnityEuler, wrap360,
} from '../src/unity.js';

const FIXTURE = new URL('./fixtures/Default_f1d7dd74461f492aa897773d77451a78', import.meta.url);
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));

/** 1 - |dot| between two quaternions; 0 means identical orientation. */
function orientationError(a, b) {
  return 1 - Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
}

test('position conversion is its own inverse', () => {
  const [x, y, z] = convertPosition({ x: 1, y: 2, z: 3 });
  assert.deepEqual([x, y, z], [1, 2, -3]);
  assert.deepEqual(convertPosition({ x, y, z }), [1, 2, 3]);
});

test('every rotation in the fixture survives the round trip', () => {
  for (const o of fixture.mapObjects) {
    const q = unityEulerToQuat(o.rotation);
    const q2 = unityEulerToQuat(quatToUnityEuler(q));
    assert.ok(orientationError(q, q2) < 1e-9, `drift on ${o.type}`);
  }
});

test('rotations survive the round trip including gimbal lock', () => {
  for (let i = 0; i < 50000; i++) {
    const r = { x: Math.random() * 360, y: Math.random() * 360, z: Math.random() * 360 };
    // Drive x straight into the YXZ singularity on a slice of the runs.
    if (i % 7 === 0) r.x = 90;
    if (i % 11 === 0) r.x = 270;
    const q = unityEulerToQuat(r);
    const q2 = unityEulerToQuat(quatToUnityEuler(q));
    assert.ok(orientationError(q, q2) < 1e-6, `drift at ${JSON.stringify(r)}`);
  }
});

test('a Unity yaw becomes a right-handed rotation about -Y', () => {
  // If this flips sign, the map is mirrored.
  const q = unityEulerToQuat({ x: 0, y: 90, z: 0 });
  assert.ok(Math.abs(q[1] - -Math.SQRT1_2) < 1e-6, 'yaw should map to -Y');
  assert.ok(Math.abs(q[3] - Math.SQRT1_2) < 1e-6);
});

test('exported euler angles are normalised to [0, 360)', () => {
  for (const deg of [-1, -0.0000001, 360, 359.9999999, 720, -450]) {
    const w = wrap360(deg);
    assert.ok(w >= 0 && w < 360, `${deg} -> ${w}`);
  }
  assert.equal(wrap360(-90), 270);
  assert.equal(wrap360(0), 0);
});

test('a full Unity -> three -> Unity pass over the fixture has no drift', () => {
  for (const o of fixture.mapObjects) {
    const [x, y, z] = convertPosition(o.position);
    const back = convertPosition({ x, y, z });
    assert.deepEqual(back, [o.position.x, o.position.y, o.position.z]);

    const r = quatToUnityEuler(unityEulerToQuat(o.rotation));
    for (const axis of ['x', 'y', 'z']) {
      const d = Math.abs(r[axis] - o.rotation[axis]);
      assert.ok(Math.min(d, 360 - d) < 1e-4, `${o.type}.rotation.${axis}`);
    }
  }
});
