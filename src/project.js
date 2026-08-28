// ---------------------------------------------------------------------------
// project.js — one design, many venues
// ---------------------------------------------------------------------------
// A map built for a location-based venue is played in more than one room, and
// the rooms are not the same room. Hall 1 and hall 2 have different walls,
// different guardian boundaries and different spatial anchors, so the game
// needs a separate file for each — and the way that is done today is to save
// the map, drag the whole thing into place for a hall, save it again under
// another name, and repeat until there are ten of them. After which changing
// one crate means doing it ten times, or doing it once and re-positioning the
// other nine from scratch.
//
// The way out is to stop moving the map. A project is **one design plus a
// placement per venue**, and the ten files are generated rather than kept:
//
//   project = {
//     primary,          the design, and the one map that exports as itself
//     layers: [ ... ],  one per venue
//   }
//
//   layer = {
//     id,               editor-side, stable for the life of the project
//     name,             the exported map's name, and so half its file name
//     guid,             minted once when the template arrived, and kept
//     template,         the venue map: walls for reference, spatial data for real
//     offset, yaw,      where the design sits in this hall
//     placed,           whether anyone has aligned it yet
//     detached: [],     ids of primary objects this layer has stopped inheriting
//     objects: [],      this layer's own — the forks of those, and anything added
//   }
//
// Nothing here copies the design. A layer holds a *transform*, so an object
// added to the primary appears in all ten because there was never a second
// copy of it to update. That is the whole feature, and every other rule below
// exists to keep it true.
//
// **Detaching is a fork, not an override.** Take an object out of the group in
// one hall and it stops being that object: it moves into `layer.objects`, its
// id goes into `detached`, and from then on it is edited, resized and deleted
// on its own. Deleting the original from the primary leaves it standing. That
// is deliberate — a half-inherited object would need a merge rule for every
// field, and the venue that needed a pillar worked around does not want one.
// It is also the one place drift can get back in, which is why it takes a
// deliberate act to start it.
//
// What a fork does keep is the *frame*. Its position is stored in the design's
// coordinates like everything else, and the hall's placement is applied to it
// on the way out — so nudging an alignment moves the whole of what that hall
// plays rather than sliding the design out from under the pieces put where
// they are to work around a pillar. Shared frame, separate objects.
//
// **What comes from where.** The design's half is the primary's: objects,
// rules, author, and the arena box. The room's half is the template's: the
// nav cloud, the anchors, and `hasArUcoAnchor`, which belongs with them. The
// name and the guid are the layer's own.
//
// `mapBoundsSize` is inherited from the primary and not recomputed. The box is
// always centred on the world origin and the format has no offset to give it
// instead, so an aligned map standing off to one side of a hall would need an
// enormous one to be contained — and the game does not ask for that. Both
// headset-made maps in `test/fixtures/maps` already carry objects outside the
// arena their own file claims, and both play.
//
// Everything in this module works in **Unity values**, exactly as they sit in
// the file. No three.js, no viewport: the fan-out is arithmetic on numbers the
// game wrote, and it is tested as such.
// ---------------------------------------------------------------------------

import { DEG, wrap360 } from './unity.js';

export const PROJECT_FORMAT = 'opsforge.project';
export const PROJECT_VERSION = 1;
export const PROJECT_EXT = 'opsproject';

