// ---------------------------------------------------------------------------
// trace-prefabs.mjs — read the shape of a prefab, in metres
// ---------------------------------------------------------------------------
// Usage:
//   npm run trace-prefabs -- BarrierWindow
//   npm run trace-prefabs -- BarrierWindow --grid 40 --plane xy
//   npm run trace-prefabs -- Crate --sections 0.1,0.5,0.9
//   npm run trace-prefabs -- --all --json > report.json
//
// The placeholders in src/placeholders.js are hand-authored stand-ins for the
// real art, and they ship with the open-source build where the real art does
// not. To resemble the real piece they have to be *measured* from it, and this
// is what does the measuring: it decodes a prefab's actual triangles and
// reports silhouettes, openings and cross-sections as numbers a builder can be
// written from.
//
// **It reports numbers. It does not convert anything.** Nothing it prints is
// mesh data, and nothing it prints is copied into the editor — a builder reads
// "the opening runs x 0.36..0.66, y 1.32..1.56" off this output and is then
// written as boxes by hand. Voxelising the mesh and shipping the voxels would
// be a mechanical derivation of the artists' work; a hand-built approximation
// from dimensions is not, and that distinction is the reason this tool stops
// where it does.
//
// `tools/measure-prefabs.mjs` answers a narrower question — the overall size
// and the pivot — and does it from the accessor `min`/`max` alone, without
// decoding a single vertex. That is why it stays separate and stays small: the
// catalog's `size` field depends on it, and it should keep working even if this
// one is thrown away.
//
// Like every tool in here it reads the gitignored game assets and is not
// imported by src/. The editor does not need it to run or to build.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PREFABS = join(ROOT, 'reference/GameAssets/Prefabs');

// ---------------------------------------------------------------------------
// GLB decoding
// ---------------------------------------------------------------------------

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

function readGlb(path) {
  const buf = readFileSync(path);
  if (buf.length < 12 || buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error('not a GLB');
  let pos = 12;
  let json = null;
  let bin = null;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32LE(pos);
    const type = buf.readUInt32LE(pos + 4);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === CHUNK_JSON) json = JSON.parse(body.toString('utf8'));
    if (type === CHUNK_BIN) bin = body;
    pos += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error('no JSON chunk');
  return { json, bin };
}

const COMPONENT = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array,
  5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
};
const COMPONENT_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const COMPONENTS_PER = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/**
 * One accessor as plain numbers. Interleaved buffer views are read through
 * their `byteStride` rather than assumed tight, which vertex buffers usually
 * are not, and the per-element view is built at an explicit byte offset so an
 * accessor that does not start on its component's alignment still reads.
 */
function readAccessor(gltf, bin, index) {
  const acc = gltf.accessors[index];
  const Ctor = COMPONENT[acc.componentType];
  if (!Ctor) throw new Error(`unknown componentType ${acc.componentType}`);
  const per = COMPONENTS_PER[acc.type];
  const view = gltf.bufferViews[acc.bufferView];
  const start = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const stride = view.byteStride ?? per * COMPONENT_SIZE[acc.componentType];
  const out = new Float64Array(acc.count * per);
  for (let e = 0; e < acc.count; e++) {
    const el = new Ctor(bin.buffer, bin.byteOffset + start + e * stride, per);
    for (let c = 0; c < per; c++) out[e * per + c] = el[c];
  }
  return { data: out, per, count: acc.count };
}

// --- 4x4 column-major matrices, as glTF stores them -------------------------

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

function fromTrs(node) {
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

const apply = (m, [x, y, z]) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];

/**
 * Geometry in these prefabs that is not the object — the same filter
 * measure-prefabs uses, and for the same reason: every prefab ships drag
 * handles, a hologram shell a couple of centimetres proud of the surface,
 * collider proxies and an outline, and measuring the lot makes every primitive
 * 1.25 m instead of 1.
 */
