// Nav cloud codec and object catalog tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  decodeNavCloud, encodeNavCloud, buildNavMask, navIndexToWorld, NAV_SPACING,
} from '../src/format.js';
import { getPacks, getPack, getDef, getByKey, defOrUnknown, packsInGroup, categoriesOf } from '../src/catalog.js';
import { PACK_GROUPS } from '../src/packs.js';

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

const allDefs = getPacks().flatMap((p) => p.objects.map((d) => getByKey(d.key || d.type)));

test('every catalog entry has the fields the editor relies on', () => {
  for (const def of allDefs) {
    for (const key of ['type', 'key', 'label', 'category', 'shape', 'size', 'pivot', 'rotationAxes', 'color', 'defaultScale']) {
      assert.ok(def[key] !== undefined, `${def.key} is missing ${key}`);
    }
    assert.equal(def.size.length, 3, `${def.key} size must be [w, h, d]`);
    assert.ok(def.size.every((v) => v > 0), `${def.key} has a non-positive dimension`);
    assert.equal(def.defaultScale.length, 3);
    assert.ok(def.defaultScale.every((v) => v > 0), `${def.key} has a non-positive default scale`);
    assert.ok(['base', 'center'].includes(def.pivot));
    assert.ok(['y', 'xyz'].includes(def.rotationAxes));
    assert.match(def.color, /^#[0-9a-fA-F]{6}$/);
  }
});

test('the Default pack is measured, not estimated, and carries its icons', () => {
  // Its sizes come from the prefab GLBs and its icons from the sprite atlases,
  // so nothing in it should still be flagged as an estimate. The icon names are
  // slice-icons.mjs output names; the PNGs themselves live in the gitignored
  // asset dump, so only the wiring can be checked here.
  const def = getPack('default');
  assert.ok(def, 'the Default pack is missing');
  for (const raw of def.objects) {
    const entry = getByKey(raw.key || raw.type);
    assert.ok(!entry.uncertain, `${entry.key} is still marked uncertain`);
    assert.match(entry.icon ?? '', /^Icon_/, `${entry.key} has no icon`);
  }
});

test('catalog keys are unique', () => {
  const seen = new Set();
  for (const def of allDefs) {
    assert.ok(!seen.has(def.key), `duplicate catalog key ${def.key}`);
    seen.add(def.key);
  }
  assert.ok(seen.size > 170, `expected the full library, found ${seen.size}`);
});

test('entries sharing a type are told apart by their props', () => {
  // Ten weapon spawners share one `type`; without distinguishing props the
  // library would show ten identical entries and loading a map would pick the
  // wrong one for nine of them.
  const byType = new Map();
  for (const def of allDefs) {
    if (!byType.has(def.type)) byType.set(def.type, []);
    byType.get(def.type).push(def);
  }
  for (const [type, defs] of byType) {
    if (defs.length === 1) continue;
    for (const def of defs) {
      assert.ok(def.props, `${type} has ${defs.length} entries so each needs props`);
    }
    const seen = new Set(defs.map((d) => JSON.stringify(d.props)));
    assert.equal(seen.size, defs.length, `${type} has entries with identical props`);
  }
});

test('every pack belongs to a library section and every section has packs', () => {
  const ids = PACK_GROUPS.map((g) => g.id);
  for (const pack of getPacks()) {
    assert.ok(ids.includes(pack.group), `pack ${pack.id} has group "${pack.group}"`);
  }
  for (const id of ids) {
    assert.ok(packsInGroup(id).length, `library section ${id} has no packs`);
  }
});

test('the library hides the grounded primitives but still loads them', () => {
  // The VR editor needs them because there is no grid to snap to; here the
  // plain solid does the same job. Old maps must still open, though.
  const grounded = getDef('BoxSolidGrounded');
  assert.ok(grounded, 'BoxSolidGrounded must stay loadable');
  assert.equal(grounded.hidden, true);

  const shown = [...categoriesOf(getPacks().find((p) => p.id === 'default')).values()].flat();
  assert.ok(!shown.some((d) => /Grounded$/.test(d.type)), 'a grounded primitive is in the library');
  assert.ok(shown.some((d) => d.type === 'BoxSolid'), 'the plain solid box should be offered');
});

test('every shape names a builder that exists', () => {
  // placeholders.js imports three.js, so it cannot be loaded here. Reading the
  // builder names out of the source still catches the mistake that matters: a
  // typo in a `shape` silently turning an object into a pink unknown marker.
  const src = readFileSync(new URL('../src/placeholders.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('const builders = {'), src.indexOf('\n};', src.indexOf('const builders = {')));
  const builders = new Set([...block.matchAll(/^ {2}([A-Za-z]\w*):/gm)].map((m) => m[1]));
  assert.ok(builders.size > 50, `only found ${builders.size} builders, the parse is probably wrong`);
  for (const def of allDefs) {
    assert.ok(builders.has(def.shape), `${def.key} wants shape "${def.shape}", which has no builder`);
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
