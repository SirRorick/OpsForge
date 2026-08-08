// Map file format regression tests.
//
// The whole point of this suite: an exported map must be indistinguishable
// from one the game wrote itself. If any of these fail, exported maps are
// suspect even if the editor looks fine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseMap, serializeMap, f32, newGuid, isGuidN, mapFileName, newMap, MAP_VERSION,
} from '../src/format.js';

const FIXTURE = new URL('./fixtures/Default_f1d7dd74461f492aa897773d77451a78', import.meta.url);
const src = readFileSync(FIXTURE, 'utf8');

test('an untouched map re-exports byte for byte', () => {
  assert.equal(serializeMap(parseMap(src)), src);
});

test('re-serialising from parsed floats also matches byte for byte', () => {
  // Forces every object down the float-writing path instead of the raw
  // passthrough, so this is what a fully edited map would look like.
  const map = parseMap(src);
  map.mapObjects.forEach((o) => { o.dirty = true; });
  assert.equal(serializeMap(map), src);
});

test('editing one object leaves every other object untouched', () => {
  const map = parseMap(src);
  map.mapObjects[0].position.x = 1.5;
  map.mapObjects[0].dirty = true;
  const out = serializeMap(map);

  for (const o of parseMap(src).mapObjects.slice(1)) {
    assert.ok(out.includes(o.raw), `original bytes lost for ${o.type}`);
  }
  assert.ok(out.includes('"x":1.5'));
});

test('float writer reproduces every literal in the fixture', () => {
  const literals = [...new Set([...src.matchAll(/:(-?\d+\.\d+)/g)].map((m) => m[1]))];
  assert.ok(literals.length >= 60, 'fixture should contain plenty of floats');
  for (const lit of literals) {
    assert.equal(f32(parseFloat(lit)), lit);
  }
});

test('float writer round-trips arbitrary float32 values', () => {
  for (let i = 0; i < 50000; i++) {
    const v = Math.fround((Math.random() - 0.5) * 10 ** (Math.floor(Math.random() * 6) - 2));
    assert.equal(Math.fround(parseFloat(f32(v))), v);
  }
});

test('integral floats keep their decimal point, ints do not gain one', () => {
  assert.equal(f32(1), '1.0');
  assert.equal(f32(0), '0.0');
  assert.equal(f32(-0), '0.0');
  assert.equal(f32(2.5), '2.5');
  // mapBoundsSize is an int vector and must stay bare.
  assert.match(serializeMap(parseMap(src)), /"mapBoundsSize":\{"x":7,"y":3,"z":7\}/);
});

test('generated ids are RFC 4122 v4 in .NET "N" format', () => {
  for (let i = 0; i < 500; i++) {
    const g = newGuid();
    assert.ok(isGuidN(g), `${g} is not 32 lowercase hex`);
    assert.equal(g[12], '4', 'version nibble');
    assert.ok('89ab'.includes(g[16]), 'variant nibble');
  }
});

test('file name is name_guid with no extension', () => {
  const map = parseMap(src);
  assert.equal(mapFileName(map.name, map.guid), 'Default_f1d7dd74461f492aa897773d77451a78');
  assert.ok(!mapFileName('My/Map: v2?', map.guid).match(/[\\/:*?"<>|]/));
});

test('a new map serialises and reparses', async () => {
  const fresh = await newMap({ name: 'Test Arena', author: 'me' });
  const text = serializeMap(fresh);
  const back = parseMap(text);
  assert.equal(back.name, 'Test Arena');
  assert.equal(back.version, MAP_VERSION);
  assert.equal(back.ruleSets.length, 5);
  assert.deepEqual(back.mapBoundsSize, { x: 7, y: 3, z: 7 });
});

test('parsing rejects things that are not map files', () => {
  assert.throws(() => parseMap('{"hello":1}'), /mapObjects/);
});