const NOT_THE_OBJECT = /manipulator|collider|hologram|ghost|outline|lockspawner|vfx/i;
const LOWER_LOD = /_LOD[1-9]\d*$/i;
const isFurniture = (name = '') => NOT_THE_OBJECT.test(name) || LOWER_LOD.test(name);

/**
 * Every triangle of the object proper, in the prefab's own local space.
 *
 * `keepFurniture` turns the filter off, and the caller falls back to it when
 * filtering leaves nothing. One prefab needs that: StreetStylePigeon's body is
 * a skinned mesh the export dropped, and the only geometry left in the file is
 * `PidgeonHologram` — the shell that stands a couple of centimetres proud of
 * the bird. A shell of the right bird beats no bird at all, as long as whoever
 * reads the numbers knows they are two centimetres generous.
 */
export function trianglesOf(file, { keepFurniture = false } = {}) {
  const { json: gltf, bin } = readGlb(join(PREFABS, file));
  if (!gltf.meshes?.length) throw new Error('prefab has no meshes — nodes and UI only');
  if (!bin) throw new Error('no BIN chunk — geometry is in an external buffer');
  const tris = [];

  const visit = (index, parent) => {
    const node = gltf.nodes?.[index];
    if (!node || (!keepFurniture && isFurniture(node.name))) return;
    const world = multiply(parent, node.matrix ? node.matrix.slice() : fromTrs(node));
    if (node.mesh !== undefined) {
      for (const prim of gltf.meshes?.[node.mesh]?.primitives ?? []) {
        if (prim.mode !== undefined && prim.mode !== 4) continue;    // triangles only
        const posIndex = prim.attributes?.POSITION;
        if (posIndex === undefined) continue;
        const pos = readAccessor(gltf, bin, posIndex);
        const idx = prim.indices !== undefined
          ? readAccessor(gltf, bin, prim.indices).data
          : Float64Array.from({ length: pos.count }, (_, k) => k);
        for (let t = 0; t + 2 < idx.length; t += 3) {
          tris.push([0, 1, 2].map((k) => {
            const v = idx[t + k] * 3;
            return apply(world, [pos.data[v], pos.data[v + 1], pos.data[v + 2]]);
          }));
        }
      }
    }
    for (const child of node.children ?? []) visit(child, world);
  };

  const roots = gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? gltf.nodes?.map((_, i) => i) ?? [];
  for (const r of roots) visit(r, IDENTITY);
  return tris;
}

// ---------------------------------------------------------------------------
// Silhouettes
// ---------------------------------------------------------------------------

const AXES = { xy: [0, 1], xz: [0, 2], zy: [2, 1] };

function boundsOf(tris) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) {
    for (const p of t) {
      for (let i = 0; i < 3; i++) {
        if (p[i] < min[i]) min[i] = p[i];
        if (p[i] > max[i]) max[i] = p[i];
      }
    }
  }
  return { min, max, size: [0, 1, 2].map((i) => max[i] - min[i]) };
}

/**
 * Exact orthographic coverage: rasterise every triangle's projection onto one
 * plane and mark the cells it covers. A modelled opening comes out as a hole in
 * the coverage; a hole that is only painted into the texture's alpha does not,
 * which is the distinction that matters when deciding whether a placeholder
 * should have a gap in it.
 *
 * Cells are square in world units — the grid is sized by aspect ratio — so a
 * row of `#` is the same number of millimetres as a column of them.
 */
