// ---------------------------------------------------------------------------
// Object catalog
// ---------------------------------------------------------------------------
// A pack is data, not code: see packs.js for the built-in ones and for what
// every field means. This module is only the registry and the lookups, so
// adding a pack means adding data and nothing else. Swap `model` in once real
// .glb assets are available and the placeholder is ignored.
//
// Most objects are identified by their `type` alone. A few library entries
// share a type and differ only by the extra fields the subtype writes —
// WeaponSpawnPoint carries `specificWeapon`, EnemySpawnPoint carries
// `behaviour` — so lookups take the whole map object, not just the type.
// ---------------------------------------------------------------------------

import { BUILTIN_PACKS } from './packs.js';

/**
 * Where the game asset dump lives, relative to the page.
 *
 * `model` and `icon` in a pack are bare asset names, not paths, because that is
 * what the dump calls them and tools/match-assets.mjs reports. Resolving them
 * here keeps the packs portable if the dump moves, and keeps the whole thing
 * optional: the dump is gitignored and absent for anyone who has not extracted
 * it, so both loaders below fall back rather than fail. That fallback is the
 * reason the single-file dist/ build still works with no assets at all.
 */
export const ASSET_BASE = 'reference/GameAssets/';

/** URL of an entry's prefab mesh, or null when it has none. */
export function modelUrl(def, base = ASSET_BASE) {
  return def?.model ? `${base}Prefabs/${def.model}.glb` : null;
}

/** URL of an entry's sliced library icon, or null when it has none. */
export function iconUrl(def, base = ASSET_BASE) {
  return def?.icon ? `${base}Icons/${def.icon}.png` : null;
}

const packs = new Map();
const byKey = new Map();
const byType = new Map();   // type -> defs sharing it, in registration order

export function registerPack(pack) {
  if (!pack || !pack.id || !Array.isArray(pack.objects)) {
    throw new Error('A pack needs an id and an objects array.');
  }
  packs.set(pack.id, pack);
  for (const raw of pack.objects) {
    const def = {
      objectType: 'MapObject',
      props: null,
      pivot: 'base',
      rotationAxes: 'y',
      floor: true,
      defaultScale: [1, 1, 1],
      icon: null,
      model: null,
      texture: null,
      opacity: 1,
      ...raw,
      key: raw.key || raw.type,
      pack: pack.id,
      group: pack.group || 'virtual',
    };
    byKey.set(def.key, def);
    if (!byType.has(def.type)) byType.set(def.type, []);
    byType.get(def.type).push(def);
  }
  return pack;
}

export function getPacks() {
  return [...packs.values()];
}

export function getPack(id) {
  return packs.get(id) || null;
}

/** Packs belonging to one top-level library section, in registration order. */
export function packsInGroup(group) {
  return [...packs.values()].filter((p) => (p.group || 'virtual') === group);
}

/** Look an entry up by its unique catalog key. */
export function getByKey(key) {
  return byKey.get(key) || null;
}

/**
 * First entry registered for a `type`. Enough for the types that have only one
 * entry; prefer `defFor` when a map object is in hand.
 */
export function getDef(type) {
  const list = byType.get(type);
  return list ? list[0] : null;
}

/**
 * Definition for a map object as it appears in a file. Where several entries
 * share a type, the one whose `props` all match wins — that is how a Handgun
 * spawner is told apart from a Sniper one. An unrecognised prop value still
 * resolves to the generic entry for that type, so the object stays editable
 * and its own value is preserved on export.
 */
export function defFor(mapObject) {
  const list = byType.get(mapObject.type);
  if (!list) return unknownDef(mapObject.type);
  if (list.length === 1) return list[0];
  const props = mapObject.props || {};
  const hit = list.find(
    (d) => d.props && Object.entries(d.props).every(([k, v]) => props[k] === v)
  );
  return hit || list[0];
}

/**
 * Definition for a type the catalog has never seen. Loading a map built on a
 * pack you do not have should still work, so unknown types get a clearly
 * marked stand-in rather than being dropped on the floor.
 */
export function unknownDef(type) {
  return {
    key: `unknown:${type}`,
    type,
    objectType: 'MapObject',
    props: null,
    label: type,
    category: 'Unrecognised',
    shape: 'unknown',
    size: [0.5, 0.5, 0.5],
    pivot: 'base',
    rotationAxes: 'xyz',
    floor: false,
    color: '#C0407A',
    defaultScale: [1, 1, 1],
    unknown: true,
    pack: 'unrecognised',
    group: 'virtual',
  };
}

export function defOrUnknown(type) {
  return getDef(type) || unknownDef(type);
}

/** Library entries of a pack, grouped by category, hidden ones left out. */
export function categoriesOf(pack) {
  const out = new Map();
  for (const def of pack.objects) {
    if (def.hidden) continue;
    if (!out.has(def.category)) out.set(def.category, []);
    out.get(def.category).push(byKey.get(def.key || def.type) || def);
  }
  return out;
}

for (const pack of BUILTIN_PACKS) registerPack(pack);

/** The pack the library opens on. */
export const DEFAULT_PACK = getPack('default');
