// ---------------------------------------------------------------------------
// Placeholder geometry
// ---------------------------------------------------------------------------
// What the editor draws when the game's own art is not there — which is the
// normal case, since `reference/GameAssets/` is gitignored and the open-source
// build ships without it. When the dump *is* present `scene.js` loads the real
// prefab and none of this is used.
//
// **These are measured, not guessed, and they are not the game's meshes.**
// Every builder below was written from a numeric report produced by
// `npm run trace-prefabs`: the silhouette of the real prefab band by band, the
// openings cut through it, and cross-sections through its middle, all in
// metres. A builder then reproduces those numbers out of boxes, cylinders and
// prisms. Nothing is decimated, voxelised or converted — no vertex of the
// artists' work is in this file, only dimensions read off it, the same way the
// catalog's `size` field is a measurement rather than a copy.
//
// So the rule for changing one of these: run the tracer, read the numbers,
// write the boxes. Do not eyeball it against a screenshot, and do not import
// mesh data.
//
// Every builder authors inside a unit cell: x and z run -0.5 to 0.5, y runs
// 0 to 1 with the base on the floor. `geometryFor` then stretches that cell to
// the catalog `size`, so a builder only has to get the silhouette right, never
// the dimensions — which is why the comments quote proportions of the cell and
// the tracer's metres appear beside them.
//
// The point is recognising a piece at a glance in the library and in the
// viewport, and above all showing what distinguishes it: a barrier with a
// window has a hole, a doorway has a gap you can walk through, a U has its
// notch open at the top. Detail beyond that is not worth the triangles.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const cache = new Map();

// -- primitive helpers ------------------------------------------------------

function box(w, h, d, x = 0, y = 0, z = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g.toNonIndexed();
}

function cyl(r, h, y = 0, seg = 20, rTop = r) {
  const g = new THREE.CylinderGeometry(rTop, r, h, seg);
  g.translate(0, y, 0);
  return g.toNonIndexed();
}

/** Cylinder lying along an axis, for barrels, poles and rotor masts. */
function tube(r, len, axis, x = 0, y = 0, z = 0, seg = 12) {
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return g.toNonIndexed();
}

function cone(r, h, x = 0, y = 0, z = 0, seg = 14) {
  const g = new THREE.ConeGeometry(r, h, seg);
  g.translate(x, y, z);
  return g.toNonIndexed();
}

function ball(r, x = 0, y = 0, z = 0, seg = 12) {
  const g = new THREE.SphereGeometry(r, seg, Math.max(6, seg / 2));
  g.translate(x, y, z);
  return g.toNonIndexed();
}

function ring(r, t, x = 0, y = 0, z = 0, seg = 24) {
  const g = new THREE.TorusGeometry(r, t, 8, seg);
  g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return g.toNonIndexed();
}

// No toNonIndexed here: PolyhedronGeometry, which this extends, is already
// non-indexed and three.js warns on the console if you ask twice. The console
// needs to stay quiet here since that's also where failed merges get reported.
function octa(r, x = 0, y = 0, z = 0) {
  const g = new THREE.OctahedronGeometry(r, 0);
  g.translate(x, y, z);
  return g;
}

/** Half a cylinder, flat face at -z: the plan view of a capital D. */
function halfCyl(r, h, y = 0, seg = 16) {
  const g = new THREE.CylinderGeometry(r, r, h, seg, 1, false, -Math.PI / 2, Math.PI);
  g.translate(0, y, 0);
  return g.toNonIndexed();
}

/**
 * Scale, then rotate, then move. Doing it in that order is the whole point:
 * a geometry that has already been translated rotates about the world origin
 * and swings away from where it was put.
 */
function place(g, { rx = 0, ry = 0, rz = 0, x = 0, y = 0, z = 0, s } = {}) {
  if (s) g.scale(s[0], s[1], s[2]);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  if (x || y || z) g.translate(x, y, z);
  return g;
}

/**
 * Extrude a convex polygon given counter-clockwise in the XY plane along z.
 * Ramps, chevrons, flags and crystal shards all fall out of this.
 */
