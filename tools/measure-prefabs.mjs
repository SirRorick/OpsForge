// ---------------------------------------------------------------------------
// measure-prefabs.mjs — read real mesh dimensions out of the prefab GLBs
// ---------------------------------------------------------------------------
// Usage:  npm run measure-prefabs -- [name ...] [--json] [--all]
//
// Base mesh sizes in src/packs.js were estimates, because a map file stores
// only a scale multiplier and never the mesh it multiplies. reference/GameAssets
// /Prefabs/*.glb are the meshes, so the size can be measured instead of guessed.
//
// The number that matters is the axis-aligned bounding box of the whole prefab
// in its own local space, which is exactly what the map file's scale of 1,1,1
// means. Every POSITION accessor already carries a `min`/`max`, so no vertex
// data has to be decoded: transform those eight corners by the node's world
// matrix and union the result.
//
// Where the origin sits inside that box is the object's pivot, and it is
// reported rather than assumed — `base` means the box bottom is at y = 0,
// `center` means the origin is in the middle. Pivots come from the catalog
// rather than from guessing, so this is the evidence for them.
//
// glTF is right-handed Y-up and Unity is left-handed Y-up, so an exporter
// mirrors Z. That flips the sign of the Z bounds but not the box's size, and
// the pivot classification here only looks at Y, so neither is affected.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PREFABS = join(ROOT, 'reference/GameAssets/Prefabs');

const GLB_MAGIC = 0x46546c67;      // 'glTF'
const CHUNK_JSON = 0x4e4f534a;     // 'JSON'

function readGlbJson(path) {
  const buf = readFileSync(path);
  if (buf.length < 12 || buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error('not a GLB');
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32LE(pos);
    const type = buf.readUInt32LE(pos + 4);
    if (type === CHUNK_JSON) return JSON.parse(buf.toString('utf8', pos + 8, pos + 8 + len));
    pos += 8 + len + ((4 - (len % 4)) % 4);
  }
  throw new Error('no JSON chunk');
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

const nodeMatrix = (node) => (node.matrix ? node.matrix.slice() : fromTrs(node));

const apply = (m, [x, y, z]) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];

// --- bounding box -----------------------------------------------------------

/**
 * Geometry in these prefabs that is not the object.
 *
 * Every one of them ships editor furniture alongside the mesh: a `Manipulator`
 * of drag handles, a `*Hologram*` shell a couple of centimetres proud of the
 * surface, `Collider` proxies and an `Outline`. Measuring the lot makes every
 * primitive 1.25 m — the handles stand 0.125 m off each face — which would
 * have quietly contradicted the confirmed one-metre unit meshes. BoxSolid's
 * actual `SolidCubeModel` is exactly +/-0.5.
 *
 * LOD1 and below are the same shape at lower detail, and being simplified they
 * measure slightly *smaller*, so they are dropped in favour of LOD0.
 */
const NOT_THE_OBJECT = /manipulator|collider|hologram|ghost|outline|lockspawner|vfx/i;
const LOWER_LOD = /_LOD[1-9]\d*$/i;

const isFurniture = (name = '') => NOT_THE_OBJECT.test(name) || LOWER_LOD.test(name);

function boundsOf(gltf, { raw = false } = {}) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let primitives = 0;

  const visit = (index, parent) => {
    const node = gltf.nodes?.[index];
    if (!node) return;
    if (!raw && isFurniture(node.name)) return;
    const world = multiply(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      for (const prim of gltf.meshes?.[node.mesh]?.primitives ?? []) {
        const acc = gltf.accessors?.[prim.attributes?.POSITION];
        if (!acc?.min || !acc?.max) continue;
        primitives++;
        // Transform all eight corners: a rotated node's AABB is not the
        // rotation of its local AABB's two extreme corners.
        for (let corner = 0; corner < 8; corner++) {
          const p = apply(world, [
            corner & 1 ? acc.max[0] : acc.min[0],
            corner & 2 ? acc.max[1] : acc.min[1],
            corner & 4 ? acc.max[2] : acc.min[2],
          ]);
          for (let i = 0; i < 3; i++) {
            if (p[i] < min[i]) min[i] = p[i];
            if (p[i] > max[i]) max[i] = p[i];
          }
        }
      }
    }
    for (const child of node.children ?? []) visit(child, world);
  };

  const roots = gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? gltf.nodes?.map((_, i) => i) ?? [];
  for (const r of roots) visit(r, IDENTITY);
  return primitives ? { min, max, primitives } : null;
}

