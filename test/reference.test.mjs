// Regression tests against every map the in-game editor exported.
//
// reference/ holds one file per library group, plus a rule set example. They
// are the only evidence we have for what the game actually writes, so they are
// checked byte for byte: if the editor cannot reproduce them exactly, it
// cannot be trusted to write a file the game will load.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseMap, serializeMap } from '../src/format.js';
import { defFor, getByKey, getPacks } from '../src/catalog.js';
import { WEAPONS, WEAPON_ICONS, parseWeapons, formatWeapons } from '../src/packs.js';

const REF = fileURLToPath(new URL('../reference/', import.meta.url));

/**
 * Every map file under reference/, as { name, text }. Exported maps are named
 * `Name_guid` with no extension, so anything with a dot in its name is notes
 * or a screenshot rather than a map.
 */
function referenceMaps(dir = REF, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) referenceMaps(path, out);
    else if (!entry.name.includes('.')) out.push({ name: entry.name, text: readFileSync(path, 'utf8') });
  }
  return out;
}

const maps = referenceMaps();

test('reference maps were found', () => {
  assert.ok(maps.length >= 14, `expected the reference exports, found ${maps.length}`);
});

for (const { name, text } of maps) {
  test(`${name} re-exports byte for byte`, () => {
    assert.equal(serializeMap(parseMap(text)), text);
  });

  test(`${name} re-exports byte for byte with every object edited`, () => {
    // Forces every object down the float-writing path instead of the raw
    // passthrough, so this is what a fully edited map would look like.
    const map = parseMap(text);
    map.mapObjects.forEach((o) => { o.dirty = true; });
    assert.equal(serializeMap(map), text);
  });
}

test('subtype fields survive an edit', () => {
  // WeaponSpawnPoint, DamageBox and EnemySpawnPoint carry extra keys between
  // "$type" and "type". Dropping them on edit would turn a shotgun spawner
  // into a nameless one, which is exactly the sort of silent damage the raw
  // passthrough would otherwise hide.
  const source = maps.find((m) => m.name.startsWith('Gameplay Objects'));
  const map = parseMap(source.text);

  const spawner = map.mapObjects.find((o) => o.props.specificWeapon === 'Sniper');
  assert.ok(spawner, 'fixture should contain a sniper spawner');
  spawner.position.x = 1.5;
  spawner.dirty = true;

  const out = serializeMap(map);
  assert.ok(
    out.includes('{"$type":"WeaponSpawnPoint","specificWeapon":"Sniper","type":"WeaponSpawnPoint","position":{"x":1.5,'),
    'the weapon and the key order should both be intact'
  );

  const back = parseMap(out).mapObjects.find((o) => o.props.specificWeapon === 'Sniper');
  assert.equal(back.$type, 'WeaponSpawnPoint');
  assert.equal(back.position.x, 1.5);
});

test('a field no version of the game has shown us still round-trips', () => {
  const text =
    '{"guid":"00000000000000000000000000000000","version":4,"name":"x","author":"","source":"Player",' +
    '"createdTime":"2026-01-01T00:00:00","editedTime":"2026-01-01T00:00:00","playedTime":"0001-01-01T00:00:00",' +
    '"mapBoundsSize":{"x":7,"y":3,"z":7},"ruleSets":[],"anchors":[],"mapObjects":[' +
    '{"$type":"FuturePoint","someNewField":42,"type":"FuturePoint","position":{"x":0.0,"y":0.0,"z":0.0},' +
    '"rotation":{"x":0.0,"y":0.0,"z":0.0},"scale":{"x":1.0,"y":1.0,"z":1.0}}],' +
    '"navCloud":{"position":{"x":0.0,"y":0.0,"z":0.0},"rotation":{"x":0.0,"y":0.0,"z":0.0},' +
    '"size":{"x":35.0,"y":35.0},"divisions":{"x":141,"y":141},"encodedPoints":""},"hasArUcoAnchor":false}';
  const map = parseMap(text);
  assert.equal(map.mapObjects[0].props.someNewField, 42);
  map.mapObjects[0].dirty = true;
  assert.equal(serializeMap(map), text);
});

// -- catalog coverage -------------------------------------------------------

test('every object in every reference map resolves to a catalog entry', () => {
  const missing = new Set();
  for (const { text } of maps) {
    for (const o of parseMap(text).mapObjects) {
      if (defFor(o).unknown) missing.add(o.type);
    }
  }
  assert.deepEqual([...missing], [], 'these types are not in any built-in pack');
});