function prism(pts, depth, x = 0, y = 0, z = 0) {
  const hz = depth / 2;
  const pos = [];
  const tri = (a, b, c) => pos.push(...a, ...b, ...c);
  const n = pts.length;
  for (let i = 1; i < n - 1; i++) {
    tri([pts[0][0], pts[0][1], hz], [pts[i][0], pts[i][1], hz], [pts[i + 1][0], pts[i + 1][1], hz]);
    tri([pts[0][0], pts[0][1], -hz], [pts[i + 1][0], pts[i + 1][1], -hz], [pts[i][0], pts[i][1], -hz]);
  }
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    tri([a[0], a[1], hz], [b[0], b[1], -hz], [b[0], b[1], hz]);
    tri([a[0], a[1], hz], [a[0], a[1], -hz], [b[0], b[1], -hz]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  g.computeVertexNormals();
  g.translate(x, y, z);
  return g;
}

function merge(parts) {
  return parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
}

// -- shared sub-assemblies --------------------------------------------------

/**
 * The two end posts every barrier in the Default family carries, standing a
 * little proud of the panel between them. Traced: BarrierFull's panel cuts at
 * 1.003 x 0.142 m with the outer 2/14 of its width running the full 0.258 m
 * depth, which is these.
 */
function endPosts(w = 0.09, h = 1, y = null) {
  const cy = y ?? h / 2;
  return [box(w, h, 1, -0.5 + w / 2, cy, 0), box(w, h, 1, 0.5 - w / 2, cy, 0)];
}

/** Low plinth the weapon spawn point stands on. */
function pedestal() {
  return [
    cyl(0.42, 0.06, 0.03, 16),
    cyl(0.3, 0.06, 0.12, 16),
    cyl(0.12, 0.2, 0.2, 10),
    cyl(0.34, 0.05, 0.32, 16),
  ];
}

/** Floor pad with corner posts, shared by the objective zones. */
function zonePad(r, postH, posts = 4) {
  const parts = [ring(r, 0.035, 0, 0.036), cyl(r - 0.05, 0.02, 0.01, 24)];
  for (let i = 0; i < posts; i++) {
    const a = (i / posts) * Math.PI * 2 + Math.PI / 4;
    parts.push(box(0.06, postH, 0.06, Math.cos(a) * r, postH / 2, Math.sin(a) * r));
  }
  return parts;
}

/** A run of upright planks with gaps between them, for the timber themes. */
function planks(n, w, h, d, y = null, x0 = -0.5, x1 = 0.5) {
  const out = [];
  const span = x1 - x0;
  for (let i = 0; i < n; i++) {
    out.push(box(w, h, d, x0 + (span * (i + 0.5)) / n, y ?? h / 2, 0));
  }
  return out;
}

// -- builders ---------------------------------------------------------------

const builders = {
  // -- primitives -----------------------------------------------------------
  // Confirmed one-metre unit meshes, so these are the meshes rather than an
  // approximation of them. BoxSolid traces to exactly 1 x 1 x 1.
  box: () => box(1, 1, 1, 0, 0.5, 0),

  // CylinderSolid traces 1 x 0.993 x 1 — the missing 7 mm is the bevel on the
  // two caps, which is what the inset top and bottom discs stand in for.
  cylinder: () =>
    merge([
      cyl(0.5, 0.94, 0.5, 24),
      cyl(0.47, 0.03, 0.015, 24),
      cyl(0.47, 0.03, 0.985, 24),
    ]),

  // -- walls ----------------------------------------------------------------
  // WallSolid: a slab 1.069 x 1.019 x 0.125 whose end caps run 10 mm deeper
  // than the panel — traced as x -0.53..-0.44 and 0.44..0.53 standing outside
  // the panel's z band.
  wall: () =>
    merge([
      box(0.84, 1, 0.78, 0, 0.5, 0),
      box(0.17, 1, 1, -0.415, 0.5, 0),
      box(0.17, 1, 1, 0.415, 0.5, 0),
      box(1, 0.09, 1, 0, 0.955, 0),
    ]),

  // CamoWallSolid is nearly twice as deep (0.236) and stepped: the plan shows
  // three z bands, the middle one 0.09 m wider than the outer two.
  wallLayered: () =>
    merge([
      box(1, 1, 0.6, 0, 0.5, 0),
      box(0.8, 1, 0.85, 0, 0.5, 0),
      box(0.72, 1, 1, 0, 0.5, 0),
      box(1, 0.07, 0.62, 0, 0.965, 0),
    ]),

  // MYKEAWallSolid traces as one flat rectangle in every view — no caps, no
  // steps. The plainest of the four, and it should look it.
  wallPlain: () => merge([box(1, 1, 1, 0, 0.5, 0), box(0.94, 0.96, 1.02, 0, 0.5, 0)]),

  // WildWestWallSolid: boards across, with the end caps proud like WallSolid.
  wallPlank: () =>
    merge([
      ...[0.14, 0.38, 0.62, 0.86].map((y) => box(0.92, 0.2, 0.8, 0, y, 0)),
      box(0.15, 1, 1, -0.425, 0.5, 0),
      box(0.15, 1, 1, 0.425, 0.5, 0),
    ]),

  // -- barriers: full -------------------------------------------------------
  // BarrierFull, 1.028 x 2 x 0.258. Solid across every band. A plinth for the
  // bottom 0.4 m at 0.168 m deep, a 0.142 m panel above it, and the end posts
  // at the full 0.258.
  barrierFull: () =>
    merge([
      box(1, 0.2, 0.68, 0, 0.1, 0),
      box(0.97, 0.82, 0.55, 0, 0.59, 0),
      box(1, 0.06, 0.66, 0, 0.97, 0),
      ...endPosts(),
    ]),

  // CamoBarrierFullVisual, 1.01 x 2.003 x 0.196: every cut is the same
  // 0.976 x 0.143 rectangle top to bottom. A plain slab with a rim.
  barrierFullSlab: () =>
    merge([
      box(0.97, 1, 0.73, 0, 0.5, 0),
      box(1, 0.04, 1, 0, 0.02, 0),
      box(1, 0.04, 1, 0, 0.98, 0),
      ...endPosts(0.03),
    ]),

  // PaintBallBarrierFullVisual, 1 x 2.011 x 0.268: two feet in the bottom
  // 0.1 m, then full depth at the bottom and top and a thinner panel between.
  barrierFullFeet: () =>
    merge([
      box(0.14, 0.05, 1, -0.37, 0.025, 0),
      box(0.14, 0.05, 1, 0.38, 0.025, 0),
      box(1, 0.25, 1, 0, 0.175, 0),
      box(0.96, 0.45, 0.48, 0, 0.525, 0),
      box(1, 0.25, 1, 0, 0.875, 0),
    ]),

  // WildWestBarrierTall, 1.077 x 2.389 x 0.299: boards to y 2.03 with a rail
  // standing proud across the middle, then a post tapering to the top in three
  // steps of half-width 0.30, 0.27, 0.18.
  barrierFullPost: () =>
    merge([
      ...planks(4, 0.21, 0.85, 0.62, 0.425),
      box(1, 0.05, 0.75, 0, 0.025, 0),
      box(0.95, 0.09, 1, 0, 0.5, 0),
      box(0.56, 0.06, 0.62, 0, 0.88, 0),
      box(0.5, 0.05, 0.55, 0, 0.925, 0),
      box(0.34, 0.05, 0.42, 0, 0.975, 0),
    ]),

  // -- barriers: low --------------------------------------------------------
  // BarrierLow, 1.012 x 1.206 x 0.258 — the same family as barrierFull cut
  // short, with a cap that narrows to 0.46 half-width at the very top.
  barrierLow: () =>
    merge([
      box(1, 0.44, 0.68, 0, 0.22, 0),
      box(0.97, 0.4, 0.55, 0, 0.64, 0),
      box(0.94, 0.05, 0.72, 0, 0.955, 0),
      ...endPosts(0.09, 0.95),
    ]),

  // CamoBarrierHalfVisual, 1.01 x 1.041 x 0.189: a slab with a stepped cap —
  // three thin bands at the top, each a centimetre wider than the last.
  barrierLowSlab: () =>
    merge([
      box(0.97, 0.86, 0.73, 0, 0.43, 0),
      box(1, 0.05, 1, 0, 0.025, 0),
      box(0.97, 0.05, 0.8, 0, 0.88, 0),
      box(1, 0.05, 0.9, 0, 0.93, 0),
      box(0.97, 0.05, 0.8, 0, 0.98, 0),
    ]),

  // PaintBallBarrierLowVisual, 1 x 1.024 x 0.268: feet in the bottom 5 cm,
  // solid above.
  barrierLowFeet: () =>
    merge([
      box(0.22, 0.05, 1, -0.37, 0.025, 0),
      box(0.22, 0.05, 1, 0.37, 0.025, 0),
      box(1, 0.5, 1, 0, 0.3, 0),
      box(0.96, 0.45, 0.5, 0, 0.775, 0),
    ]),

  // WildWestBarrierShort, 1.179 x 1.212 x 0.207: the cap is *wider* than the
  // body — 0.60 half-width against 0.50 — which is the detail worth keeping.
  barrierLowCap: () =>
    merge([
      ...planks(4, 0.19, 0.9, 0.6, 0.45, -0.42, 0.42),
      box(0.9, 0.05, 0.7, 0, 0.025, 0),
      box(1, 0.1, 1, 0, 0.95, 0),
      box(0.14, 0.9, 0.72, -0.42, 0.45, 0),
      box(0.14, 0.9, 0.72, 0.42, 0.45, 0),
    ]),

  // -- barriers: window -----------------------------------------------------
  // BarrierWindow, 1.028 x 2 x 0.258. Traced opening: x -0.157..0.155,
  // y 1.286..1.571 — a 0.31 x 0.29 m hole a little above head height. Same
  // panel as barrierFull otherwise, which is why it shares its plinth.
  barrierWindow: () => {
    const [x0, x1] = [-0.153, 0.151];    // hole, as a fraction of the cell
    const [y0, y1] = [0.643, 0.786];
    return merge([
      box(1, 0.2, 0.68, 0, 0.1, 0),
      box(0.97, y0 - 0.2, 0.55, 0, (y0 + 0.2) / 2, 0),
      box(0.97, 1 - y1, 0.55, 0, (1 + y1) / 2, 0),
      box(0.5 + x0, y1 - y0, 0.55, (x0 - 0.5) / 2, (y0 + y1) / 2, 0),
      box(0.5 - x1, y1 - y0, 0.55, (x1 + 0.5) / 2, (y0 + y1) / 2, 0),
      box(1, 0.06, 0.66, 0, 0.97, 0),
      ...endPosts(),
    ]);
  },

  // CamoBarrierWindowVisual, 1.01 x 2.003 x 0.2. A much bigger opening, and
  // lower: x -0.236..0.236, y 0.858..1.43, so 0.47 x 0.57 m at chest height.
  barrierWindowWide: () => {
    const [x0, x1] = [-0.234, 0.234];
    const [y0, y1] = [0.428, 0.714];
    return merge([
      box(0.97, y0, 0.73, 0, y0 / 2, 0),
      box(0.97, 1 - y1, 0.73, 0, (1 + y1) / 2, 0),
      box(0.5 + x0, y1 - y0, 0.73, (x0 - 0.5) / 2, (y0 + y1) / 2, 0),
      box(0.5 - x1, y1 - y0, 0.73, (x1 + 0.5) / 2, (y0 + y1) / 2, 0),
      box(1, 0.04, 1, 0, 0.02, 0),
      box(1, 0.04, 1, 0, 0.98, 0),
      ...endPosts(0.03),
    ]);
  },

  // PaintBallBarrierWindowVisual, 1 x 2.011 x 0.268. Not a window but a
  // letterbox: at y 1.292..1.58 the only material left is two stubs at
  // x -0.442..-0.3 and 0.308..0.454, so the slot runs nearly the full width
  // and is open at both ends.
  barrierWindowSlot: () => {
    const [y0, y1] = [0.642, 0.786];
    return merge([
      box(0.22, 0.05, 1, -0.37, 0.025, 0),
      box(0.22, 0.05, 1, 0.37, 0.025, 0),
      box(1, y0 - 0.05, 1, 0, (y0 + 0.05) / 2, 0),
      box(1, 1 - y1, 1, 0, (1 + y1) / 2, 0),
      box(0.14, y1 - y0, 0.5, -0.37, (y0 + y1) / 2, 0),
      box(0.15, y1 - y0, 0.5, 0.38, (y0 + y1) / 2, 0),
    ]);
  },

  // HatCoBarrierWallWindow, 1.036 x 1.998 x 0.25. The tallest opening of the
  // four: x -0.241..0.277, y 0.999..1.712, with a narrower slot below it down
  // to y 0.856. Two jambs, a lintel, and a sill that steps inward.
  barrierWindowTall: () => {
    const [x0, x1] = [-0.233, 0.268];
    const [y0, y1] = [0.5, 0.857];
    return merge([
      box(0.97, 0.428, 0.6, 0, 0.214, 0),
      box(0.32, 0.072, 0.6, -0.34, 0.464, 0),
      box(0.29, 0.072, 0.6, 0.355, 0.464, 0),
      box(0.5 + x0, y1 - y0, 0.6, (x0 - 0.5) / 2, (y0 + y1) / 2, 0),
      box(0.5 - x1, y1 - y0, 0.6, (x1 + 0.5) / 2, (y0 + y1) / 2, 0),
      box(0.97, 1 - y1, 0.6, 0, (1 + y1) / 2, 0),
      ...endPosts(0.04),
    ]);
  },

  // -- barriers: U ----------------------------------------------------------
  // BarrierU, 1.028 x 2 x 0.258. **The notch is open at the top**, not a hole:
  // solid to y 1.143, then two uprights either side of a gap x -0.191..0.19.
  // It is not a U in plan and never was — the old builder gave it a lintel,
  // which closed the one feature the piece has.
  barrierU: () => {
    const [x0, x1] = [-0.186, 0.185];
    const y0 = 0.571;
    return merge([
      box(1, 0.2, 0.68, 0, 0.1, 0),
      box(0.97, y0 - 0.2, 0.55, 0, (y0 + 0.2) / 2, 0),
      box(0.5 + x0, 1 - y0, 0.55, (x0 - 0.5) / 2, (1 + y0) / 2, 0),
      box(0.5 - x1, 1 - y0, 0.55, (x1 + 0.5) / 2, (1 + y0) / 2, 0),
      ...endPosts(),
    ]);
  },

  // IndoorBarrierUVisualCouch, 1.002 x 1.987 x 0.266 — the MYKEA couch read as
  // a U: two feet in the bottom 0.15 m, a solid seat to half height, then two
  // arms either side of a gap x -0.187..0.189.
  barrierUCouch: () => {
    const [x0, x1] = [-0.187, 0.189];
    const y0 = 0.5;
    return merge([
      box(0.06, 0.07, 0.5, -0.443, 0.035, 0),
      box(0.06, 0.07, 0.5, 0.445, 0.035, 0),
      box(1, y0 - 0.07, 1, 0, (y0 + 0.07) / 2, 0),
      box(0.5 + x0, 1 - y0, 1, (x0 - 0.5) / 2, (1 + y0) / 2, 0),
      box(0.5 - x1, 1 - y0, 1, (x1 + 0.5) / 2, (1 + y0) / 2, 0),
      box(0.75, 0.08, 0.86, 0, y0 + 0.04, 0),
    ]);
  },

  // -- barriers: corner -----------------------------------------------------
  // BarrierCorner, 1.14 x 2 x 1.143. An L in plan wrapping the +x/+z corner:
  // the tracer's plan shows one arm at z -0.12..0.13 spanning x -1.00..0.13,
  // and the other at x -0.13..0.13 spanning z -1.01..-0.12. The origin sits in
  // that corner rather than in the middle of the footprint, which is what the
  // catalog's `anchor` carries.
  barrierCorner: () => {
    const t = 0.22;      // arm thickness, 0.25 m of a 1.14 m cell
    return merge([
      box(1, 1, t, 0, 0.5, 0.5 - t / 2),
      box(t, 1, 1 - t, 0.5 - t / 2, 0.5, -t / 2),
      box(t + 0.02, 1.02, t + 0.02, 0.5 - t / 2, 0.51, 0.5 - t / 2),
    ]);
  },

  // IndoorBarrierCornerVisual, 1.213 x 2.075 x 1.224. Same L, but the inside
  // of the corner is cut away on a diagonal — the plan's inner edge steps from
  // x -0.10 at z -0.41 out to x -1.05 at z -0.23 rather than turning square.
  barrierCornerRound: () => {
    const t = 0.2;
    return merge([
      box(1, 1, t, 0, 0.5, 0.5 - t / 2),
      box(t, 1, 1 - t, 0.5 - t / 2, 0.5, -t / 2),
      place(prism([[0, 0], [0.34, 0], [0, 0.34]], 1), { ry: Math.PI, rx: -Math.PI / 2, x: 0.5 - t, z: 0.5 - t }),
    ]);
  },

  // WildWestBarrierCorner90, 1.112 x 2.389 x 1.167: the same L in planks, with
  // the arms only 0.2 m thick and a post standing at the corner.
  barrierCornerPost: () => {
    const t = 0.17;
    return merge([
      box(1, 0.85, t, 0, 0.425, 0.5 - t / 2),
      box(t, 0.85, 1 - t, 0.5 - t / 2, 0.425, -t / 2),
      box(1, 0.06, t + 0.03, 0, 0.44, 0.5 - t / 2),
      box(t + 0.03, 0.06, 1 - t, 0.5 - t / 2, 0.44, -t / 2),
      box(t + 0.04, 1, t + 0.04, 0.5 - t / 2, 0.5, 0.5 - t / 2),
    ]);
  },

  // -- barriers: the one-offs -----------------------------------------------
  // CamoBarrierUVisual, 1.01 x 2.003 x 0.196. Catalogued as "X" but it is not
  // a cross: the elevation is wide at the bottom, pinched to half-width
  // x -0.25..0.25 through the middle, and wide again at the top. An I-beam
  // standing up.
  barrierX: () =>
    merge([
      box(1, 0.35, 0.73, 0, 0.175, 0),
      box(0.5, 0.45, 0.73, 0, 0.575, 0),
      box(1, 0.2, 0.73, 0, 0.9, 0),
      box(1, 0.04, 1, 0, 0.02, 0),
      box(1, 0.04, 1, 0, 0.98, 0),
    ]),

  // PaintBallBarrierUVisual, 1.009 x 2.011 x 0.268. A panel with a round bite
  // out of its right-hand edge — the traced right edge runs 0.26, 0.17, 0.08,
  // -0.00, 0.06, 0.15, 0.24 through the middle bands — and a separate post
  // standing outside the bite at x 0.31..0.46.
  barrierD: () =>
    merge([
      box(0.22, 0.05, 1, -0.37, 0.025, 0),
      box(0.22, 0.05, 1, 0.37, 0.025, 0),
      box(1, 0.25, 1, 0, 0.175, 0),
      box(0.8, 0.4, 0.5, -0.1, 0.5, 0),
      box(1, 0.4, 1, 0, 0.8, 0),
      box(0.15, 0.6, 0.5, 0.385, 0.6, 0),
      place(halfCyl(0.28, 0.5, 0.25), { rz: Math.PI, x: 0.3, y: 0.5 }),
    ]),

  // HatCoBarrierUVisual, 1.028 x 1.996 x 0.335. An L in *elevation*: full
  // width to y 0.8, then only the left of it carries on up — the right edge
  // steps 0.16, 0.09, 0.03 and stays there.
  barrierL: () =>
    merge([
      box(1, 0.4, 0.7, 0, 0.2, 0),
      box(0.98, 0.05, 1, 0, 0.4, 0),
      box(0.52, 0.6, 0.7, -0.24, 0.7, 0),
      box(0.06, 1, 0.72, -0.47, 0.5, 0),
      box(0.06, 0.6, 0.72, 0.01, 0.7, 0),
    ]),

  // HatCoBarrierSlopeVisual, 1.028 x 1.198 x 0.262. A ramp: solid to y 0.72,
  // then the left edge marches right in even steps to x -0.10 at the top, so
  // the slope falls away to the left.
  barrierSlope: () =>
    merge([
      box(1, 0.6, 0.7, 0, 0.3, 0),
      place(prism([[-0.5, 0], [0.5, 0], [0.5, 0.4]], 0.7), { y: 0.6 }),
      box(0.1, 1, 0.72, 0.45, 0.5, 0),
    ]),

  // HatCoBarrierDoorwayVisual, 1.053 x 1.998 x 0.262. A gap you walk through:
  // jambs at x -0.47..-0.13 and 0.18..0.53 from the floor to y 1.7, solid over
  // the top.
  barrierDoorway: () => {
    const [x0, x1] = [-0.124, 0.171];
    const y1 = 0.851;
    return merge([
      box(0.5 + x0, y1, 0.7, (x0 - 0.5) / 2, y1 / 2, 0),
      box(0.5 - x1, y1, 0.7, (x1 + 0.5) / 2, y1 / 2, 0),
      box(1, 1 - y1, 0.7, 0, (1 + y1) / 2, 0),
      box(1, 0.05, 0.8, 0, 0.975, 0),
      box(0.08, 1, 0.72, -0.46, 0.5, 0),
      box(0.08, 1, 0.72, 0.46, 0.5, 0),
    ]);
  },

  // WildWestBarrierDoor, 1.18 x 2.1 x 0.319. Saloon doors: two posts at
  // x -0.50..-0.38 and 0.38..0.49 running the full height, leaves between them
  // that stop short at y 1.36..1.57, and nothing between the posts at the top.
  barrierDoor: () =>
    merge([
      box(0.1, 1, 0.6, -0.44, 0.5, 0),
      box(0.1, 1, 0.6, 0.44, 0.5, 0),
      box(1, 0.06, 0.75, 0, 0.03, 0),
      box(1, 0.07, 0.7, 0, 0.53, 0),
      box(1, 0.07, 0.7, 0, 0.79, 0),
      box(0.3, 0.4, 0.5, -0.17, 0.45, 0),
      box(0.3, 0.4, 0.5, 0.17, 0.45, 0),
      box(0.62, 0.06, 0.55, 0, 0.65, 0),
    ]),

  // BarrierStreetStyleBroken2x1m, 1.017 x 2.043 x 0.187. Solid to y 1.23, then
  // the left edge climbs away diagonally — traced at -0.31, -0.16, -0.10,
  // 0.00, 0.10 — leaving a jagged stump on the right.
  barrierBroken: () =>
    merge([
      box(1, 0.6, 0.73, 0, 0.3, 0),
      box(0.97, 0.02, 0.8, 0, 0.6, 0),
      place(prism([[-0.5, 0], [0.5, 0], [0.5, 0.4]], 0.73), { y: 0.6 }),
      box(0.36, 0.28, 0.73, 0.32, 0.86, 0),
      box(0.06, 1, 0.75, 0.47, 0.5, 0),
      box(0.06, 0.6, 0.75, -0.47, 0.3, 0),
    ]),

  // WildWestBarrierBroken, 1.18 x 2.1 x 0.319. Two posts still standing with
  // the boards between them progressively missing: the middle run narrows from
  // x -0.37..0.37 to -0.19..0.17 and finally to a stub at the top left.
  barrierBrokenPlanks: () =>
    merge([
      box(0.1, 1, 0.6, -0.44, 0.5, 0),
      box(0.09, 1, 0.6, 0.44, 0.5, 0),
      box(1, 0.25, 0.7, 0, 0.125, 0),
      box(0.63, 0.25, 0.55, 0, 0.375, 0),
      box(0.31, 0.34, 0.55, -0.01, 0.67, 0),
      box(0.06, 0.11, 0.55, -0.14, 0.955, 0),
    ]),

  // -- structures -----------------------------------------------------------
  // HatCoBarrierPillarVisual, 0.638 x 1.999 x 0.526. A column: base 0.31,
  // waist 0.26, a band back out to 0.31, a 0.26 shaft, then the capital.
  pillar: () =>
    merge([
      box(0.98, 0.15, 0.98, 0, 0.075, 0),
      box(0.83, 0.1, 0.83, 0, 0.2, 0),
      box(0.98, 0.15, 0.98, 0, 0.325, 0),
      box(0.83, 0.3, 0.83, 0, 0.55, 0),
      box(0.98, 0.05, 0.98, 0, 0.725, 0),
      box(1, 0.15, 1, 0, 0.825, 0),
      box(0.93, 0.1, 0.93, 0, 0.95, 0),
    ]),

  // Tunnel, 0.999 x 1 x 1. The plan is a full square and the front elevation
  // has material only at z -0.50..-0.48 and 0.48..0.50 — two thin walls with
  // the whole middle open. You walk through it along x.
  tunnel: () => {
    const t = 0.05;
    return merge([
      box(1, 1, t, 0, 0.5, -0.5 + t / 2),
      box(1, 1, t, 0, 0.5, 0.5 - t / 2),
      box(1, t, 1, 0, 1 - t / 2, 0),
      box(1, 0.04, 1.04, 0, 0.98, 0),
    ]);
  },

  // -- props ----------------------------------------------------------------
  // Crate, 0.5 x 0.5 x 0.5 — a plain cube at every band. The battens are
  // texture, not geometry, so they get a light chamfer here and nothing more.
  crate: () =>
    merge([
      box(1, 1, 1, 0, 0.5, 0),
      box(1.04, 0.08, 1.04, 0, 0.04, 0),
      box(1.04, 0.08, 1.04, 0, 0.96, 0),
    ]),

  // CamoCrateBig, 1.187 x 0.556 x 0.55. Feet in the bottom 0.05 m, a body that
  // bulges to 0.59 half-width at mid height, and two latches on the lid at
  // x -0.28..-0.21 and 0.21..0.28.
  crateBig: () =>
    merge([
      box(0.09, 0.09, 0.85, -0.39, 0.045, 0),
      box(0.09, 0.09, 0.85, 0.39, 0.045, 0),
      box(0.96, 0.75, 0.96, 0, 0.465, 0),
      box(1, 0.14, 1, 0, 0.66, 0),
      box(0.96, 0.1, 0.9, 0, 0.95, 0),
      box(0.06, 0.09, 0.2, -0.21, 0.955, 0.4),
      box(0.06, 0.09, 0.2, 0.21, 0.955, 0.4),
    ]),

  // DestructibleCrate, 0.5 x 0.5 x 0.5. Slatted rather than solid: the plan
  // shows repeated 1 cm splits across both axes, so it is built as planks.
  crateDestructible: () => {
    const parts = [];
    for (const y of [0.1, 0.31, 0.52, 0.73, 0.94]) parts.push(box(1, 0.16, 1, 0, y, 0));
    for (const x of [-0.42, -0.14, 0.14, 0.42]) parts.push(box(0.12, 1, 1.02, x, 0.5, 0));
    parts.push(box(1.02, 0.07, 1.02, 0, 0.035, 0));
    return merge(parts);
  },

  // ElectricityBoxDefaultVisual, 0.545 x 0.714 x 0.44. A cabinet on a plinth,
  // tapering back in plan — half-width falls from 0.26 at the front to 0.12 at
  // the back — with a lip round the top.
  electricityBox: () =>
    merge([
      box(1, 0.17, 0.9, 0, 0.085, 0),
      place(prism([[-0.44, -0.5], [0.44, -0.5], [0.23, 0.5], [-0.23, 0.5]], 0.74), { rx: -Math.PI / 2, y: 0.53 }),
      box(0.93, 0.08, 0.86, 0, 0.955, 0),
      box(0.5, 0.3, 0.06, 0, 0.5, -0.46),
    ]),

  // IndoorBarrierCrateVisual, 1.002 x 0.174 x 0.502. Almost flat — a floor
  // cushion, not a box. It was drawn as a 0.9 m cube before, which made a
  // 17 cm pad look like furniture.
  cushion: () =>
    merge([
      box(1, 0.8, 1, 0, 0.4, 0),
      box(0.94, 0.25, 0.94, 0, 0.88, 0),
      box(1.02, 0.3, 0.6, 0, 0.4, 0),
    ]),

  // IndoorCover1x1, 0.5 x 0.51 x 0.5. A square pouffe on four short feet at
  // x -0.20..-0.15 and 0.15..0.20 — square in plan, not the cylinder it used
  // to be drawn as.
  ottoman: () => {
    const parts = [box(0.96, 0.82, 0.96, 0, 0.55, 0), box(1, 0.14, 1, 0, 0.93, 0)];
    for (const x of [-0.35, 0.35]) {
      for (const z of [-0.35, 0.35]) parts.push(box(0.1, 0.18, 0.1, x, 0.09, z));
    }
    return merge(parts);
  },

  // IndoorBarrierGroundedVisualCouch, 1.66 x 1.038 x 0.97. Feet, a seat block
  // to half height at 0.80 half-width, and a back that widens to 0.83.
  sofa: () =>
    merge([
      box(0.05, 0.09, 0.6, -0.45, 0.045, 0),
      box(0.05, 0.09, 0.6, 0.45, 0.045, 0),
      box(0.96, 0.42, 1, 0, 0.3, 0),
      box(1, 0.34, 1, 0, 0.34, 0),
      box(1, 0.5, 0.34, 0, 0.75, -0.33),
      box(0.1, 0.32, 0.9, -0.45, 0.66, 0.05),
      box(0.1, 0.32, 0.9, 0.45, 0.66, 0.05),
      box(0.36, 0.12, 0.62, -0.22, 0.56, 0.08),
      box(0.36, 0.12, 0.62, 0.22, 0.56, 0.08),
    ]),

  // StreetStyleBarrel, 0.522 x 0.671 x 0.522. Round in plan, with a rim
  // standing 0.01 proud at the bottom 0.06 m and the top 0.06 m.
  barrel: () =>
    merge([
      cyl(0.48, 0.9, 0.5, 20),
      cyl(0.5, 0.09, 0.045, 20),
      cyl(0.5, 0.09, 0.955, 20),
      ring(0.49, 0.02, 0, 0.32, 0, 20),
      ring(0.49, 0.02, 0, 0.68, 0, 20),
    ]),

  // WildWestCacti, 0.84 x 1.544 x 0.629. A trunk with two arms that rise
  // beside it: the left arm tops out around y 1.03, the right around y 1.16,
  // and above that only the trunk carries on.
  cacti: () =>
    merge([
      cyl(0.12, 0.98, 0.49, 12),
      ball(0.12, 0, 0.97, 0, 12).scale(1, 0.5, 1),
      cyl(0.13, 0.14, 0.07, 12),
      // left arm: out at y 0.3, up to y 0.66
      tube(0.09, 0.3, 'x', -0.23, 0.34, 0, 10),
      cyl(0.09, 0.32, 0.5, 10).translate(-0.38, 0, 0),
      ball(0.09, -0.38, 0.66, 0, 10),
      // right arm, a little higher
      tube(0.08, 0.28, 'x', 0.22, 0.44, 0, 10),
      cyl(0.08, 0.3, 0.59, 10).translate(0.36, 0, 0),
      ball(0.08, 0.36, 0.74, 0, 10),
    ]),

  // StreetStylePigeon, 0.201 x 0.289 x 0.327. Measured off the hologram shell,
  // because the bird's own mesh is skinned and the export dropped it — so this
  // one is a couple of centimetres generous, and is the only builder here whose
  // numbers are not the art's own.
  pigeon: () =>
    merge([
      place(ball(0.3, 0, 0, 0, 12), { s: [1.5, 1.1, 1.5], y: 0.42, z: -0.05 }),
      place(ball(0.22, 0, 0, 0, 12), { s: [1.2, 1.2, 1.2], y: 0.72, z: 0.22 }),
      place(cone(0.06, 0.14, 0, 0, 0, 8), { rx: Math.PI / 2, y: 0.7, z: 0.42 }),
      place(prism([[-0.2, 0], [0.2, 0], [0.1, 0.36]], 0.05), { rz: Math.PI, rx: 0.4, y: 0.45, z: -0.42 }),
      box(0.07, 0.12, 0.07, -0.13, 0.06, 0.05),
      box(0.07, 0.12, 0.07, 0.13, 0.06, 0.05),
    ]),

  // -- corrupted technology -------------------------------------------------
  // WireContainer, 0.554 x 0.718 x 0.534: a box with a rim at the bottom and
  // near the top, and a spool on the front face at z -0.30..-0.24.
  wireContainer: () =>
    merge([
      box(0.94, 1, 0.94, 0, 0.5, 0),
      box(1, 0.1, 1, 0, 0.05, 0),
      box(1, 0.1, 1, 0, 0.74, 0),
      box(0.98, 0.2, 0.98, 0, 0.9, 0),
      tube(0.17, 0.12, 'z', 0, 0.45, -0.53, 14),
      tube(0.09, 0.16, 'z', 0, 0.45, -0.55, 10),
    ]),

  // Console, 2.762 x 1.131 x 1.03 — wide and low, with a lip running round it
  // at y 0.45..0.56 and its origin well forward of the footprint centre.
  console: () =>
    merge([
      box(0.96, 0.4, 0.94, 0, 0.2, 0),
      box(1, 0.1, 1, 0, 0.45, 0),
      box(0.98, 0.3, 0.96, 0, 0.65, 0),
      place(box(0.9, 0.08, 0.5), { rx: -0.42, y: 0.86, z: 0.16 }),
      box(0.86, 0.1, 0.06, 0, 0.95, -0.4),
      box(0.12, 0.06, 0.1, -0.35, 0.83, 0.3),
      box(0.12, 0.06, 0.1, 0.35, 0.83, 0.3),
    ]),

  // Server, 0.771 x 1.443 x 1.12. A rack that is nearly full width all the way
  // up, with a cable run trailing off the back — traced as thin fragments from
  // z 0.29 out to 0.74.
  server: () => {
    const parts = [box(0.96, 1, 0.66, 0, 0.5, -0.15), box(1, 0.1, 0.68, 0, 0.9, -0.15)];
    for (let i = 0; i < 8; i++) {
      parts.push(box(0.8, 0.06, 0.04, 0, 0.12 + i * 0.1, 0.19));
      parts.push(box(0.05, 0.03, 0.03, 0.3, 0.12 + i * 0.1, 0.21));
    }
    parts.push(tube(0.04, 0.4, 'z', 0.22, 0.06, 0.4, 8));
    parts.push(tube(0.03, 0.3, 'z', 0.06, 0.05, 0.55, 8));
    return merge(parts);
  },

  // CentralStationCPU, 1.525 x 2.496 x 1.047. A plinth to y 1, widening to
  // 0.76 half-width, then a tall shaft at 0.66 for the top 1.5 m.
  centerStationCpu: () =>
    merge([
      box(0.94, 0.1, 0.9, 0, 0.05, 0),
      box(0.95, 0.1, 0.94, 0, 0.15, 0),
      box(1, 0.2, 1, 0, 0.3, 0),
      box(0.87, 0.6, 0.9, 0, 0.7, 0),
      ring(0.46, 0.03, 0, 0.42, 0, 10),
      cyl(0.3, 0.06, 0.995, 8),
      octa(0.2, 0, 0.62, 0),
    ]),

  // CoffeeMachine, 0.94 x 2.301 x 0.979. Nearly a full-height cabinet, with a
  // hopper on the right that steps out to x 0.50 above y 1.84 and a spout
  // reaching forward to z -0.18.
  coffeeMachine: () =>
    merge([
      box(0.94, 0.1, 0.86, 0, 0.05, 0),
      box(0.96, 0.6, 0.9, 0, 0.4, 0),
      box(0.98, 0.2, 0.94, 0, 0.8, 0),
      box(0.94, 0.1, 0.86, 0, 0.71, 0),
      box(0.96, 0.2, 0.9, 0, 0.99, 0),
      box(0.3, 0.16, 0.5, 0.3, 0.86, 0),
      box(0.6, 0.18, 0.24, 0, 0.34, -0.4),
      box(0.44, 0.05, 0.16, 0, 0.24, -0.44),
      box(0.5, 0.16, 0.05, 0, 0.62, -0.47),
    ]),

  // Recuperator, 0.973 x 0.664 x 0.294. Wall-mounted and shallow: feet at
  // x -0.37..-0.27 and 0.27..0.37, then a body that widens to the full 0.49
  // above y 0.2 and stays there.
  recuperator: () =>
    merge([
      box(0.2, 0.1, 0.7, -0.32, 0.05, 0),
      box(0.2, 0.1, 0.7, 0.32, 0.05, 0),
      box(0.82, 0.2, 0.86, 0, 0.2, 0),
      box(1, 0.7, 1, 0, 0.65, 0),
      ring(0.3, 0.04, 0, 0.65, 0, 16).scale(1, 1, 0.3),
      box(0.5, 0.08, 0.3, 0, 0.96, 0),
    ]),

  // SampleAnalysisMachineArena, 2.409 x 2.676 x 2.026. A wide base to y 0.27,
  // a 0.94-wide column up the middle the whole way, and gantry arms reaching
  // out to x -1.20 and 1.20 at two different heights.
  sampleAnalysis: () =>
    merge([
      box(0.57, 0.1, 0.68, 0, 0.05, 0),
      box(0.56, 0.5, 0.66, 0, 0.25, 0),
      box(0.39, 0.8, 0.46, 0, 0.6, 0),
      box(0.36, 0.4, 0.42, 0, 0.98, 0),
      box(0.1, 0.28, 0.4, -0.39, 0.3, 0),
      box(0.68, 0.1, 0.3, -0.34, 0.4, 0),
      box(0.46, 0.1, 0.3, -0.39, 0.65, 0),
      box(0.1, 0.35, 0.3, -0.25, 0.82, 0),
      box(0.19, 0.1, 0.3, 0.27, 0.25, 0),
      cyl(0.1, 0.1, 0.95, 12),
    ]),

  // -- vehicles -------------------------------------------------------------
  // Front toward +z on all three, so a row of them faces the same way.
  // Truck, 2.497 x 3.305 x 6.831 — long, and the cab is the tall end.
  truck: () => {
    const wheel = (x, z) => tube(0.14, 0.1, 'x', x, 0.14, z, 10);
    return merge([
      box(0.78, 0.34, 0.26, 0, 0.42, 0.34),
      box(0.72, 0.2, 0.06, 0, 0.55, 0.46),
      box(0.86, 0.5, 0.44, 0, 0.45, -0.22),
      box(0.9, 0.06, 0.46, 0, 0.72, -0.22),
      box(0.92, 0.12, 0.96, 0, 0.2, 0),
      box(0.8, 0.06, 0.2, 0, 0.62, 0.44),
      wheel(-0.45, 0.28), wheel(0.45, 0.28),
      wheel(-0.45, -0.3), wheel(0.45, -0.3),
    ]);
  },

  // Chopper, 7.42 x 3.149 x 6.588. The rotor disc is what makes the footprint
  // that wide, so it has to be in the silhouette or the size looks wrong.
  chopper: () =>
    merge([
      place(ball(0.3, 0, 0, 0, 12), { s: [0.5, 0.9, 0.9], y: 0.4, z: 0.12 }),
      box(0.1, 0.12, 0.5, 0, 0.45, -0.28),
      box(0.04, 0.28, 0.1, 0, 0.6, -0.5),
      tube(0.03, 0.2, 'x', 0, 0.6, -0.5, 8),
      cyl(0.04, 0.12, 0.86, 8),
      tube(0.015, 0.98, 'x', 0, 0.95, 0.1, 6),
      tube(0.015, 0.98, 'z', 0, 0.95, 0.1, 6),
      box(0.04, 0.16, 0.04, -0.2, 0.1, 0.12),
      box(0.04, 0.16, 0.04, 0.2, 0.1, 0.12),
      tube(0.025, 0.5, 'z', -0.2, 0.025, 0.1, 8),
      tube(0.025, 0.5, 'z', 0.2, 0.025, 0.1, 8),
    ]),

  // Tank, 3.971 x 3.364 x 6.477.
  tank: () => {
    const parts = [
      box(0.8, 0.18, 0.9, 0, 0.28, 0),
      prism([[-0.4, 0], [0.4, 0], [0.4, 0.1], [-0.18, 0.17], [-0.4, 0.1]], 0.88, 0, 0.37, 0)
        .rotateY(Math.PI / 2),
      cyl(0.26, 0.16, 0.6, 10),
      box(0.3, 0.12, 0.3, 0, 0.66, 0.05),
      tube(0.04, 0.56, 'z', 0, 0.62, 0.46, 10),
      cyl(0.07, 0.05, 0.76, 8),
    ];
    for (const sx of [-1, 1]) {
      parts.push(box(0.14, 0.26, 0.96, sx * 0.42, 0.13, 0));
      for (let i = 0; i < 4; i++) parts.push(tube(0.09, 0.16, 'x', sx * 0.42, 0.12, -0.32 + i * 0.21, 8));
    }
    return merge(parts);
  },

  // -- crystals -------------------------------------------------------------
  // Crystal03, 1.001 x 1.65 x 0.903: one tall shard leaning left, with shorter
  // ones clustered round its foot.
  crystalSmall: () => {
    const shard = (h, w, tilt, x, z) => {
      const g = merge([
        prism([[-w, 0], [w, 0], [w * 0.55, h], [-w * 0.55, h]], w * 1.5),
        cone(w * 0.8, h * 0.22, 0, h, 0, 4),
      ]);
      return place(g, { rz: tilt, x, z });
    };
    return merge([
      shard(0.95, 0.11, 0.1, -0.18, -0.02),
      shard(0.45, 0.09, -0.22, 0.16, 0.06),
      shard(0.3, 0.07, 0.3, -0.02, 0.22),
      shard(0.24, 0.06, -0.1, 0.3, -0.2),
      cyl(0.34, 0.05, 0.025, 12),
    ]);
  },

  // Crystal02, 1.611 x 1.205 x 1.364: a ring of shards round a low base, all
  // leaning outward. The traced bands show material out to x +/-0.8 low down
  // and only a single shard surviving above y 0.95.
  crystalCircle: () => {
    const parts = [cyl(0.4, 0.06, 0.03, 16)];
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const h = 0.45 + (i % 3) * 0.16;
      const shard = merge([
        prism([[-0.07, 0], [0.07, 0], [0.04, h], [-0.04, h]], 0.11),
        cone(0.055, 0.14, 0, h, 0, 4),
      ]);
      place(shard, { rz: 0.28 });
      shard.rotateY(-a);
      shard.translate(Math.cos(a) * 0.22, 0.02, Math.sin(a) * 0.22);
      parts.push(shard);
    }
    const tall = merge([
      prism([[-0.06, 0], [0.06, 0], [0.03, 0.9], [-0.03, 0.9]], 0.1),
      cone(0.05, 0.1, 0, 0.9, 0, 4),
    ]);
    parts.push(place(tall, { rz: -0.12, x: 0.28, z: -0.06 }));
    return merge(parts);
  },

  // Crystal01, 1.831 x 0.994 x 1.152: a low spread, wider than it is tall,
  // with the shards fanning out to both sides from a slab.
  crystalHalf: () => {
    const parts = [box(0.86, 0.08, 0.5, 0, 0.04, 0)];
    const at = [[-0.36, -0.08, 0.85, 0.4], [-0.2, 0.14, 0.55, -0.24], [0.02, -0.16, 0.4, 0.18],
      [0.22, 0.1, 0.7, -0.36], [0.38, -0.02, 0.5, 0.28]];
    for (const [x, z, h, tilt] of at) {
      const shard = merge([
        prism([[-0.08, 0], [0.08, 0], [0.045, h], [-0.045, h]], 0.13),
        cone(0.065, 0.15, 0, h, 0, 4),
      ]);
      parts.push(place(shard, { rz: tilt, x, y: 0.03, z }));
    }
    return merge(parts);
  },

  // -- gameplay objects -----------------------------------------------------
  // Minigun, 0.643 x 0.501 x 1.206 — long in z, and the barrels are most of
  // that length: the plan puts material out to z -0.71 at only 0.12 half-width.
  minigun: () => {
    const parts = [
      box(0.3, 0.35, 0.3, 0, 0.3, 0.28),
      box(0.5, 0.3, 0.34, 0, 0.55, 0.1),
      box(0.24, 0.24, 0.2, 0, 0.62, -0.16),
      cyl(0.16, 0.5, 0.25, 10),
      box(0.66, 0.14, 0.24, 0, 0.5, 0.24),
    ];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      parts.push(tube(0.03, 0.42, 'z', Math.cos(a) * 0.07, 0.62 + Math.sin(a) * 0.07, -0.4, 6));
    }
    return merge(parts);
  },

  // ExplosiveBarrel, 0.61 x 0.81 x 0.61 — a barrel, so it shares the shape and
  // gains the collar and cap that tell it apart from the street one.
  explosiveBarrel: () =>
    merge([
      cyl(0.46, 0.88, 0.48, 20),
      cyl(0.5, 0.08, 0.04, 20),
      cyl(0.48, 0.06, 0.93, 20),
      ring(0.48, 0.03, 0, 0.28, 0, 20),
      ring(0.48, 0.03, 0, 0.68, 0, 20),
      cyl(0.12, 0.06, 0.97, 10),
      box(0.16, 0.3, 0.04, 0, 0.5, 0.47),
      box(0.3, 0.16, 0.04, 0, 0.5, 0.47),
    ]),

  // Jumbotron, 1 x 1 x 0.057. A flat panel — it hangs in the air, so there is
  // no floor detail and nothing to it but a screen in a frame.
  jumbotron: () =>
    merge([
      box(1, 1, 1, 0, 0.5, 0),
      box(0.88, 0.86, 1.3, 0, 0.5, 0),
      box(1, 0.08, 1.6, 0, 0.96, 0),
    ]),

  // DamageBox, 1 x 1 x 1. An open frame on purpose: it marks a volume you have
  // to see into, and the catalog draws it translucent on top of that.
  damageBox: () => {
    const t = 0.055;
    const parts = [];
    for (const sy of [t / 2, 1 - t / 2]) {
      for (const sz of [-0.5 + t / 2, 0.5 - t / 2]) parts.push(box(1, t, t, 0, sy, sz));
      for (const sx of [-0.5 + t / 2, 0.5 - t / 2]) parts.push(box(t, t, 1 - 2 * t, sx, sy, 0));
    }
    for (const sx of [-0.5 + t / 2, 0.5 - t / 2]) {
      for (const sz of [-0.5 + t / 2, 0.5 - t / 2]) parts.push(box(t, 1 - 2 * t, t, sx, 0.5, sz));
    }
    parts.push(octa(0.16, 0, 0.5, 0));
    return merge(parts);
  },

  // WeaponSpawnPoint, 0.449 x 0.344 x 0.222 — small, and mostly the plinth.
  // One entry covers all ten weapons, so the thing floating over it is a
  // generic marker rather than any particular gun.
  spawnAll: () =>
    merge([
      ...pedestal(),
      octa(0.2, 0, 0.68, 0),
      ring(0.26, 0.025, 0, 0.68, 0, 14),
      place(new THREE.TorusGeometry(0.26, 0.025, 8, 14).toNonIndexed(), { y: 0.68 }),
    ]),

  // -- mode objectives ------------------------------------------------------
  // PlayerSpawnZoneTeam1, 1.202 x 2.863 x 1.392. Most of that height is the
  // machine standing at the edge of the zone; the zone itself is the pad. The
  // catalog's `area` handles the volume, so this is the furniture.
  spawnZone: () =>
    merge([
      ...zonePad(0.46, 0.5),
      cone(0.16, 0.3, 0, 0.68, 0, 4).rotateY(Math.PI / 4),
      cyl(0.05, 0.68, 0.34, 8),
    ]),

  // A, B and C get one, two and three rings so they stay apart at a glance.
  // The prefabs themselves trace to 2 x 0 x 2 — a single flat quad carrying a
  // ring texture — so there is no geometry to copy and the marker is designed.
  dominationZoneA: () => dominationZone(1),
  dominationZoneB: () => dominationZone(2),
  dominationZoneC: () => dominationZone(3),

  // CaptureFlagSpawnPointTeam1 and Team2, 0.637 x 2.15 x 0.2.
  //
  // These two prefabs hold **no meshes at all**: the flag is built at runtime,
  // which is why looking for a flag model finds nothing. What they do hold is a
  // rig, and a rig is measurable — every number below is off the prefab's own
  // nodes rather than eyeballed:
  //
  //   Outline      a box from y = 0 to 2.15, 0.2 across in x and z: the pole
  //   MidCollider  0.2 x 2.2 x 0.2 at y = 1.1, agreeing with it
  //   FlagFloat    y = 0.8, and FlagBase 0.993 above it -> the cloth hangs from
  //                y = 1.793
  //   FlagBase -> FlagMiddle1 -> FlagMiddle2 -> FlagEnd, three horizontal bone
  //                offsets of 0.162, 0.184 and 0.191 -> the cloth reaches
  //                0.537 m from the pole, and those are the stations the game's
  //                own cloth waves about, so they are the stations used here
  //
  // Two things are not measurable and come from the library icon
  // (Icon_OrangeTeamFlag / Icon_PurpleTeamFlag) instead: how far the cloth
  // hangs, and the swallowtail notch cut into its trailing edge. The notch is
  // the whole reason this reads as a flag from across the arena rather than as
  // a signpost, which the previous stand-in — a 0.44 m pennant on a 0.9 m stick
  // — did not.
  //
  // The cell is not square (0.637 wide against 0.2 deep), so anything round has
  // to be authored as the ellipse that comes out circular, and anything turned
  // in the XZ plane would shear. Hence the local helpers.
  flagSpawn: () => {
    const W = 0.637, H = 2.15, D = 0.2, A = 0.157;   // must match the catalog
    const cx = (m) => m / W - 0.5 + A;               // metres from the pole -> cell x
    const cy = (m) => m / H;
    const cz = (m) => m / D;
    /** An upright round post of radius `r` metres, `h` tall, standing at `y`. */
    const post = (r, h, y, seg = 12) =>
      place(cyl(1, cy(h), 0, seg), { s: [r / W, 1, r / D], x: cx(0), y: cy(y + h / 2) });

    return merge([
      // Foot: the 0.2 m square the collider claims, drawn as the disc it reads
      // as. Nothing in the prefab says there is a base — but an objective you
      // drag around wants a visible footprint, and this is exactly the one the
      // game reserves for it.
      post(0.1, 0.05, 0),
      post(0.03, 2.15, 0),          // the pole itself, full height
      post(0.045, 0.06, 2.06),      // a collar under the tip, so it reads as a pole
      flagCloth(cx, cy, cz),
    ]);
  },

  // EnemySpawnPoint, 1.061 x 0.289 x 1.059 — a flat ring on the floor with a
  // low marker, not the tall pillar it used to be drawn as.
  enemySpawn: () =>
    merge([
      ring(0.44, 0.05, 0, 0.16, 0, 20),
      cyl(0.38, 0.06, 0.03, 20),
      prism([[-0.26, 0.3], [0, 0], [0.26, 0.3], [0.26, 0.52], [0, 0.22], [-0.26, 0.52]], 0.06, 0, 0.3, 0),
      cyl(0.05, 0.2, 0.6, 8),
    ]),

  // Deliberately odd so an unrecognised type is impossible to mistake.
  unknown: () => octa(0.5, 0, 0.5, 0),
};

