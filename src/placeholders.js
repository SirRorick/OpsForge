// ---------------------------------------------------------------------------
// Placeholder geometry
// ---------------------------------------------------------------------------
// Stand-ins until the real .glb assets arrive. Each builder returns a single
// merged BufferGeometry authored to exactly the catalog `size`, with the origin
// where the catalog `pivot` says it is, so that applying the Unity scale
// straight to the mesh gives correct world dimensions.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const cache = new Map();

function box(w, h, d, x = 0, y = 0, z = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g.toNonIndexed();
}

function cyl(r, h, y = 0, seg = 24) {
  const g = new THREE.CylinderGeometry(r, r, h, seg);
  g.translate(0, y, 0);
  return g.toNonIndexed();
}

function merge(parts) {
  return parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
}

// -- Builders ---------------------------------------------------------------
// All builders author in a 1 x 1 x 1 cell with the base on y = 0; the caller
// rescales to `size` and moves the origin for centre-pivot pieces.

const builders = {
  box: () => box(1, 1, 1, 0, 0.5, 0),

  cylinder: () => cyl(0.5, 1, 0.5),

  // Slab with a kick plate and two end posts, so facing is readable at a glance.
  barrier: () => {
    const t = 1;
    return merge([
      box(1, 0.86, t * 0.62, 0, 0.5, 0),
      box(1, 0.1, t, 0, 0.06, 0),
      box(0.08, 1, t, -0.46, 0.5, 0),
      box(0.08, 1, t, 0.46, 0.5, 0),
    ]);
  },

  // Same slab with a letterbox opening in the upper half.
  barrierWindow: () => {
    const t = 0.62;
    return merge([
      box(1, 0.46, t, 0, 0.23, 0),
      box(1, 0.14, t, 0, 0.93, 0),
      box(0.16, 0.4, t, -0.42, 0.66, 0),
      box(0.16, 0.4, t, 0.42, 0.66, 0),
      box(0.08, 1, 1, -0.46, 0.5, 0),
      box(0.08, 1, 1, 0.46, 0.5, 0),
    ]);
  },

  // Two panels meeting at a right angle, occupying the -x / -z quadrant edges.
  barrierCorner: () => {
    const t = 0.12;
    return merge([
      box(1, 1, t, 0, 0.5, -0.5 + t / 2),
      box(t, 1, 1 - t, -0.5 + t / 2, 0.5, t / 2),
      box(0.1, 1.04, 0.1, -0.45, 0.52, -0.45),
    ]);
  },

  // Three panels forming a U opening toward +z.
  barrierU: () => {
    const t = 0.12;
    return merge([
      box(1, 1, t, 0, 0.5, -0.5 + t / 2),
      box(t, 1, 1 - t, -0.5 + t / 2, 0.5, t / 2),
      box(t, 1, 1 - t, 0.5 - t / 2, 0.5, t / 2),
    ]);
  },

  // Shell plus corner battens.
  crate: () => {
    const parts = [box(0.94, 0.94, 0.94, 0, 0.5, 0)];
    const e = 0.47;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        parts.push(box(0.1, 1, 0.1, sx * e, 0.5, sz * e));
      }
    }
    parts.push(box(1, 0.09, 0.09, 0, 0.5, -e));
    parts.push(box(1, 0.09, 0.09, 0, 0.5, e));
    return merge(parts);
  },

  electricityBox: () => {
    return merge([
      box(1, 0.9, 1, 0, 0.45, 0),
      box(0.7, 0.12, 0.2, 0, 0.95, 0.1),
      box(0.24, 0.3, 0.12, 0, 0.5, 0.56),
    ]);
  },

  // Two legs and a lintel: a readable walk-through arch.
  tunnel: () => {
    const leg = 0.22;
    return merge([
      box(leg, 0.78, 1, -0.5 + leg / 2, 0.39, 0),
      box(leg, 0.78, 1, 0.5 - leg / 2, 0.39, 0),
      box(1, 0.22, 1, 0, 0.89, 0),
    ]);
  },

  // Deliberately odd so an unrecognised type is impossible to mistake.
  unknown: () => {
    const g = new THREE.OctahedronGeometry(0.5, 0);
    g.scale(1, 1, 1);
    g.translate(0, 0.5, 0);
    return g.toNonIndexed();
  },
};

/**
 * Geometry for a catalog definition, scaled to its size and pivoted correctly.
 * Cached: every Crate in the map shares one BufferGeometry.
 */
export function geometryFor(def) {
  const key = `${def.shape}|${def.size.join(',')}|${def.pivot}`;
  if (cache.has(key)) return cache.get(key);

  const build = builders[def.shape] || builders.unknown;
  const g = build().clone();
  const [w, h, d] = def.size;
  g.scale(w, h, d);
  if (def.pivot === 'center') g.translate(0, -h / 2, 0);
  g.computeVertexNormals();
  g.computeBoundingBox();
  cache.set(key, g);
  return g;
}

/** Local-space bounding box of the unscaled placeholder. */
export function localBox(def) {
  return geometryFor(def).boundingBox;
}

export function clearGeometryCache() {
  for (const g of cache.values()) g.dispose();
  cache.clear();
}
