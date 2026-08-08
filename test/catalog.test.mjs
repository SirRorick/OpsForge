// Nav cloud codec and object catalog tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  decodeNavCloud, encodeNavCloud, buildNavMask, navIndexToWorld, NAV_SPACING,
} from '../src/format.js';
import { DEFAULT_PACK, getDef, defOrUnknown } from '../src/catalog.js';

const FIXTURE = new URL('./fixtures/Default_f1d7dd74461f492aa897773d77451a78', import.meta.url);
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));

// -- nav cloud --------------------------------------------------------------

test('the fixture nav cloud decodes to one byte per grid point', async () => {
  const { divisions } = fixture.navCloud;
  const bytes = await decodeNavCloud(fixture.navCloud.encodedPoints);
  assert.equal(bytes.length, divisions.x * divisions.y);
  assert.ok(bytes.every((b) => b === 0 || b === 1), 'mask should be strictly 0/1');
  assert.equal(bytes.reduce((a, b) => a + b, 0), 1281);
});

test('grid spacing matches the declared size', () => {
  const { size, divisions } = fixture.navCloud;
  assert.equal(size.x / (divisions.x - 1), NAV_SPACING);
  assert.equal(navIndexToWorld((divisions.x - 1) / 2, divisions.x), 0, 'centre point sits on origin');
});

test('the fixture play space is a disc centred on the origin', async () => {
  const bytes = await decodeNavCloud(fixture.navCloud.encodedPoints);
  const n = fixture.navCloud.divisions.x;
  let maxInside = 0;
  let minOutside = Infinity;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const d = Math.hypot(navIndexToWorld(c, n), navIndexToWorld(r, n));
      if (bytes[r * n + c]) maxInside = Math.max(maxInside, d);
      else minOutside = Math.min(minOutside, d);
    }
  }
  // Real guardian capture, so the radius is not a round number.
  assert.ok(maxInside < minOutside, 'inside and outside cells should not interleave');
  assert.ok(maxInside > 5 && maxInside < 5.1, `unexpected radius ${maxInside}`);
});

test('nav cloud encode and decode round trip', async () => {
  const bytes = await decodeNavCloud(fixture.navCloud.encodedPoints);
  const back = await decodeNavCloud(await encodeNavCloud(bytes));
  assert.deepEqual([...back], [...bytes]);
});

test('generated masks have the requested shape', () => {
  const n = 141;
  const circle = buildNavMask({ shape: 'circle', radius: 5, divisions: n });
  const rect = buildNavMask({ shape: 'rect', width: 7, depth: 7, divisions: n });
  assert.equal(circle.length, n * n);

  const centre = ((n - 1) / 2) * n + (n - 1) / 2;
  assert.equal(circle[centre], 1, 'origin should be inside');
  assert.equal(rect[centre], 1);
  assert.equal(circle[0], 0, 'far corner should be outside');
  // A 7x7 square has more area than a disc that fits inside it.
  assert.ok(rect.reduce((a, b) => a + b, 0) < circle.reduce((a, b) => a + b, 0));
});

// -- catalog ----------------------------------------------------------------

test('the Default pack covers every type in the fixture', () => {
  for (const o of fixture.mapObjects) {
    assert.ok(getDef(o.type), `${o.type} is missing from the Default pack`);
  }
});

test('every catalog entry has the fields the editor relies on', () => {
  for (const def of DEFAULT_PACK.objects) {
    for (const key of ['type', 'label', 'category', 'shape', 'size', 'pivot', 'rotationAxes', 'color']) {
      assert.ok(def[key] !== undefined, `${def.type} is missing ${key}`);
    }
    assert.equal(def.size.length, 3, `${def.type} size must be [w, h, d]`);
    assert.ok(def.size.every((v) => v > 0), `${def.type} has a non-positive dimension`);
    assert.ok(['base', 'center'].includes(def.pivot));
    assert.ok(['y', 'xyz'].includes(def.rotationAxes));
    assert.match(def.color, /^#[0-9a-fA-F]{6}$/);
  }
});

test('catalog pivots put every grounded fixture object exactly on the floor', () => {
  // This is the check that originally confirmed the pivot model. The only
  // object allowed off the floor is the one with free X/Z rotation, which was
  // deliberately placed in mid-air.
  for (const o of fixture.mapObjects) {
    const def = getDef(o.type);
    const height = def.size[1] * o.scale.y;
    const baseY = def.pivot === 'center' ? o.position.y - height / 2 : o.position.y;
    const airborne = o.rotation.x !== 0 || o.rotation.z !== 0;
    if (!airborne) {
      assert.ok(Math.abs(baseY) < 1e-4, `${o.type} floats at y = ${baseY}`);
    }
  }
});

test('unknown types get a stand-in rather than throwing', () => {
  const def = defOrUnknown('SomeFuturePackObject');
  assert.equal(def.type, 'SomeFuturePackObject');
  assert.ok(def.unknown);
  assert.equal(def.shape, 'unknown');
});
