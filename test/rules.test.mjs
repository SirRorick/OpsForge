// Rule set schema and editing rules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MODES, fieldsFor, modeByType, defaultRuleSets, unknownKeys, setValue,
  parseFlags, joinFlags, overrideCount, DICT_FOR_KIND, INT, BOOL, ENUM, FLAGS,
} from '../src/rules.js';
import { parseMap, serializeMap } from '../src/format.js';

const EXAMPLES = new URL('../reference/Rules Examples_827c7495148f4388a383dd4aa463d414', import.meta.url);
const src = readFileSync(EXAMPLES, 'utf8');
const example = JSON.parse(src);

test('the schema covers exactly the keys the game wrote', () => {
  // The reference was exported with every setting changed away from its
  // default, so every key the mode accepts appears in it. Anything the schema
  // is missing would be uneditable; anything extra would be a key we invented.
  for (const rs of example.ruleSets) {
    const fields = fieldsFor(rs.type);
    assert.ok(fields.length, `no schema for mode ${rs.type}`);
    const declared = new Set(fields.map((f) => f.key));
    const actual = Object.values(DICT_FOR_KIND).flatMap((d) => Object.keys(rs[d] || {}));

    assert.deepEqual(
      actual.filter((k) => !declared.has(k)), [],
      `${rs.type}: keys in the file that the schema does not know`
    );
    assert.deepEqual(
      [...declared].filter((k) => !actual.includes(k)), [],
      `${rs.type}: keys in the schema that the file does not have`
    );
  }
});

test('every key is declared in the dictionary the game put it in', () => {
  for (const rs of example.ruleSets) {
    for (const f of fieldsFor(rs.type)) {
      assert.ok(f.key in rs[f.dict], `${rs.type}.${f.key} should live in ${f.dict}`);
    }
  }
});

test('the example map has no unrecognised keys', () => {
  for (const rs of example.ruleSets) {
    assert.deepEqual(unknownKeys(rs).map((u) => u.key), []);
  }
});

test('every field has a label and a known kind', () => {
  for (const mode of MODES) {
    for (const f of fieldsFor(mode.type)) {
      assert.ok(f.label, `${mode.type}.${f.key} has no label`);
      assert.ok([INT, BOOL, ENUM, FLAGS].includes(f.kind));
      assert.equal(f.dict, DICT_FOR_KIND[f.kind]);
    }
  }
});

test('a new map starts with all five modes and no overrides', () => {
  const sets = defaultRuleSets();
  assert.equal(sets.length, 5);
  assert.deepEqual(sets.map((r) => r.type), MODES.map((m) => m.type));
  for (const rs of sets) {
    assert.equal(overrideCount(rs), 0);
    for (const dict of Object.values(DICT_FOR_KIND)) assert.deepEqual(rs[dict], {});
  }
});

test('clearing a setting removes the key rather than writing a zero', () => {
  // An absent key means "use the game default". Writing 0 instead would be a
  // different, and usually broken, game.
  const rs = defaultRuleSets()[0];
  setValue(rs, 'GameDuration', INT, 300);
  assert.equal(rs.intValues.GameDuration, 300);
  assert.equal(overrideCount(rs), 1);

  setValue(rs, 'GameDuration', INT, undefined);
  assert.equal('GameDuration' in rs.intValues, false);
  assert.equal(overrideCount(rs), 0);

  setValue(rs, 'FriendlyFire', BOOL, false);
  assert.equal(rs.boolValues.FriendlyFire, false);
  assert.equal(overrideCount(rs), 1, 'false is a real value, not a cleared one');

  setValue(rs, 'BotDifficulty', ENUM, '');
  assert.equal('BotDifficulty' in rs.enumValues, false);
});

test('setValue rejects a kind it has no dictionary for', () => {
  assert.throws(() => setValue(defaultRuleSets()[0], 'X', 'colour', 1), /kind/);
});

test('flags are a semicolon-joined set', () => {
  assert.deepEqual(parseFlags('Spawners;Holsters'), ['Spawners', 'Holsters']);
  assert.deepEqual(parseFlags(''), []);
  assert.deepEqual(parseFlags(undefined), []);
  assert.equal(joinFlags(['Spawners', 'Holsters']), 'Spawners;Holsters');
  assert.equal(joinFlags(['Spawners', 'Spawners']), 'Spawners', 'a set, not a list');
  assert.equal(joinFlags([]), '');
});

test('an unknown mode keeps its values instead of losing them', () => {
  const rs = { type: 'SomeFutureMode', name: 'x', intValues: { Foo: 1 }, boolValues: {}, enumValues: { Bar: 'Baz' }, flagsValues: {} };
  assert.equal(modeByType('SomeFutureMode'), null);
  assert.deepEqual(fieldsFor('SomeFutureMode'), []);
  assert.deepEqual(unknownKeys(rs).map((u) => u.key).sort(), ['Bar', 'Foo']);
});

test('edited rule sets serialise the way the game writes them', () => {
  // Values are written bare: ints without a decimal point, bools as literals,
  // enums and flags as strings.
  const map = parseMap(src);
  const ffa = map.ruleSets[0];
  setValue(ffa, 'GameDuration', INT, 300);
  setValue(ffa, 'FriendlyFire', BOOL, false);
  setValue(ffa, 'BotDifficulty', ENUM, 'Easy');
  setValue(ffa, 'WeaponSource', FLAGS, joinFlags(['Spawners']));

  const out = serializeMap(map);
  assert.ok(out.includes('"GameDuration":300'), 'ints stay bare');
  assert.ok(out.includes('"FriendlyFire":false'));
  assert.ok(out.includes('"BotDifficulty":"Easy"'));
  assert.ok(out.includes('"WeaponSource":"Spawners"'));
  assert.ok(!out.includes('"GameDuration":300.0'), 'an int must not gain a decimal point');

  // And the whole thing still parses back to the same values.
  const back = parseMap(out).ruleSets[0];
  assert.equal(back.intValues.GameDuration, 300);
  assert.equal(back.boolValues.FriendlyFire, false);
});

test('rule sets with no overrides serialise as empty dictionaries', () => {
  const map = parseMap(src);
  map.ruleSets = defaultRuleSets();
  const out = serializeMap(map);
  assert.ok(out.includes('{"name":"Free For All","type":"FreeForAll","intValues":{},"boolValues":{},"enumValues":{},"flagsValues":{}}'));
});