/** Project name -> file name. Same shape as `mapFileName`, different extension. */
export function projectFileName(name) {
  const safe = String(name || 'Project').replace(/[\\/:*?"<>|]/g, '').trim() || 'Project';
  return `${safe}.${PROJECT_EXT}`;
}

// -- Naming the files a venue writes ----------------------------------------
// The name is the map name the game lists *and* the first half of the file
// name, so it is the only thing telling twenty otherwise identical maps apart
// on a headset. Both of these are shared by the import dialog, which suggests
// the names, and the export dialog, which is the last chance to change them.

/**
 * The name suggested for a venue's map: the design, then the hall in brackets.
 *
 * Matches the convention these files were already being named by hand --
 * `ARENA-01_[VEN1_HALL1]` -- so a template called `VEN1_HALL1` in the headset
 * comes back with its map already named. It is a suggestion and nothing more:
 * anything typed over it is kept.
 */
export function venueMapName(designName, templateName) {
  return `${designName}_[${templateName}]`;
}

/**
 * The first name in `names` that some earlier one already used, or null.
 *
 * Two maps of one name are two files of one name, and the second overwrites
 * the first on the way to a headset -- silently, and after the point where
 * anyone would still be watching. Cheaper to refuse the export.
 */
export function duplicateName(names) {
  const seen = new Set();
  for (const n of names) {
    if (seen.has(n)) return n;
    seen.add(n);
  }
  return null;
}

// -- Object identity --------------------------------------------------------
// A layer names the primary objects it has stopped inheriting, and it has to
// still mean the same objects tomorrow. Position in `mapObjects` will not do:
// the checkpoint sidecar gets away with indices because it snapshots the whole
// map in one go, but a project outlives the editing that reorders it, and
// deleting one object would silently re-point every detachment after it.
//
// So the project stamps an id on each object and carries it. It is editor-side
// only — `serializeMap` builds an object out of `$type`, `props`, `type` and
// the three vectors, so a field beside those never reaches the file, and
// `docs/FORMAT.md` is explicit that a builder must not write keys the game
// never wrote.
//
// One namespace, shared with the ids the viewport puts on meshes, so an object
// keeps the same id whether it arrived from a file or was placed by hand.
// `identifyObjects` adopts before it mints — every id already in the set is
// taken out of circulation first — which is what makes it safe to run over a
// project that came back off disk carrying ids of its own. A load then seeds
// the viewport's counter from `nextObjectId()`, and neither side can hand out
// a number the other is already using.

let objectSeq = 1;
let layerSeq = 1;

/** The next id that will be minted. A load seeds the viewport's counter with it. */
export function nextObjectId() {
  return objectSeq;
}

/** Adopt the ids already in `objects`, then stamp the ones without. */
export function identifyObjects(objects) {
  for (const o of objects) {
    if (Number.isInteger(o.id) && o.id >= objectSeq) objectSeq = o.id + 1;
  }
  for (const o of objects) {
    if (!Number.isInteger(o.id)) o.id = objectSeq++;
  }
  return objects;
}

// -- The model --------------------------------------------------------------

export function newProject(primary, layers = []) {
  identifyObjects(primary.mapObjects || []);
  return { primary, layers };
}

export function newLayer({ name, guid, template }) {
  return {
    id: `l${layerSeq++}`,
    name,
    guid,
    template,
    offset: { x: 0, y: 0, z: 0 },
    yaw: 0,
    // Nothing has been aligned yet, which is what draws the design ghosted the
    // first time a layer is opened.
    placed: false,
    detached: [],
    objects: [],
  };
}

// -- The rigid transform ----------------------------------------------------

/**
 * Move one object out of the design's space and into a hall's.
 *
 * Rotate about the origin by `yaw`, then translate by `offset` — which is a
 * complete description of any yaw-and-shift however the alignment was actually
 * dragged, because whatever pivot the pointer used is absorbed into `offset`.
 *
 * Unity turns about Y with
 *
 *   x' =  x cos + z sin
 *   z' = -x sin + z cos
 *
 * and the object's own rotation needs nothing more than an addition on Y. That
 * is not an approximation. Unity composes euler angles as Ry*Rx*Rz (see the
 * note at the top of `unity.js`), and a world-side yaw multiplies on the left,
 * so Ry(t)*Ry(y)*Rx*Rz is Ry(t+y)*Rx*Rz exactly. Pitch and roll come through
 * untouched, which is what keeps a sign angled down at a player angled down at
 * a player in every hall.
 *
 * Only yaw, never pitch or roll: a hall can be turned relative to another, and
 * a hall cannot be tilted. `navCloud` has never carried a tilted floor mask.
 *
 * An identity transform hands the object straight back. That keeps `raw` and
 * `dirty` as they were, so an untouched object in an unaligned layer still
 * re-exports byte for byte instead of being rebuilt from its own numbers.
 */
export function alignMapObject(mo, offset, yaw) {
  const t = wrap360(yaw);
  if (t === 0 && !offset.x && !offset.y && !offset.z) return mo;

  const rad = t * DEG;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const { x, y, z } = mo.position;
  return {
    ...mo,
    position: {
      x: x * cos + z * sin + offset.x,
      y: y + offset.y,
      z: -x * sin + z * cos + offset.z,
    },
    rotation: { ...mo.rotation, y: wrap360(mo.rotation.y + t) },
    // It has moved, so the bytes it arrived as no longer describe it.
    raw: null,
    dirty: true,
  };
}

// -- The fan-out ------------------------------------------------------------

/**
 * What one layer's file holds: the design it still inherits, then its own.
 *
 * Both halves are placed by the same transform, because both are stored in the
 * design's frame and the placement is the hall's answer to where that frame
 * sits. So nudging an alignment moves the whole of what will be played in that
 * hall, forks and additions included, rather than sliding the design out from
 * under the pieces that were put where they are to work around a pillar.
 *
 * It is the frame they share, not an inheritance. A layer's own object is its
 * own: editing, resizing or deleting the design's copy does nothing to it, and
 * no other hall has ever heard of it.
 */
export function layerMapObjects(project, layer) {
  const gone = new Set(layer.detached || []);
  const place = (o) => alignMapObject(o, layer.offset, layer.yaw);
  return [
    ...(project.primary.mapObjects || []).filter((o) => !gone.has(o.id)).map(place),
    ...(layer.objects || []).map(place),
  ];
}

/** One layer as a map the game would read. */
export function buildVariant(project, layer) {
  const p = project.primary;
  const t = layer.template;
  return {
    guid: layer.guid,
    version: p.version,
    name: layer.name,
    author: p.author,
    source: p.source,
    createdTime: p.createdTime,
    editedTime: p.editedTime,
    playedTime: p.playedTime,
    mapBoundsSize: { ...p.mapBoundsSize },
    ruleSets: p.ruleSets,
    // The room's half.
    anchors: t.anchors,
    mapObjects: layerMapObjects(project, layer),
    navCloud: t.navCloud,
    hasArUcoAnchor: t.hasArUcoAnchor,
  };
}

/**
 * Every file an export writes: the primary as itself, then one per layer.
 *
 * The primary comes first and comes through untouched — it is the map that was
 * edited, and it is nobody's variant. A project with no layers is therefore
 * exactly today's single map export, which is the shape the whole feature is
 * built on: with the venue switch off, the editor is running this same path
 * with an empty list.
 */
export function projectVariants(project) {
  return [project.primary, ...project.layers.map((l) => buildVariant(project, l))];
}
