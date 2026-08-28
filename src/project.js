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
import { parseMap, serializeMap, NAV_SPACING } from './format.js';
import { zipRead, zipWrite } from './zip.js';

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
 * Nothing is lost to a repeat -- the guid is in the file name, so two maps of
 * one name are still two files. What is lost is the ability to tell them apart,
 * and the name is the only thing that ever could: on a headset, in a venue,
 * picking ARENA-01 out of a list of ARENA-01 is the whole job. Refused rather
 * than warned about, because it is always a slip.
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

// -- Does it fit in the room ------------------------------------------------
// The one thing about a venue that cannot be seen from the editor and cannot
// be fixed on site: whether the design, stood where this hall stands it,
// actually lands inside that hall's play space.
//
// The play space is the guardian boundary somebody walked in the headset, and
// it is the real constraint — an object outside it is an object a player
// cannot reach. The arena box is not the test: it is authored, it is centred
// on the origin, and both headset-made maps in the fixtures already carry
// objects outside their own. The mask is measured.
//
// Tested at the object's origin rather than over its footprint. Props sit on
// their base and primitives on their centre, so the origin is the piece's own
// spot on the floor either way, and a crate half over the line is a judgement
// nobody wants an editor making for them.

/** Whether a point in map values falls on a painted cell of this play space. */
export function navCloudCovers(navCloud, mask, point) {
  const div = navCloud?.divisions;
  if (!mask?.length || !div?.x || !div?.y) return true; // nothing to measure against

  // Per axis from size and divisions, the way `setNavCloud` derives it, so a
  // grid recorded at another scale is read at that scale.
  const sx = div.x > 1 ? navCloud.size.x / (div.x - 1) : NAV_SPACING;
  const sz = div.y > 1 ? navCloud.size.y / (div.y - 1) : NAV_SPACING;

  // Into the grid's own frame. It carries a position and a yaw of its own --
  // a map realigned in a headset is exactly what writes them -- so the point
  // is brought back by the opposite turn and the opposite shift.
  const at = navCloud.position || { x: 0, y: 0, z: 0 };
  const dx = point.x - (at.x || 0);
  const dz = point.z - (at.z || 0);
  const t = -wrap360(navCloud.rotation?.y || 0) * DEG;
  const cos = Math.cos(t), sin = Math.sin(t);
  const lx = dx * cos + dz * sin;
  const lz = -dx * sin + dz * cos;

  const col = Math.round(lx / sx + (div.x - 1) / 2);
  const row = Math.round(lz / sz + (div.y - 1) / 2);
  if (col < 0 || col >= div.x || row < 0 || row >= div.y) return false;
  // `row * width + col`, col along X and row along Z. See docs/FORMAT.md.
  return mask[row * div.x + col] === 1;
}

/**
 * Everything in one map that lands outside that map's own play space.
 *
 * Takes a whole map rather than a project and a layer, so the check runs over
 * exactly the files an export is about to write -- `projectVariants` has
 * already put each venue's objects where that venue will play them and given
 * it that room's play space. Checking anything else would be checking a
 * parallel calculation and hoping it agreed.
 *
 * `mask` is the decoded `encodedPoints`. With no mask there is nothing to
 * measure against and nothing is reported, which is the right answer for a
 * template whose boundary was never walked.
 */
export function objectsOutsidePlaySpace(map, mask) {
  if (!mask?.length) return [];
  return (map.mapObjects || []).filter((o) => !navCloudCovers(map.navCloud, mask, o.position));
}

// -- The project file -------------------------------------------------------
// `.opsproject` is a zip, and what is in it is deliberately readable with any
// unzip tool: the map and every venue template sit in it as the game's own
// files, unchanged, and one `project.json` holds the part that is OpsForge's --
// where each design stands in each hall, what each hall calls its map, what it
// has stopped inheriting and what it keeps of its own.
//
// It is a zip rather than one JSON document for two reasons. A map already has
// a serialiser that reproduces the game's bytes exactly, and putting a map
// inside JSON would mean escaping those bytes and trusting a second path to
// give them back. And a project that goes wrong should still be a folder of
// maps somebody can rescue by hand.
//
// **The guids in here are the point of the file.** They are minted once, when
// the templates arrive, and kept -- so a second export replaces the set on
// every headset rather than doubling it. That only holds as long as the project
// comes back from here rather than being reassembled from raw templates, which
// is why this exists at all.
//
// The map's objects carry ids that a map file has nowhere to put, since a
// venue names the ones it has stopped inheriting. They travel beside the text
// as a list in file order -- the same bargain the checkpoint sidecar strikes,
// and safe for the same reason: the ids and the text are written in one go.