/**
 * Classify where the origin sits in the box. The tolerance is 1 cm: floor lock
 * drops a selection until its box sits on y = 0, so a pivot that is out by a
 * centimetre shifts the object on every edit.
 */
function pivotOf(min, max, tol = 0.01) {
  const height = max[1] - min[1];
  const centreY = (min[1] + max[1]) / 2;
  if (Math.abs(min[1]) <= tol) return 'base';
  if (Math.abs(centreY) <= tol) return 'center';
  if (Math.abs(max[1]) <= tol) return 'top';
  return `offset(${centreY.toFixed(3)} of ${height.toFixed(3)})`;
}

const round = (v) => Math.round(v * 1e4) / 1e4;

export function measure(file, opts) {
  const gltf = readGlbJson(join(PREFABS, file));
  const b = boundsOf(gltf, opts);
  if (!b) return { file, name: file.replace(/\.glb$/, ''), empty: true };
  const size = [0, 1, 2].map((i) => round(b.max[i] - b.min[i]));
  return {
    file,
    name: file.replace(/\.glb$/, ''),
    size,
    min: b.min.map(round),
    max: b.max.map(round),
    pivot: pivotOf(b.min, b.max),
    primitives: b.primitives,
  };
}

function main() {
  const args = process.argv.slice(2);
  if (!existsSync(PREFABS)) {
    console.error(`No prefabs at ${PREFABS}. This tool needs the (gitignored) game assets.`);
    process.exit(1);
  }
  const asJson = args.includes('--json');
  const names = args.filter((a) => !a.startsWith('--'));
  const all = readdirSync(PREFABS).filter((f) => f.endsWith('.glb'));
  // Exact names win outright: asking for BarrierCorner must not also return
  // GhostBarrierCorner and CamoBarrierCorner. Substring is the fallback for
  // when nothing matches exactly, which is what makes it useful for browsing.
  const eq = (f, n) => f.toLowerCase() === n.toLowerCase() ||
    f.slice(0, -4).toLowerCase() === n.toLowerCase();
  let wanted = all;
  if (names.length) {
    wanted = all.filter((f) => names.some((n) => eq(f, n)));
    if (!wanted.length) {
      wanted = all.filter((f) => names.some((n) => f.toLowerCase().includes(n.toLowerCase())));
    }
  }

  const opts = { raw: args.includes('--raw') };
  const rows = [];
  for (const f of wanted) {
    try { rows.push(measure(f, opts)); }
    catch (e) { rows.push({ file: f, name: f.replace(/\.glb$/, ''), error: e.message }); }
  }

  if (asJson) { console.log(JSON.stringify(rows, null, 2)); return; }

  // console.log understands %s but not printf's %-22s width syntax, which it
  // would print literally — pad the cells instead.
  const printable = rows.filter((r) => r.size);
  const cells = printable.map((r) => [
    r.name, r.size.join(', '), `${r.min[1]} .. ${r.max[1]}`, r.pivot,
  ]);
  const headers = ['prefab', 'size w,h,d (m)', 'y range', 'pivot'];
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c) => c.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
  console.log(line(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const c of cells) console.log(line(c));
  const bad = rows.filter((r) => !r.size);
  if (bad.length) {
    console.log('\n%d prefab(s) with no measurable mesh:', bad.length);
    bad.slice(0, 10).forEach((r) => console.log('  %s  %s', r.name, r.error ?? '(no POSITION accessors)'));
  }
}

// pathToFileURL, not string concatenation: a Windows path yields file:///C:/...
// with three slashes, so a hand-built file:// prefix never matches and the CLI
// silently does nothing.
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