export function silhouette(tris, plane = 'xy', longest = 32, bounds = boundsOf(tris)) {
  const [ax, ay] = AXES[plane];
  const lo = [bounds.min[ax], bounds.min[ay]];
  const span = [bounds.size[ax] || 1e-6, bounds.size[ay] || 1e-6];
  const cell = Math.max(...span) / longest;
  const nx = Math.max(1, Math.round(span[0] / cell));
  const ny = Math.max(1, Math.round(span[1] / cell));
  const grid = new Uint8Array(nx * ny);

  const toCell = (v, i, n) => ((v - lo[i]) / span[i]) * n;
  const edge = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

  for (const t of tris) {
    const p = t.map((q) => [toCell(q[ax], 0, nx), toCell(q[ay], 1, ny)]);
    const x0 = Math.max(0, Math.floor(Math.min(p[0][0], p[1][0], p[2][0])));
    const x1 = Math.min(nx - 1, Math.ceil(Math.max(p[0][0], p[1][0], p[2][0])));
    const y0 = Math.max(0, Math.floor(Math.min(p[0][1], p[1][1], p[2][1])));
    const y1 = Math.min(ny - 1, Math.ceil(Math.max(p[0][1], p[1][1], p[2][1])));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const c = [x + 0.5, y + 0.5];
        const d1 = edge(p[0], p[1], c), d2 = edge(p[1], p[2], c), d3 = edge(p[2], p[0], c);
        // Inside if no two edge functions disagree in sign — winding-agnostic,
        // since these meshes are not consistently wound after export.
        if (!(((d1 < 0) || (d2 < 0) || (d3 < 0)) && ((d1 > 0) || (d2 > 0) || (d3 > 0)))) {
          grid[y * nx + x] = 1;
        }
      }
    }
  }
  return { grid, nx, ny, plane, lo, span, cell };
}

/**
 * The printout, oriented the way the thing is actually looked at.
 *
 * An elevation reads with the top of the object at the top of the page, so the
 * vertical axis counts down. A plan reads as a map seen from above: three.js
 * looks down -Y with +x to the right, which puts +z *towards* the viewer and so
 * down the page, and the vertical axis counts up.
 *
 * Getting this backwards is not a cosmetic problem. Every corner piece is an L,
 * and a transposed plan puts its arms on the opposite two edges — which is
 * exactly the mistake that once had BarrierCorner drawn rotated 180 degrees.
 * `sectionRows` prints +z down for the same reason; the two must agree.
 */
export function silhouetteRows(sil) {
  const rows = [];
  const planView = sil.plane === 'xz';
  for (let i = 0; i < sil.ny; i++) {
    const y = planView ? i : sil.ny - 1 - i;
    let line = '';
    for (let x = 0; x < sil.nx; x++) line += sil.grid[y * sil.nx + x] ? '#' : '.';
    rows.push(line);
  }
  return rows;
}

/**
 * Openings: uncovered regions fully enclosed by covered ones, reported as
 * rectangles in metres. This is the number a builder actually needs — the
 * jambs either side of a window are whatever is left once the hole is known.
 *
 * Enclosure is decided by flooding in from the border: anything the outside
 * reaches is background, and what is left is a hole. Reported smallest-first so
 * a stray uncovered cell at the resolution limit sorts away from a real window.
 */
export function openings(sil, minCells = 4) {
  const { grid, nx, ny } = sil;
  const outside = new Uint8Array(nx * ny);
  const stack = [];
  for (let x = 0; x < nx; x++) { stack.push([x, 0], [x, ny - 1]); }
  for (let y = 0; y < ny; y++) { stack.push([0, y], [nx - 1, y]); }
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
    const i = y * nx + x;
    if (outside[i] || grid[i]) continue;
    outside[i] = 1;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }

  const seen = new Uint8Array(nx * ny);
  const found = [];
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      if (grid[i] || outside[i] || seen[i]) continue;
      const cells = [];
      const q = [[x, y]];
      seen[i] = 1;
      while (q.length) {
        const [cx, cy] = q.pop();
        cells.push([cx, cy]);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ux = cx + dx, uy = cy + dy;
          if (ux < 0 || uy < 0 || ux >= nx || uy >= ny) continue;
          const j = uy * nx + ux;
          if (grid[j] || outside[j] || seen[j]) continue;
          seen[j] = 1;
          q.push([ux, uy]);
        }
      }
      if (cells.length < minCells) continue;
      const xs = cells.map((c) => c[0]), ys = cells.map((c) => c[1]);
      found.push(rect(sil, Math.min(...xs), Math.max(...xs) + 1, Math.min(...ys), Math.max(...ys) + 1, cells.length));
    }
  }
  return found.sort((a, b) => b.cells - a.cells);
}