/**
 * The cloth half of the capture flag, as a waving sheet.
 *
 * The one thing in this file that is a surface rather than an assembly of
 * solids, because a flag is a surface: boxes and prisms can make a pennant, not
 * something that reads as cloth at ten metres. Parameterised by u along the
 * flag and v down it, both running 0 to 1, and evaluated in metres before the
 * caller's cell mapping is applied.
 *
 *   u  0 at the pole, 1 at the free end 0.537 m out — the prefab's own bone
 *      chain — waving in z, held still where it meets the pole
 *   v  0 at the top edge, where FlagBase hangs it at y = 1.793, and 1 at the
 *      bottom 0.55 m below, which the icon gives rather than the rig
 *
 * The trailing edge is cut back in the middle and full at the corners: the
 * swallowtail both team icons have.
 *
 * Emitted twice, a few millimetres either side of the surface and wound the
 * other way round, so the flag is solid whichever side you are standing on.
 * geometryFor recomputes the normals afterwards, so only the winding matters.
 */
function flagCloth(cx, cy, cz) {
  const REACH = 0.537, TOP = 1.793, DROP = 0.55, NOTCH = 0.22, WAVE = 0.055;
  const NU = 10, NV = 6, SKIN = 0.008;

  const at = (i, j, side) => {
    const v = j / NV;
    const u = (i / NU) * (1 - NOTCH * (1 - Math.abs(2 * v - 1)));
    const z = WAVE * u * Math.sin(u * Math.PI * 2.1);   // the wave grows with reach
    const y = TOP - DROP * v - 0.09 * u * v;            // and the free end sags
    return [cx(REACH * u), cy(y), cz(z + side * SKIN)];
  };

  const pos = [];
  const tri = (a, b, c) => pos.push(...a, ...b, ...c);
  for (const side of [1, -1]) {
    for (let i = 0; i < NU; i++) {
      for (let j = 0; j < NV; j++) {
        const a = at(i, j, side), b = at(i + 1, j, side);
        const c = at(i + 1, j + 1, side), d = at(i, j + 1, side);
        if (side > 0) { tri(a, d, c); tri(a, c, b); } else { tri(a, b, c); tri(a, c, d); }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  g.computeVertexNormals();
  return g;
}

function dominationZone(rings) {
  const parts = zonePad(0.44, 0.42, 3);
  parts.push(cyl(0.05, 0.9, 0.45, 8));
  for (let i = 0; i < rings; i++) parts.push(ring(0.17, 0.03, 0, 0.62 + i * 0.13, 0, 14));
  parts.push(cone(0.1, 0.16, 0, 0.9, 0, 6));
  return merge(parts);
}

/**
 * Geometry for a catalog definition, scaled to its size and pivoted correctly.
 * Cached: every Crate in the map shares one BufferGeometry.
 */
export function geometryFor(def) {
  const anchor = def.anchor || [0.5, 0.5];
  const key = `${def.shape}|${def.size.join(',')}|${def.pivot}|${anchor.join(',')}`;
  if (cache.has(key)) return cache.get(key);

  const build = builders[def.shape] || builders.unknown;
  let g;
  try {
    g = build();
  } catch (err) {
    console.warn(`Placeholder "${def.shape}" failed to build, falling back.`, err);
    g = builders.unknown();
  }
  // Make the mesh exactly one cell tall, sitting exactly on the cell floor,
  // whatever the builder happened to author. Floor lock drops a selection so
  // its bounding box rests on y = 0, so a placeholder that misses the floor by
  // a centimetre would shift the object every time it is edited — and write
  // that shift into the exported map.
  g.computeBoundingBox();
  const { min, max } = g.boundingBox;
  const span = max.y - min.y;
  g.translate(0, -min.y, 0);
  if (span > 0 && Math.abs(span - 1) > 1e-9) g.scale(1, 1 / span, 1);

  const [w, h, d] = def.size;
  g.scale(w, h, d);
  if (def.pivot === 'center') g.translate(0, -h / 2, 0);
  // Where the object's origin sits inside its own footprint. Almost everything
  // is centred, but the corner barriers are not: their origin is in the corner
  // where the two arms meet, 44 cm from the middle of the box. `scene.js` only
  // ever corrects a loaded prefab's Y, so the real mesh keeps that offset — and
  // a placeholder centred in X and Z would sit half a metre from where the game
  // draws the same object.
  if (anchor[0] !== 0.5 || anchor[1] !== 0.5) {
    g.translate((0.5 - anchor[0]) * w, 0, (0.5 - anchor[1]) * d);
  }
  g.computeVertexNormals();
  g.computeBoundingBox();
  cache.set(key, g);
  return g;
}

/** Local-space bounding box of the unscaled placeholder. */
export function localBox(def) {
  return geometryFor(def).boundingBox;
}

/** Every shape id the module can build, for checking the catalog against. */
export function shapeIds() {
  return Object.keys(builders);
}

export function clearGeometryCache() {
  for (const g of cache.values()) g.dispose();
  cache.clear();
}
