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
 * Where the editor's art lives, relative to the page.
 *
 * `model` and `icon` in a pack are bare asset names, not paths, because that is
 * what the assets call them and tools/match-assets.mjs reports. Resolving them
 * here keeps the packs portable, and keeps the whole thing optional: both
 * loaders below fall back rather than fail.
 *
 * That fallback is the entire difference between the two builds. There is one
 * editor and one `assets/` folder, and what is sitting in it decides what you
 * see — `assets/Icons` is committed, `assets/Prefabs` is gitignored, so a fresh
 * clone has thumbnails and stand-in shapes, and a machine that has run
 * `npm run stage-assets` has the game's own models as well. No forks, no build
 * flags, nothing conditional in the code.
 */
export const ASSET_BASE = 'assets/';

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
      // Which local axis the piece has a front on, when its silhouette does not
      // say so, and which side it belongs to. Both are read by mirroring; see
      // the field notes at the top of packs.js.
      facing: null,
      team: null,
      teamFamily: null,
      // Where the object's origin sits in its own footprint, as a fraction of
      // the width and depth. Centred unless the pack says otherwise — see
      // geometryFor, and the corner barriers that need it.
      anchor: [0.5, 0.5],
      // A themed pack paints everything in it one colour, so the colour lives
      // on the pack. An entry may still carry its own and win: Gameplay Objects
      // and Mode Objectives do exactly that, because a red explosive barrel and
      // a team-blue spawn zone are telling you something the pack cannot.
      color: pack.color,
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

/**
 * Two shapes name the same kind of piece.
 *
 * Shape ids are `family` plus an optional variant in TitleCase —
 * `wall`, `wallPlank`, `wallLayered` are all walls, and
 * `barrierFull`, `barrierFullSlab` are all full-height barriers. The remainder
 * has to start with a capital, which is what keeps `barrierD` from swallowing
 * `barrierDoor`.
 *
 * Note this deliberately relates a family to its variants and **not** two
 * variants to each other: `barrierFull` and `barrierLow` are both barriers and
 * are not interchangeable, so a pack with no low barrier has none rather than
 * being given a full one.
 *
 * `Boundary` is the one variant that breaks that rule, because it is the only
 * one that is not a different *shape*. An invisible wall is the family's own
 * piece with the art taken off — the game's `Wall` and `WallSolid` are the same
 * geometry — so it is stripped before the comparison and `wallBoundary` reaches
 * `wallLayered`. Without that, swapping an arena to Camo, Mykea or Wild West
 * left every boundary wall behind, because those three themes' walls are
 * variants rather than the plain `wall`.
 */
const BOUNDARY_VARIANT = /Boundary$/;

export function sameShapeFamily(a, b) {
  if (a === b) return true;
  const x = a.replace(BOUNDARY_VARIANT, '');
  const y = b.replace(BOUNDARY_VARIANT, '');
  if (x === y) return true;
  const [shortest, longest] = x.length < y.length ? [x, y] : [y, x];
  return longest.startsWith(shortest) && /^[A-Z]/.test(longest.slice(shortest.length));
}

/**
 * The entry in `packId` that stands for the same piece as `def` — Camo's
 * barrier corner for the Default one — or null when that pack has no
 * equivalent. Used by mirroring, which can build the far half of a map out of
 * a different theme.
 */
export function equivalentIn(def, packId) {
  const pack = packs.get(packId);
  if (!def || !pack) return null;
  if (def.pack === packId) return def;
  const candidates = pack.objects
    .map((raw) => byKey.get(raw.key || raw.type))
    .filter((d) => d && sameShapeFamily(d.shape, def.shape));
  if (!candidates.length) return null;
  // An exact shape match beats a family match, and a visible entry beats a
  // hidden one — otherwise a Solid Box could mirror into its Grounded twin,
  // which is the same mesh with different rotation limits.
  return candidates.find((d) => d.shape === def.shape && !d.hidden)
    ?? candidates.find((d) => !d.hidden)
    ?? candidates[0];
}

/** Library entries of a pack, grouped by category, hidden ones left out. */
/**
 * The entries that are the same piece as `def` in another team's colours, in
 * catalog order, or an empty list for a piece that has no such family.
 *
 * A team is not a theme, and this is not `equivalentIn` with a different
 * argument. The themed packs are eleven ways of building the same wall; a team
 * family is two or three objects the game treats as *different kinds of thing*
 * — a blue spawn zone and an orange one are separate types with separate
 * meanings, and no themed pack holds either. Mirroring an arena's blue half
 * into its orange half needs this second axis, and the theme picker is no use
 * for it.
 */
export function teamVariants(def) {
  if (!def?.teamFamily) return [];
  return [...byKey.values()].filter((d) => d.teamFamily === def.teamFamily);
}

/** The family entry for one team — `teamVariants` narrowed to a single side. */
export function teamVariant(def, team) {
  return teamVariants(def).find((d) => d.team === team) || null;
}

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