function rect(sil, x0, x1, y0, y1, cells) {
  const at = (v, i, n) => sil.lo[i] + (v / n) * sil.span[i];
  const a = [at(x0, 0, sil.nx), at(x1, 0, sil.nx)];
  const b = [at(y0, 1, sil.ny), at(y1, 1, sil.ny)];
  const [an, bn] = sil.plane.split('');
  return {
    cells,
    [an]: [round(a[0]), round(a[1])],
    [bn]: [round(b[0]), round(b[1])],
    size: [round(a[1] - a[0]), round(b[1] - b[0])],
  };
}

/**
 * The outline of a horizontal slice through the object, as segments where the
 * triangles cross the plane `y`.
 *
 * A real cut, not a sample of the vertices near that height: a box spanning the
 * whole object has vertices only at its two ends, so sampling by height reports
 * nothing at all across the middle of a plain wall. Cutting reports what is
 * actually there, which is also what makes the section read as an outline —
 * a tunnel comes out as two side walls with a gap, not as one filled rectangle.
 */
export function crossSection(tris, y) {
  const segs = [];
  for (const t of tris) {
    const d = t.map((p) => p[1] - y);
    const pts = [];
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      if ((d[i] > 0 && d[j] > 0) || (d[i] < 0 && d[j] < 0)) continue;
      if (d[i] === d[j]) continue;
      const f = d[i] / (d[i] - d[j]);
      pts.push([t[i][0] + (t[j][0] - t[i][0]) * f, t[i][2] + (t[j][2] - t[i][2]) * f]);
    }
    if (pts.length >= 2) segs.push([pts[0], pts[1]]);
  }
  return segs;
}

/** A slice drawn as ASCII, x across and z down, plus its extent in metres. */
export function sectionRows(segs, longest = 24, bounds = null) {
  if (!segs.length) return { rows: [], empty: true };
  const mn = [Infinity, Infinity], mx = [-Infinity, -Infinity];
  const src = bounds ? [[bounds.min[0], bounds.min[2]], [bounds.max[0], bounds.max[2]]] : segs.flat();
  for (const p of src) for (let i = 0; i < 2; i++) { if (p[i] < mn[i]) mn[i] = p[i]; if (p[i] > mx[i]) mx[i] = p[i]; }
  const span = [mx[0] - mn[0] || 1e-6, mx[1] - mn[1] || 1e-6];
  const cell = Math.max(...span) / longest;
  const nx = Math.max(1, Math.round(span[0] / cell));
  const nz = Math.max(1, Math.round(span[1] / cell));
  const grid = new Uint8Array(nx * nz);
  const own = [[Infinity, Infinity], [-Infinity, -Infinity]];
  for (const [a, b] of segs) {
    for (const p of [a, b]) {
      for (let i = 0; i < 2; i++) {
        if (p[i] < own[0][i]) own[0][i] = p[i];
        if (p[i] > own[1][i]) own[1][i] = p[i];
      }
    }
    const steps = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / cell) * 2);
    for (let s = 0; s <= steps; s++) {
      const f = s / steps;
      const x = Math.min(nx - 1, Math.max(0, Math.floor(((a[0] + (b[0] - a[0]) * f) - mn[0]) / span[0] * nx)));
      const z = Math.min(nz - 1, Math.max(0, Math.floor(((a[1] + (b[1] - a[1]) * f) - mn[1]) / span[1] * nz)));
      grid[z * nx + x] = 1;
    }
  }
  const rows = [];
  for (let z = 0; z < nz; z++) {
    let line = '';
    for (let x = 0; x < nx; x++) line += grid[z * nx + x] ? '#' : '.';
    rows.push(line);
  }
  return {
    rows,
    x: [round(own[0][0]), round(own[1][0])],
    z: [round(own[0][1]), round(own[1][1])],
    size: [round(own[1][0] - own[0][0]), round(own[1][1] - own[0][1])],
  };
}