const MAP_ENTRY = 'map';
const MANIFEST_ENTRY = 'project.json';
const templateEntry = (layer) => `templates/${layer.id}`;

/** Take the layer id counter past anything a file brought in. */
function adoptLayerIds(layers) {
  for (const l of layers) {
    const n = /^l(\d+)$/.exec(l.id || '');
    if (n && Number(n[1]) >= layerSeq) layerSeq = Number(n[1]) + 1;
  }
}

/**
 * The whole project as one archive.
 *
 * `editor` is the grouping, locking and hidden state of the map's own objects,
 * which the game's format has no room for -- the same sidecar a checkpoint
 * carries, and the reason a project restores an afternoon's arena rather than
 * four hundred loose objects.
 */
export async function writeProjectArchive(project, { editor = null } = {}) {
  const manifest = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    map: {
      file: MAP_ENTRY,
      // In file order, so index i names the object at index i.
      ids: (project.primary.mapObjects || []).map((o) => o.id ?? null),
      editor,
    },
    layers: project.layers.map((l) => ({
      id: l.id,
      name: l.name,
      guid: l.guid,
      template: templateEntry(l),
      offset: l.offset,
      yaw: l.yaw,
      placed: !!l.placed,
      detached: l.detached || [],
      // A venue's own objects are OpsForge's, not the game's, so they travel as
      // records rather than as a map -- which is also how they keep the editor
      // state a map file could not hold.
      objects: l.objects || [],
    })),
  };

  return zipWrite([
    { name: MANIFEST_ENTRY, data: JSON.stringify(manifest) },
    { name: MAP_ENTRY, data: serializeMap(project.primary) },
    ...project.layers.map((l) => ({
      name: templateEntry(l),
      data: serializeMap(l.template),
    })),
  ]);
}

/**
 * Read one back. Returns the pieces rather than a live project: the map has to
 * go through the editor's own ingest, which is `app.js`'s business.
 *
 * Throws with a reason on anything that is not one of these, because the file
 * picker that reaches here also accepts maps, and "nothing happened" is the
 * worst answer to a wrong file.
 */
export async function readProjectArchive(arrayBuffer) {
  const entries = await zipRead(arrayBuffer);
  const decoder = new TextDecoder();
  const byName = new Map(entries.map((e) => [e.name, decoder.decode(e.bytes)]));

  const raw = byName.get(MANIFEST_ENTRY);
  if (!raw) throw new Error('no project.json in that archive');

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new Error('the project.json in that archive is not readable');
  }
  if (manifest.format !== PROJECT_FORMAT) throw new Error('that is not an OpsForge project');
  if (!(manifest.version <= PROJECT_VERSION)) {
    throw new Error(`written by a newer editor (project v${manifest.version})`);
  }

  const mapText = byName.get(manifest.map?.file || MAP_ENTRY);
  if (!mapText) throw new Error('the map is missing from that project');

  const layers = (manifest.layers || []).map((l) => {
    const templateText = byName.get(l.template);
    if (!templateText) throw new Error(`the template for "${l.name}" is missing`);
    return {
      id: l.id,
      name: l.name,
      guid: l.guid,
      template: parseMap(templateText),
      offset: l.offset || { x: 0, y: 0, z: 0 },
      yaw: l.yaw || 0,
      placed: !!l.placed,
      detached: l.detached || [],
      objects: l.objects || [],
    };
  });
  adoptLayerIds(layers);

  return { mapText, ids: manifest.map?.ids || [], editor: manifest.map?.editor || null, layers };
}
