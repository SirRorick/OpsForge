// ---------------------------------------------------------------------------
// Placeholder geometry
// ---------------------------------------------------------------------------
// Stand-ins until the real .glb assets arrive. Each builder returns a single
// merged BufferGeometry authored to exactly the catalog `size`, with the origin
// where the catalog `pivot` says it is, so that applying the Unity scale
// straight to the mesh gives correct world dimensions.
//
// Every builder authors inside a unit cell: x and z run -0.5 to 0.5, y runs
// 0 to 1 with the base on the floor. `geometryFor` then stretches that cell to
// the catalog size, so a builder only has to get the silhouette right, never
// the dimensions. The point is recognising a piece at a glance in the library
// and in the viewport, not modelling it.
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

function octa(r, x = 0, y = 0, z = 0) {
  const g = new THREE.OctahedronGeometry(r, 0);
  g.translate(x, y, z);
  return g.toNonIndexed();
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

/** Upright panel with end posts: the shape every barrier is a variation of. */
function panel(h, t = 0.16, y0 = 0) {
  return [
    box(1, h * 0.88, t * 0.62, 0, y0 + h * 0.5, 0),
    box(1, h * 0.1, t, 0, y0 + h * 0.06, 0),
    box(0.09, h, t, -0.455, y0 + h * 0.5, 0),
    box(0.09, h, t, 0.455, y0 + h * 0.5, 0),
  ];
}

/** Low plinth every weapon spawn point stands on. */
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

// -- builders ---------------------------------------------------------------

const builders = {
  // -- primitives -----------------------------------------------------------
  box: () => box(1, 1, 1, 0, 0.5, 0),

  cylinder: () => cyl(0.5, 1, 0.5),

  // Slab with a capping band, so a wall reads differently from a solid box.
  wall: () => merge([box(1, 0.94, 1, 0, 0.47, 0), box(1, 0.06, 1.25, 0, 0.97, 0)]),

  // -- barriers -------------------------------------------------------------
  // Waist-high rail rather than a solid slab: reads as cover you shoot over.
  barrierLow: () =>
    merge([
      box(1, 0.24, 0.62, 0, 0.88, 0),
      box(1, 0.16, 0.5, 0, 0.42, 0),
      box(1, 0.12, 1, 0, 0.06, 0),
      box(0.1, 1, 1, -0.45, 0.5, 0),
      box(0.1, 1, 1, 0.45, 0.5, 0),
    ]),

  barrierFull: () => merge(panel(1)),

  // Same slab with a letterbox opening in the upper half.
  barrierWindow: () => {
    const t = 0.62;
    return merge([
      box(1, 0.46, t, 0, 0.23, 0),
      box(1, 0.14, t, 0, 0.93, 0),
      box(0.16, 0.4, t, -0.42, 0.66, 0),
      box(0.16, 0.4, t, 0.42, 0.66, 0),
      box(0.09, 1, 1, -0.455, 0.5, 0),
      box(0.09, 1, 1, 0.455, 0.5, 0),
    ]);
  },

  // Two panels meeting at a right angle, occupying the -x / -z quadrant edges.
  // An L in plan, wrapping the +x/+z corner, with the two arms running along
  // the +z and +x edges. Read off the real mesh rather than guessed: sampling
  // BarrierCorner90_LOD0's vertices leaves the -x/-z quadrant completely empty,
  // and the object's origin sits at the corner where the arms meet, not in the
  // middle of the footprint. The old builder put the corner diagonally opposite
  // and centred it, which read as a piece rotated 180 degrees and sitting 44 cm
  // from where the game puts it.
  barrierCorner: () => {
    const t = 0.12;
    return merge([
      box(1, 1, t, 0, 0.5, 0.5 - t / 2),
      box(t, 1, 1 - t, 0.5 - t / 2, 0.5, -t / 2),
      box(0.1, 1.04, 0.1, 0.45, 0.52, 0.45),
    ]);
  },

  // Not a U in plan: a single flat panel with a horseshoe cut out of it, which
  // is what Icon_BarrierUWall draws and what the 1.03 x 0.26 m footprint says.
  // The old builder made a three-sided enclosure a metre deep.
  barrierU: () => {
    const t = 0.12;
    const jamb = 0.26;          // solid either side of the opening
    return merge([
      box(jamb, 1, t, -(0.5 - jamb / 2), 0.5, 0),
      box(jamb, 1, t, 0.5 - jamb / 2, 0.5, 0),
      box(1, 0.34, t, 0, 0.83, 0),          // lintel over the opening
      box(1, 0.12, t, 0, 0.06, 0),          // sill under it
    ]);
  },

  // Two panels crossing at the centre: cover from all four sides.
  barrierX: () => {
    const t = 0.12;
    return merge([
      box(1, 1, t, 0, 0.5, 0),
      box(t, 1, 1, 0, 0.5, 0),
      box(0.14, 1.04, 0.14, 0, 0.52, 0),
    ]);
  },

  // Flat back with a bowed front, the plan view of a capital D.
  barrierD: () => {
    const t = 0.14;
    return merge([
      box(1, 1, t, 0, 0.5, -0.5 + t / 2),
      place(halfCyl(0.5, 0.96, 0.48), { z: -0.5 + t }),
      box(0.1, 1.03, 0.1, -0.45, 0.515, -0.45),
      box(0.1, 1.03, 0.1, 0.45, 0.515, -0.45),
    ]);
  },

  // A long leg and a short one: the corner piece with an overhang.
  barrierL: () => {
    const t = 0.12;
    return merge([
      box(1, 1, t, 0, 0.5, -0.5 + t / 2),
      box(t, 1, 0.55, -0.5 + t / 2, 0.5, -0.2),
      box(0.11, 1.04, 0.11, -0.45, 0.52, -0.45),
    ]);
  },

  // Wedge you can run up, high edge at -z. The triangle is authored in XY and
  // swung a quarter turn so the extrusion runs across x and the rise along z.
  barrierSlope: () =>
    merge([
      place(prism([[-0.5, 0], [0.5, 0], [0.5, 0.94]], 1), { ry: Math.PI / 2 }),
      box(1, 0.06, 0.14, 0, 0.97, -0.43),
    ]),

  // Wall with a rectangular opening: two jambs and a lintel.
  barrierDoorway: () =>
    merge([
      box(0.3, 1, 1, -0.35, 0.5, 0),
      box(0.3, 1, 1, 0.35, 0.5, 0),
      box(1, 0.22, 1, 0, 0.89, 0),
      box(1, 0.06, 1.2, 0, 0.99, 0),
    ]),

  // Saloon doors: two short leaves with a gap above and below.
  barrierDoor: () =>
    merge([
      box(0.09, 1, 0.9, -0.455, 0.5, 0),
      box(0.09, 1, 0.9, 0.455, 0.5, 0),
      box(1, 0.1, 0.9, 0, 0.95, 0),
      box(0.42, 0.62, 0.5, -0.22, 0.44, 0),
      box(0.42, 0.62, 0.5, 0.22, 0.44, 0),
    ]),

  // Panel with the top corner blown out.
  barrierBroken: () =>
    merge([
      box(0.56, 1, 0.6, -0.22, 0.5, 0),
      box(0.44, 0.62, 0.6, 0.28, 0.31, 0),
      box(0.18, 0.14, 0.62, 0.13, 0.69, 0),
      box(0.1, 1, 1, -0.45, 0.5, 0),
      box(0.1, 0.6, 1, 0.45, 0.3, 0),
    ]),

  // -- structures -----------------------------------------------------------
  pillar: () =>
    merge([
      box(1, 0.08, 1, 0, 0.04, 0),
      box(0.82, 0.06, 0.82, 0, 0.11, 0),
      box(0.68, 0.78, 0.68, 0, 0.53, 0),
      box(0.86, 0.07, 0.86, 0, 0.95, 0),
      box(1, 0.05, 1, 0, 0.985, 0),
    ]),

  // Two legs and a lintel: a readable walk-through arch.
  tunnel: () => {
    const leg = 0.22;
    return merge([
      box(leg, 0.78, 1, -0.5 + leg / 2, 0.39, 0),
      box(leg, 0.78, 1, 0.5 - leg / 2, 0.39, 0),
      box(1, 0.22, 1, 0, 0.89, 0),
    ]);
  },

  // -- props ----------------------------------------------------------------
  // Shell plus corner battens.
  crate: () => {
    const parts = [box(0.94, 0.94, 0.94, 0, 0.5, 0)];
    const e = 0.47;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) parts.push(box(0.1, 1, 0.1, sx * e, 0.5, sz * e));
    }
    parts.push(box(1, 0.09, 0.09, 0, 0.5, -e), box(1, 0.09, 0.09, 0, 0.5, e));
    return merge(parts);
  },

  // Same crate with diagonal bracing across the faces.
  crateBig: () => {
    const parts = [box(0.94, 0.94, 0.94, 0, 0.5, 0)];
    const e = 0.47;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) parts.push(box(0.12, 1, 0.12, sx * e, 0.5, sz * e));
    }
    for (const sz of [-1, 1]) {
      for (const dir of [1, -1]) {
        parts.push(place(box(1.24, 0.08, 0.06), { rz: (dir * Math.PI) / 4, y: 0.5, z: sz * e }));
      }
    }
    parts.push(box(1, 0.1, 1.02, 0, 0.97, 0));
    return merge(parts);
  },

  // Planked crate with one board sprung loose.
  crateDestructible: () => {
    const parts = [box(0.9, 0.94, 0.9, 0, 0.5, 0)];
    for (const y of [0.16, 0.5, 0.84]) parts.push(box(1, 0.2, 0.98, 0, y, 0));
    parts.push(place(box(1, 0.18, 0.14), { rx: -0.35, y: 0.84, z: 0.52 }));
    for (const sx of [-1, 1]) parts.push(box(0.1, 1, 1, sx * 0.45, 0.5, 0));
    return merge(parts);
  },

  electricityBox: () =>
    merge([
      box(1, 0.9, 1, 0, 0.45, 0),
      box(0.7, 0.12, 0.2, 0, 0.95, 0.1),
      box(0.24, 0.3, 0.12, 0, 0.5, 0.56),
    ]),

  barrel: () =>
    merge([
      cyl(0.46, 1, 0.5, 18),
      ring(0.48, 0.035, 0, 0.26),
      ring(0.48, 0.035, 0, 0.74),
      cyl(0.34, 0.05, 1.0, 14),
    ]),

  sofa: () =>
    merge([
      box(1, 0.34, 0.9, 0, 0.36, 0.02),
      box(1, 0.56, 0.24, 0, 0.62, -0.38),
      box(0.16, 0.34, 0.9, -0.42, 0.66, 0.02),
      box(0.16, 0.34, 0.9, 0.42, 0.66, 0.02),
      box(0.4, 0.16, 0.7, -0.24, 0.6, 0.05),
      box(0.4, 0.16, 0.7, 0.24, 0.6, 0.05),
      ...[-0.4, 0.4].flatMap((x) => [-0.34, 0.34].map((z) => box(0.08, 0.2, 0.08, x, 0.1, z))),
    ]),

  cushion: () =>
    merge([
      box(0.92, 0.8, 0.92, 0, 0.5, 0),
      box(1, 0.5, 0.24, 0, 0.5, 0),
      box(0.24, 0.5, 1, 0, 0.5, 0),
    ]),

  ottoman: () =>
    merge([
      cyl(0.48, 0.72, 0.42, 18),
      cyl(0.44, 0.1, 0.82, 18),
      ...[0, 1, 2, 3].map((i) => {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        return box(0.08, 0.16, 0.08, Math.cos(a) * 0.34, 0.08, Math.sin(a) * 0.34);
      }),
    ]),

  pigeon: () =>
    merge([
      place(ball(0.3), { s: [1, 0.9, 1.5], y: 0.5, z: -0.02 }),
      ball(0.19, 0, 0.78, 0.24),
      place(cone(0.07, 0.16), { rx: Math.PI / 2, y: 0.76, z: 0.44 }),
      place(prism([[-0.16, 0], [0.16, 0], [0, 0.3]], 0.04), { rz: Math.PI, rx: 0.5, y: 0.5, z: -0.4 }),
      box(0.09, 0.24, 0.09, -0.1, 0.12, 0),
      box(0.09, 0.24, 0.09, 0.1, 0.12, 0),
    ]),

  cacti: () =>
    merge([
      cyl(0.22, 1, 0.5, 12),
      ball(0.22, 0, 1, 0),
      tube(0.15, 0.42, 'x', -0.28, 0.52, 0),
      cyl(0.15, 0.34, 0.68, 10).translate(-0.48, 0, 0),
      ball(0.15, -0.48, 0.85, 0),
      tube(0.13, 0.3, 'x', 0.24, 0.68, 0),
      cyl(0.13, 0.22, 0.8, 10).translate(0.38, 0, 0),
      ball(0.13, 0.38, 0.91, 0),
    ]),

  // -- corrupted technology -------------------------------------------------
  wireContainer: () => {
    const parts = [box(1, 0.1, 1, 0, 0.05, 0), box(1, 0.08, 1, 0, 0.96, 0)];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) parts.push(box(0.09, 1, 0.09, sx * 0.455, 0.5, sz * 0.455));
    }
    parts.push(tube(0.3, 0.5, 'x', 0, 0.44, 0, 16));
    parts.push(tube(0.34, 0.06, 'x', -0.25, 0.44, 0, 16));
    parts.push(tube(0.34, 0.06, 'x', 0.25, 0.44, 0, 16));
    return merge(parts);
  },

  console: () =>
    merge([
      box(1, 0.5, 0.8, 0, 0.25, 0),
      prism([[-0.5, 0], [0.5, 0], [0.5, 0.16], [-0.5, 0.16]], 0.6, 0, 0, 0).rotateX(-0.5).translate(0, 0.56, 0.06),
      box(0.86, 0.44, 0.06, 0, 0.78, -0.3),
      box(0.76, 0.34, 0.02, 0, 0.78, -0.26),
      box(0.16, 0.08, 0.1, -0.3, 0.54, 0.3),
      box(0.16, 0.08, 0.1, 0.3, 0.54, 0.3),
    ]),

  server: () => {
    const parts = [box(1, 1, 1, 0, 0.5, 0), box(1.04, 0.06, 1.04, 0, 0.03, 0)];
    for (let i = 0; i < 7; i++) {
      parts.push(box(0.84, 0.07, 0.06, 0, 0.14 + i * 0.115, 0.5));
      parts.push(box(0.06, 0.03, 0.04, 0.32, 0.14 + i * 0.115, 0.53));
    }
    return merge(parts);
  },

  centerStationCpu: () =>
    merge([
      cyl(0.5, 0.12, 0.06, 8),
      cyl(0.3, 0.34, 0.28, 8),
      box(0.56, 0.44, 0.56, 0, 0.68, 0),
      octa(0.3, 0, 0.68, 0),
      ring(0.44, 0.03, 0, 0.68, 0, 8),
      cyl(0.14, 0.08, 0.94, 8),
    ]),

  coffeeMachine: () =>
    merge([
      box(0.9, 0.98, 0.9, 0, 0.5, 0),
      box(0.66, 0.3, 0.3, 0, 0.36, 0.42),
      box(0.5, 0.06, 0.24, 0, 0.22, 0.45),
      cyl(0.14, 0.16, 0.24, 12).translate(0, 0, 0.42),
      box(0.6, 0.24, 0.06, 0, 0.82, 0.46),
      box(0.16, 0.16, 0.06, 0.28, 0.56, 0.47),
    ]),

  recuperator: () =>
    merge([
      cyl(0.5, 0.1, 0.05, 16),
      cyl(0.38, 0.72, 0.46, 16),
      ring(0.42, 0.04, 0, 0.3),
      ring(0.42, 0.04, 0, 0.62),
      ball(0.38, 0, 0.82).scale(1, 0.7, 1),
      cyl(0.1, 0.14, 1.0, 10),
      tube(0.07, 0.5, 'x', 0, 0.46, 0.4),
    ]),

  sampleAnalysis: () =>
    merge([
      box(1, 0.62, 1, 0, 0.31, 0),
      box(0.88, 0.06, 0.88, 0, 0.65, 0),
      cyl(0.3, 0.3, 0.8, 16),
      ball(0.3, 0, 0.96).scale(1, 0.6, 1),
      box(0.34, 0.26, 0.06, -0.28, 0.44, 0.5),
      box(0.2, 0.2, 0.06, 0.3, 0.44, 0.5),
    ]),

  // -- vehicles -------------------------------------------------------------
  // Front toward +z on all three, so a row of them faces the same way.
  truck: () => {
    const wheel = (x, z) => tube(0.16, 0.14, 'x', x, 0.16, z, 10);
    return merge([
      box(0.76, 0.44, 0.5, 0, 0.42, 0.24),
      box(0.7, 0.26, 0.12, 0, 0.56, 0.44),
      box(0.84, 0.56, 0.62, 0, 0.5, -0.24),
      box(0.88, 0.08, 0.66, 0, 0.8, -0.24),
      box(0.9, 0.12, 1, 0, 0.2, 0),
      wheel(-0.44, 0.3), wheel(0.44, 0.3),
      wheel(-0.44, -0.32), wheel(0.44, -0.32),
    ]);
  },

  chopper: () =>
    merge([
      ball(0.3, 0, 0.55, 0.22).scale(0.9, 0.85, 1.5),
      box(0.16, 0.16, 0.5, 0, 0.6, -0.3),
      box(0.06, 0.36, 0.16, 0, 0.72, -0.5),
      tube(0.04, 0.3, 'x', 0, 0.72, -0.5, 8),
      cyl(0.05, 0.14, 0.82, 8),
      tube(0.02, 1, 'x', 0, 0.9, 0.2, 6),
      tube(0.02, 1, 'z', 0, 0.9, 0.2, 6),
      box(0.06, 0.22, 0.06, -0.3, 0.14, 0.2),
      box(0.06, 0.22, 0.06, 0.3, 0.14, 0.2),
      tube(0.035, 0.7, 'z', -0.3, 0.035, 0.15, 8),
      tube(0.035, 0.7, 'z', 0.3, 0.035, 0.15, 8),
    ]),

  tank: () => {
    const parts = [
      box(0.82, 0.24, 0.92, 0, 0.3, 0),
      prism([[-0.41, 0], [0.41, 0], [0.41, 0.12], [-0.2, 0.2], [-0.41, 0.12]], 0.9, 0, 0.42, 0)
        .rotateY(Math.PI / 2),
      cyl(0.28, 0.2, 0.62, 10),
      box(0.34, 0.16, 0.34, 0, 0.7, 0.06),
      tube(0.05, 0.62, 'z', 0, 0.66, 0.5, 10),
      cyl(0.09, 0.06, 0.84, 8),
    ];
    for (const sx of [-1, 1]) {
      parts.push(box(0.16, 0.3, 1, sx * 0.42, 0.15, 0));
      for (let i = 0; i < 4; i++) parts.push(tube(0.1, 0.19, 'x', sx * 0.42, 0.14, -0.33 + i * 0.22, 8));
    }
    return merge(parts);
  },

  // -- crystals -------------------------------------------------------------
  crystalSmall: () =>
    merge([
      prism([[-0.16, 0], [0.16, 0], [0.1, 0.7], [-0.1, 0.7]], 0.26, 0, 0, 0),
      cone(0.13, 0.32, 0, 0.84, 0, 4),
      place(prism([[-0.1, 0], [0.1, 0], [0, 0.44]], 0.14), { rz: 0.35, x: -0.2, y: 0.035, z: 0.08 }),
      cyl(0.3, 0.05, 0.025, 10),
    ]),

  crystalCircle: () => {
    const parts = [ring(0.36, 0.05, 0, 0.051), cyl(0.36, 0.03, 0.015, 20)];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const h = 0.55 + (i % 3) * 0.18;
      const shard = merge([
        prism([[-0.09, 0], [0.09, 0], [0.05, h], [-0.05, h]], 0.14),
        cone(0.07, 0.18, 0, h, 0, 4),
      ]);
      shard.rotateY(a);
      shard.translate(Math.cos(a) * 0.32, 0, Math.sin(a) * 0.32);
      parts.push(shard);
    }
    return merge(parts);
  },

  crystalHalf: () => {
    const parts = [];
    for (let i = 0; i < 4; i++) {
      const a = Math.PI + (i / 3) * Math.PI;
      const h = 0.6 + (i % 2) * 0.28;
      const shard = merge([
        prism([[-0.1, 0], [0.1, 0], [0.06, h], [-0.06, h]], 0.16),
        cone(0.08, 0.2, 0, h, 0, 4),
      ]);
      shard.rotateY(a);
      shard.translate(Math.cos(a) * 0.3, 0, 0.34 + Math.sin(a) * 0.3);
      parts.push(shard);
    }
    parts.push(prism([[-0.42, 0], [0.42, 0], [0.42, 0.05], [-0.42, 0.05]], 0.3, 0, 0, 0.34));
    return merge(parts);
  },

  // -- gameplay objects -----------------------------------------------------
  minigun: () => {
    const parts = [
      cyl(0.14, 0.62, 0.31, 10),
      box(0.34, 0.3, 0.4, 0, 0.8, -0.06),
      box(0.2, 0.24, 0.26, 0, 0.8, 0.24),
      box(0.5, 0.12, 0.16, 0, 0.72, -0.3),
      box(0.24, 0.16, 0.12, 0, 0.96, -0.12),
    ];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      parts.push(tube(0.035, 0.44, 'z', Math.cos(a) * 0.08, 0.8 + Math.sin(a) * 0.08, 0.44, 6));
    }
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + Math.PI / 2;
      parts.push(box(0.05, 0.62, 0.05, Math.cos(a) * 0.26, 0.31, Math.sin(a) * 0.26));
    }
    return merge(parts);
  },

  explosiveBarrel: () =>
    merge([
      cyl(0.44, 0.94, 0.47, 18),
      ring(0.46, 0.04, 0, 0.24),
      ring(0.46, 0.04, 0, 0.7),
      cyl(0.3, 0.06, 0.97, 14),
      cyl(0.1, 0.1, 1.0, 10),
      box(0.2, 0.34, 0.06, 0, 0.5, 0.45),
      box(0.34, 0.2, 0.06, 0, 0.5, 0.45),
    ]),

  // Screen on a bracket: hangs in the air, so no floor detail.
  jumbotron: () =>
    merge([
      box(1, 1, 0.5, 0, 0.5, -0.2),
      box(0.9, 0.86, 0.24, 0, 0.5, 0.3),
      box(0.24, 0.16, 0.5, 0, 1.02, -0.3),
      box(0.5, 0.08, 0.3, 0, 1.06, -0.4),
    ]),

  // Open frame: a damage volume you need to see through.
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

  // -- weapon spawn points --------------------------------------------------
  // A shared plinth with a silhouette floating above it, so a row of spawners
  // is readable from across the arena.
  spawnHandgun: () =>
    merge([
      ...pedestal(),
      box(0.44, 0.12, 0.08, 0.02, 0.66, 0),
      box(0.14, 0.22, 0.09, -0.12, 0.52, 0).rotateX(0),
      box(0.1, 0.06, 0.06, 0.2, 0.58, 0),
    ]),

  spawnSmg: () =>
    merge([
      ...pedestal(),
      box(0.5, 0.11, 0.08, 0, 0.68, 0),
      box(0.1, 0.2, 0.07, -0.14, 0.54, 0),
      box(0.08, 0.16, 0.06, 0.04, 0.55, 0),
      box(0.16, 0.05, 0.05, 0.3, 0.62, 0),
    ]),

  spawnShotgun: () =>
    merge([
      ...pedestal(),
      tube(0.045, 0.6, 'x', 0.06, 0.72, 0, 8),
      tube(0.035, 0.42, 'x', 0.1, 0.64, 0, 8),
      place(box(0.22, 0.1, 0.08), { rz: -0.25, x: -0.24, y: 0.66 }),
      box(0.14, 0.06, 0.07, 0.02, 0.62, 0),
    ]),

  spawnSniper: () =>
    merge([
      ...pedestal(),
      tube(0.035, 0.78, 'x', 0.05, 0.72, 0, 8),
      box(0.24, 0.11, 0.09, -0.1, 0.68, 0),
      tube(0.05, 0.22, 'x', -0.02, 0.8, 0, 8),
      place(box(0.2, 0.1, 0.07), { rz: -0.2, x: -0.32, y: 0.63 }),
      box(0.06, 0.12, 0.05, 0.06, 0.6, 0),
    ]),

  spawnRpg: () =>
    merge([
      ...pedestal(),
      tube(0.075, 0.66, 'x', -0.04, 0.72, 0, 10),
      place(cone(0.11, 0.22), { rz: -Math.PI / 2, x: 0.36, y: 0.72 }),
      place(cone(0.12, 0.16), { rz: Math.PI / 2, x: -0.42, y: 0.72 }),
      box(0.1, 0.16, 0.06, -0.06, 0.58, 0),
      box(0.16, 0.05, 0.05, 0.06, 0.82, 0),
    ]),

  spawnGrenade: () =>
    merge([
      ...pedestal(),
      ball(0.17, 0, 0.66).scale(1, 1.15, 1),
      cyl(0.08, 0.08, 0.82, 10),
      place(box(0.05, 0.22, 0.04), { rz: 0.12, x: 0.14, y: 0.68 }),
      ring(0.07, 0.02, 0.14, 0.82, 0, 10),
    ]),

  spawnFlashbang: () =>
    merge([
      ...pedestal(),
      cyl(0.14, 0.32, 0.66, 12),
      cyl(0.09, 0.07, 0.85, 10),
      box(0.04, 0.24, 0.04, 0.13, 0.68, 0),
      ring(0.06, 0.02, 0.13, 0.84, 0, 10),
      ring(0.16, 0.02, 0, 0.72, 0, 12),
    ]),

  spawnRiotShield: () =>
    merge([
      ...pedestal(),
      box(0.5, 0.56, 0.1, 0, 0.72, -0.04),
      box(0.42, 0.2, 0.14, 0, 0.8, 0.02),
      box(0.54, 0.06, 0.12, 0, 0.98, -0.03),
      box(0.1, 0.14, 0.1, 0, 0.7, 0.12),
    ]),

  spawnHealthpack: () =>
    merge([
      ...pedestal(),
      box(0.42, 0.3, 0.34, 0, 0.62, 0),
      box(0.3, 0.09, 0.05, 0, 0.62, 0.19),
      box(0.09, 0.24, 0.05, 0, 0.62, 0.19),
      box(0.16, 0.06, 0.1, 0, 0.79, 0),
    ]),

  spawnAll: () =>
    merge([
      ...pedestal(),
      octa(0.2, 0, 0.68, 0),
      ring(0.26, 0.025, 0, 0.68, 0, 14),
      place(new THREE.TorusGeometry(0.26, 0.025, 8, 14).toNonIndexed(), { y: 0.68 }),
    ]),

  // -- mode objectives ------------------------------------------------------
  spawnZone: () =>
    merge([
      ...zonePad(0.46, 0.5),
      cone(0.16, 0.3, 0, 0.68, 0, 4).rotateY(Math.PI / 4),
      cyl(0.05, 0.68, 0.34, 8),
    ]),

  // A, B and C get one, two and three rings so they stay apart at a glance.
  dominationZoneA: () => dominationZone(1),
  dominationZoneB: () => dominationZone(2),
  dominationZoneC: () => dominationZone(3),

  flagSpawn: () =>
    merge([
      cyl(0.46, 0.06, 0.03, 16),
      ring(0.4, 0.035, 0, 0.07),
      cyl(0.05, 0.9, 0.5, 8),
      cyl(0.07, 0.05, 0.94, 8),
      prism([[0, 0], [0.44, -0.1], [0.44, 0.26], [0, 0.36]], 0.03, 0.03, 0.62, 0),
    ]),

  // Chevron pointing down at the spot the enemy walks out of.
  enemySpawn: () =>
    merge([
      ring(0.42, 0.04, 0, 0.041),
      cyl(0.36, 0.02, 0.01, 18),
      prism([[-0.26, 0.3], [0, 0], [0.26, 0.3], [0.26, 0.46], [0, 0.16], [-0.26, 0.46]], 0.06, 0, 0.42, 0),
      cyl(0.04, 0.34, 0.66, 8),
      box(0.05, 0.05, 0.05, 0, 0.86, 0),
    ]),

  // Deliberately odd so an unrecognised type is impossible to mistake.
  unknown: () => octa(0.5, 0, 0.5, 0),
};

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
  const key = `${def.shape}|${def.size.join(',')}|${def.pivot}`;
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
  g.computeVertexNormals();
  g.computeBoundingBox();
  cache.set(key, g);
  return g;
}

/** Local-space bounding box of the unscaled placeholder. */
export function localBox(def) {
  return geometryFor(def).boundingBox;
}

/** Shape ids the module can build, for the catalog tests. */
export function shapeIds() {
  return Object.keys(builders);
}

export function clearGeometryCache() {
  for (const g of cache.values()) g.dispose();
  cache.clear();
}