/**
 * The filled intervals across each horizontal band of an elevation, in metres.
 *
 * This is the report a barrier actually gets written from. A silhouette drawn
 * in `#` is quick to read but quantised to whole cells, and a barrier's jamb is
 * usually a couple of centimetres wider than the nearest cell — so the ASCII
 * says "about a sixth of the way across" where this says 0.131. Bands with one
 * interval are solid; two means something is cut out between them, which is how
 * a window, a doorway and the notch in a U all show up.
 */
export function spans(tris, plane = 'xy', bands = 16, bounds = boundsOf(tris), across = 240) {
  const [ax, ay] = AXES[plane];
  const [lo, hi] = [bounds.min[ay], bounds.max[ay]];
  const sil = silhouetteAt(tris, ax, ay, across, bounds, bands);
  const out = [];
  for (let b = 0; b < bands; b++) {
    const runs = [];
    let start = -1;
    for (let i = 0; i <= across; i++) {
      const on = i < across && sil[b * across + i];
      if (on && start < 0) start = i;
      if (!on && start >= 0) {
        runs.push([
          round(bounds.min[ax] + (start / across) * bounds.size[ax]),
          round(bounds.min[ax] + (i / across) * bounds.size[ax]),
        ]);
        start = -1;
      }
    }
    out.push({
      band: [round(lo + ((hi - lo) * b) / bands), round(lo + ((hi - lo) * (b + 1)) / bands)],
      runs,
    });
  }
  return out;
}

/** Coverage on one plane at a deliberately lopsided resolution, for `spans`. */
function silhouetteAt(tris, ax, ay, nx, bounds, ny) {
  const grid = new Uint8Array(nx * ny);
  const span = [bounds.size[ax] || 1e-6, bounds.size[ay] || 1e-6];
  const toCell = (v, i, n) => ((v - (i ? bounds.min[ay] : bounds.min[ax])) / span[i]) * n;
  const edge = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (const t of tris) {
    const p = t.map((q) => [toCell(q[ax], 0, nx), toCell(q[ay], 1, ny)]);
    const x0 = Math.max(0, Math.floor(Math.min(p[0][0], p[1][0], p[2][0])));
    const x1 = Math.min(nx - 1, Math.ceil(Math.max(p[0][0], p[1][0], p[2][0])));
    const y0 = Math.max(0, Math.floor(Math.min(p[0][1], p[1][1], p[2][1])));
    const y1 = Math.min(ny - 1, Math.ceil(Math.max(p[0][1], p[1][1], p[2][1])));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const c = [x + 0.5, y + 0.5];
        const d1 = edge(p[0], p[1], c), d2 = edge(p[1], p[2], c), d3 = edge(p[2], p[0], c);
        if (!(((d1 < 0) || (d2 < 0) || (d3 < 0)) && ((d1 > 0) || (d2 > 0) || (d3 > 0)))) grid[y * nx + x] = 1;
      }
    }
  }
  return grid;
}

/** Slices at even heights, skipping the very top and bottom faces. */
export function profile(tris, steps = 8, bounds = boundsOf(tris), longest = 20) {
  const [minY, maxY] = [bounds.min[1], bounds.max[1]];
  const out = [];
  for (let i = 0; i < steps; i++) {
    const y = minY + ((maxY - minY) * (i + 0.5)) / steps;
    out.push({ y: round(y), ...sectionRows(crossSection(tris, y), longest, bounds) });
  }
  return out;
}

const round = (v) => Math.round(v * 1000) / 1000;