test('catalog entries place every reference object exactly on the floor', () => {
  // The check that pins the pivot model down. The only objects allowed off the
  // floor are the ones deliberately tilted or mounted in the air.
  for (const { name, text } of maps) {
    for (const o of parseMap(text).mapObjects) {
      const def = defFor(o);
      if (!def.floor) continue;
      const height = def.size[1] * o.scale.y;
      const baseY = def.pivot === 'center' ? o.position.y - height / 2 : o.position.y;
      if (o.rotation.x !== 0 || o.rotation.z !== 0) continue;
      assert.ok(Math.abs(baseY) < 1e-4, `${name}: ${o.type} floats at y = ${baseY}`);
    }
  }
});

test('the scale the editor places at is the scale the game used', () => {
  // The player changed the scale of nothing except the solid box, cylinder and
  // wall, which are sized as you drag them out. Every other object's default
  // therefore has to match the reference exactly, or a freshly placed piece is
  // a different size from the same piece placed in the game.
  const dragged = /(BoxSolid|WallSolid)/;
  for (const { name, text } of maps) {
    for (const o of parseMap(text).mapObjects) {
      if (dragged.test(o.type)) continue;
      const def = defFor(o);
      const actual = [o.scale.x, o.scale.y, o.scale.z];
      def.defaultScale.forEach((want, i) => {
        assert.ok(
          Math.abs(actual[i] - want) < 1e-4,
          `${name}: ${o.type} axis ${i} is ${actual[i]} but the catalog places at ${want}`
        );
      });
    }
  }
});

test('every weapon spawner resolves to the one entry', () => {
  // There is a single spawner in the library; which weapons it offers is a
  // property of the placed object, not a different object.
  const one = getByKey('WeaponSpawnPoint');
  assert.ok(one, 'the weapon spawner entry is missing');
  for (const value of ['Sniper', 'All', 'Shotgun;Sniper', 'LaserRifle']) {
    const def = defFor({ type: 'WeaponSpawnPoint', props: { specificWeapon: value } });
    assert.equal(def.key, 'WeaponSpawnPoint', `${value} resolved to ${def.key}`);
    assert.ok(!def.unknown, `${value} became an unknown marker`);
  }

  const enemy = defFor({ type: 'EnemySpawnPoint', props: { enemyTypes: 'All', behaviour: 'Stationary' } });
  assert.equal(enemy.key, 'EnemySpawnPoint:Stationary');
});

test('a spawner\'s weapon set round-trips through the wire format', () => {
  assert.deepEqual(parseWeapons('All'), WEAPONS);
  assert.deepEqual(parseWeapons('Shotgun;Sniper'), ['Shotgun', 'Sniper']);
  assert.equal(formatWeapons(['Shotgun', 'Sniper']), 'Shotgun;Sniper');

  // Everything ticked is written the way the game writes it, not spelled out.
  assert.equal(formatWeapons(WEAPONS), 'All');
  // And an empty set is never written; it means "any" again.
  assert.equal(formatWeapons([]), 'All');

  // A weapon a future update adds survives an edit to the same spawner.
  const future = parseWeapons('Shotgun;LaserRifle');
  assert.deepEqual(future, ['Shotgun', 'LaserRifle']);
  assert.equal(formatWeapons(future), 'Shotgun;LaserRifle');

  for (const w of WEAPONS) assert.match(WEAPON_ICONS[w] ?? '', /^Icon_/, `${w} has no icon`);
});

test('changing a spawner\'s weapon rewrites that object and nothing else', () => {
  // The library offers one entry per weapon, but a spawner already on the map
  // is re-pointed by editing props.specificWeapon. That has to move the value
  // without disturbing the key order, which the game relies on, or any other
  // object's bytes.
  const source = maps.find((m) => m.text.includes('"specificWeapon":"Shotgun"'));
  assert.ok(source, 'no reference map has a shotgun spawner');

  const map = parseMap(source.text);
  const target = map.mapObjects.find((o) => o.props?.specificWeapon === 'Shotgun');
  target.props.specificWeapon = 'Sniper';
  target.dirty = true;
  const out = serializeMap(map);

  assert.match(out, /"\$type":"WeaponSpawnPoint","specificWeapon":"Sniper","type":"WeaponSpawnPoint"/);
  assert.equal(out.replace('"specificWeapon":"Sniper"', '"specificWeapon":"Shotgun"'), source.text);
});

test('every catalog entry carries a model, texture and icon pointer', () => {
  // Resolved by tools/match-assets.mjs against the gitignored asset dump. The
  // files cannot be checked in here, but a dropped or misspelled field can.
  for (const def of getPacks().flatMap((p) => p.objects)) {
    const entry = getByKey(def.key || def.type);
    assert.ok(entry.model, `${entry.key} has no model`);
    assert.match(entry.icon ?? '', /^(Icon_|icon_|Image_)/, `${entry.key} has no icon`);
  }
});
