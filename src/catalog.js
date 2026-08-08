// ---------------------------------------------------------------------------
// Object catalog
// ---------------------------------------------------------------------------
// A pack is data, not code. Everything the editor knows about a game object
// lives in one of these entries, so adding a new pack means adding a JSON file
// and nothing else. Swap `model` in once real .glb assets are available and the
// placeholder is ignored.
//
// Fields
//   type          exact string written to the map file. This is the contract.
//   label         what the library shows
//   category      library grouping inside the pack
//   shape         placeholder generator id (see placeholders.js)
//   size          [w, h, d] in metres of the base mesh at scale 1,1,1
//   pivot         'base'   -> mesh sits on y = 0, origin at floor level
//                 'center' -> origin at the middle of the mesh
//   rotationAxes  'y'   -> yaw only (floor pieces)
//                 'xyz' -> free
//   floor         true if the piece is expected to rest on the ground
//   color         placeholder tint
//   uncertain     dimensions are inferred, not confirmed by the developers
// ---------------------------------------------------------------------------

export const PACK_SCHEMA_VERSION = 1;

// Pivot and floor behaviour below are read straight off the sample map:
// every Barrier/Crate sits at y = 0 (base pivot), while the *Solid primitives
// and Tunnel sit at y = scale.y / 2 (centre pivot resting on the floor).
export const DEFAULT_PACK = {
  id: 'default',
  name: 'Default',
  schema: PACK_SCHEMA_VERSION,
  objects: [
    // -- Barriers -----------------------------------------------------------
    {
      type: 'BarrierLow', label: 'Barrier Low', category: 'Barriers',
      shape: 'barrier', size: [1.0, 0.6, 0.12], pivot: 'base',
      rotationAxes: 'y', floor: true, color: '#8B99A6', uncertain: true,
    },
    {
      type: 'BarrierFull', label: 'Barrier Full', category: 'Barriers',
      shape: 'barrier', size: [1.0, 1.4, 0.12], pivot: 'base',
      rotationAxes: 'y', floor: true, color: '#8B99A6', uncertain: true,
    },
    {
      type: 'BarrierWindow', label: 'Barrier Window', category: 'Barriers',
      shape: 'barrierWindow', size: [1.0, 1.4, 0.12], pivot: 'base',
      rotationAxes: 'y', floor: true, color: '#8B99A6', uncertain: true,
    },
    {
      type: 'BarrierCorner', label: 'Barrier Corner', category: 'Barriers',
      shape: 'barrierCorner', size: [1.0, 1.4, 1.0], pivot: 'base',
      rotationAxes: 'y', floor: true, color: '#8B99A6', uncertain: true,
    },
    {
      type: 'BarrierU', label: 'Barrier U', category: 'Barriers',
      shape: 'barrierU', size: [1.0, 1.4, 1.0], pivot: 'base',
      rotationAxes: 'y', floor: true, color: '#8B99A6', uncertain: true,
    },

    // -- Props --------------------------------------------------------------
    {
      type: 'Crate', label: 'Crate', category: 'Props',
      shape: 'crate', size: [0.6, 0.6, 0.6], pivot: 'base',
      rotationAxes: 'y', floor: true, color: '#A8794A', uncertain: true,
    },
    {
      type: 'DestructibleCrate', label: 'Destructible Crate', category: 'Props',
      shape: 'crate', size: [0.6, 0.6, 0.6], pivot: 'base',
      rotationAxes: 'y', floor: true, color: '#B85C36', uncertain: true,
    },
    {
      type: 'DefaultElectricityBox', label: 'Electricity Box', category: 'Props',
      shape: 'electricityBox', size: [0.4, 0.6, 0.28], pivot: 'base',
      rotationAxes: 'y', floor: true, color: '#5C8A6B', uncertain: true,
    },
    {
      type: 'Tunnel', label: 'Tunnel', category: 'Props',
      shape: 'tunnel', size: [1.0, 1.0, 1.0], pivot: 'center',
      rotationAxes: 'y', floor: true, color: '#7C8794', uncertain: true,
    },

    // -- Primitives ---------------------------------------------------------
    // Confirmed by the sample: BoxSolidGrounded at y 0.5 with scale.y 1, and
    // CylinderSolid at y 1 with scale.y 2, both resting exactly on the floor.
    {
      type: 'BoxSolid', label: 'Box', category: 'Primitives',
      shape: 'box', size: [1, 1, 1], pivot: 'center',
      rotationAxes: 'xyz', floor: false, color: '#6E7C8A',
    },
    {
      type: 'BoxSolidGrounded', label: 'Box (Grounded)', category: 'Primitives',
      shape: 'box', size: [1, 1, 1], pivot: 'center',
      rotationAxes: 'y', floor: true, color: '#6E7C8A',
    },
    {
      type: 'CylinderSolid', label: 'Cylinder', category: 'Primitives',
      shape: 'cylinder', size: [1, 1, 1], pivot: 'center',
      rotationAxes: 'xyz', floor: false, color: '#6E7C8A',
    },
    {
      type: 'CylinderSolidGrounded', label: 'Cylinder (Grounded)', category: 'Primitives',
      shape: 'cylinder', size: [1, 1, 1], pivot: 'center',
      rotationAxes: 'y', floor: true, color: '#6E7C8A',
    },
    {
      type: 'WallSolid', label: 'Wall', category: 'Primitives',
      shape: 'box', size: [1, 1, 0.1], pivot: 'center',
      rotationAxes: 'y', floor: true, color: '#6E7C8A', uncertain: true,
    },
  ],
};

// ---------------------------------------------------------------------------

const packs = new Map();
const byType = new Map();

export function registerPack(pack) {
  if (!pack || !pack.id || !Array.isArray(pack.objects)) {
    throw new Error('A pack needs an id and an objects array.');
  }
  packs.set(pack.id, pack);
  for (const def of pack.objects) byType.set(def.type, { ...def, pack: pack.id });
  return pack;
}

export function getPacks() {
  return [...packs.values()];
}

export function getDef(type) {
  return byType.get(type) || null;
}

/**
 * Definition for a type the catalog has never seen. Loading a map that uses a
 * pack you have not installed should still work, so unknown types get a clearly
 * marked stand-in rather than being dropped on the floor.
 */
export function unknownDef(type) {
  return {
    type,
    label: type,
    category: 'Unrecognised',
    shape: 'unknown',
    size: [0.5, 0.5, 0.5],
    pivot: 'base',
    rotationAxes: 'xyz',
    floor: false,
    color: '#C0407A',
    unknown: true,
    pack: 'unrecognised',
  };
}

export function defOrUnknown(type) {
  return getDef(type) || unknownDef(type);
}

export function categoriesOf(pack) {
  const out = new Map();
  for (const def of pack.objects) {
    if (!out.has(def.category)) out.set(def.category, []);
    out.get(def.category).push(def);
  }
  return out;
}

registerPack(DEFAULT_PACK);