/** Everything about one prefab, as data. */
export function trace(file, { grid = 32, steps = 10 } = {}) {
  const name = file.replace(/\.glb$/, '');
  let tris = trianglesOf(file);
  let shell = false;
  if (!tris.length) {
    tris = trianglesOf(file, { keepFurniture: true });
    shell = true;
  }
  if (!tris.length) return { file, name, empty: true };
  const b = boundsOf(tris);
  const out = {
    file,
    name,
    ...(shell ? { shell: 'measured from the hologram shell — a couple of cm generous' } : {}),
    triangles: tris.length,
    size: b.size.map(round),
    min: b.min.map(round),
    max: b.max.map(round),
    views: {},
    openings: {},
    profile: profile(tris, steps, b),
  };
  for (const plane of ['xy', 'xz', 'zy']) {
    const sil = silhouette(tris, plane, grid, b);
    out.views[plane] = silhouetteRows(sil);
    out.openings[plane] = openings(sil);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function flag(args, name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

function main() {
  const args = process.argv.slice(2);
  if (!existsSync(PREFABS)) {
    console.error(`No prefabs at ${PREFABS}. This tool needs the (gitignored) game assets.`);
    process.exit(1);
  }
  const all = readdirSync(PREFABS).filter((f) => f.endsWith('.glb'));
  const grid = Number(flag(args, 'grid', 32));
  const steps = Number(flag(args, 'steps', 10));
  const planes = flag(args, 'plane', 'xy,xz,zy').split(',');
  const asJson = args.includes('--json');

  const names = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  let wanted = args.includes('--all') ? all : [];
  if (names.length) {
    const eq = (f, n) => f.slice(0, -4).toLowerCase() === n.toLowerCase();
    wanted = all.filter((f) => names.some((n) => eq(f, n)));
    if (!wanted.length) {
      wanted = all.filter((f) => names.some((n) => f.toLowerCase().includes(n.toLowerCase())));
    }
  }
  if (!wanted.length) {
    console.error('Nothing matched. Give a prefab name, or --all.');
    process.exit(1);
  }

  const rows = [];
  for (const f of wanted) {
    try { rows.push(trace(f, { grid, steps })); }
    catch (e) { rows.push({ file: f, name: f.replace(/\.glb$/, ''), error: e.message }); }
  }

  if (asJson) { console.log(JSON.stringify(rows, null, 1)); return; }

  for (const r of rows) {
    if (r.error) { console.log(`\n=== ${r.name}\n    error: ${r.error}`); continue; }
    if (r.empty) { console.log(`\n=== ${r.name}\n    no triangles`); continue; }
    console.log(`\n=== ${r.name}   ${r.size.join(' x ')} m   ${r.triangles} tris`);
    console.log(`    x ${r.min[0]}..${r.max[0]}   y ${r.min[1]}..${r.max[1]}   z ${r.min[2]}..${r.max[2]}`);
    for (const plane of planes) {
      if (!r.views[plane]) continue;
      const label = {
        xy: 'front elevation — x right, y up the page',
        xz: 'plan from above — x right, +z down the page',
        zy: 'side elevation — z right, y up the page',
      }[plane];
      console.log(`\n  ${plane} — ${label}`);
      for (const row of r.views[plane]) console.log('    ' + row);
      for (const o of r.openings[plane]) {
        const [an, bn] = plane.split('');
        console.log(`    opening  ${an} ${o[an][0]}..${o[an][1]}  ${bn} ${o[bn][0]}..${o[bn][1]}   (${o.size.join(' x ')} m)`);
      }
    }
    console.log('\n  sections (a cut through the object, x across and z down)');
    for (const p of r.profile) {
      if (p.empty) { console.log(`    y ${p.y}  —`); continue; }
      console.log(`    y ${p.y}   x ${p.x[0]}..${p.x[1]}   z ${p.z[0]}..${p.z[1]}   (${p.size.join(' x ')} m)`);
      for (const row of p.rows) console.log('      ' + row);
    }
  }
}

// pathToFileURL, not string concatenation: a Windows path yields file:///C:/...
// with three slashes, so a hand-built file:// prefix never matches and the CLI
// silently does nothing. Guarded because argv[1] is undefined under `node -e`,
// which is how the exports above get driven when tracing the whole catalog.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
