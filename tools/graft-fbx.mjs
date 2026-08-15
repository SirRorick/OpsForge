// ---------------------------------------------------------------------------
// graft-fbx.mjs — put a mesh from an .fbx onto a node of a prefab .glb
// ---------------------------------------------------------------------------
// Usage:
//   npm run graft-fbx -- <source.fbx> <target.glb> <NodeName> [options]
//
//   --scale N        multiply the FBX's units by N (default 0.01, cm -> m)
//   --double-sided   render both faces of the grafted material
//   --dry-run        report what would happen and write nothing
//   --force          graft again onto a node that already has a mesh
//
// Why this exists
// ---------------
// A handful of the prefabs arrive with their hierarchy
// intact and their mesh missing. Unity's SkinnedMeshRenderer keeps its mesh in
// a separate asset, and where that asset did not come out with the prefab the
// exported .glb has the bones, the colliders and the outline but nothing to
// draw. `CaptureFlagSpawnPointTeam1` and `Team2` are 45 nodes and zero meshes;
// `StreetStylePigeon` has one mesh and it is the hologram shell. All three fell
// back to the stand-in shapes in src/placeholders.js no matter what was in
// assets/Prefabs.
//
// The missing meshes were published separately as .fbx. This grafts one onto
// the other: the prefab keeps every node, transform, collider and outline it
// arrived with — which is what tools/measure-prefabs.mjs reads and what the
// furniture filter in src/scene.js expects — and gains the geometry that was
// meant to hang off the named node.
//
// Grafting rather than converting, for that reason. A .glb built from the .fbx
// alone would be a mesh floating in its own space, and every transform that
// places it in the prefab — the flag's 90 degrees about Y, the pigeon's 180 —
// would have to be re-derived by hand and would be wrong the first few times.
//
// This is the one tool here that is not dependency-free: reading a binary FBX
// is a job for a parser that already exists. Install it beside the tool and it
// is not needed again:
//
//   npm install --no-save three
//
// Nothing else in the project needs it — `npm run build`, `npm test` and the
// editor itself have no dependencies, and this does not change that.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readGlb, writeGlb } from './glb.mjs';

// ---------------------------------------------------------------------------
// Reading the FBX
// ---------------------------------------------------------------------------

/**
 * three's FBXLoader in Node.
 *
 * It expects a browser twice over, and neither use needs a real one. Embedded
 * images go through `window.URL.createObjectURL`, whose result is only ever
 * handed straight back to a TextureLoader — so a counter for a URL and a Map
 * for the bytes is a complete implementation as far as the loader is concerned,
 * and the bytes are exactly what has to end up in the .glb. Decoding the image
 * would be wasted work: the PNG goes in whole.
 */
async function loadFbx(file) {
  const THREE = await import('three');
  const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');

  const blobs = new Map();
  globalThis.window ??= {};
  globalThis.window.URL = {
    createObjectURL(blob) {
      const url = `embedded:${blobs.size}`;
      blobs.set(url, blob);
      return url;
    },
  };
  THREE.TextureLoader.prototype.load = function (url, onLoad) {
    const texture = new THREE.Texture();
    texture.userData.source = url;
    onLoad?.(texture);
    return texture;
  };

  const buf = readFileSync(file);
  const group = new FBXLoader().parse(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  return { THREE, group, blobs };
}

/**
 * Every drawable primitive in the FBX, in metres, ready to write out.
 *
 * `applyMatrix4(matrixWorld)` bakes each mesh's own placement inside the FBX
 * into its vertices, so the graft can sit on a node with no transform of its
 * own and inherit only the prefab's. That is the whole point: the prefab knows
 * where the object goes and the FBX does not.
 */
function collectPrimitives({ THREE, group }, scale) {
  const out = [];
  group.updateWorldMatrix(true, true);
  group.traverse((node) => {
    if (!node.isMesh) return;
    const geometry = node.geometry.clone();
    geometry.applyMatrix4(node.matrixWorld);
    geometry.scale(scale, scale, scale);

    const materials = Array.isArray(node.material) ? node.material : [node.material];
    const groups = geometry.groups.length
      ? geometry.groups
      : [{ start: 0, count: (geometry.index ?? geometry.attributes.position).count, materialIndex: 0 }];

    for (const g of groups) {
      out.push({
        node: node.name,
        material: materials[g.materialIndex ?? 0] ?? materials[0],
        ...sliceAttributes(THREE, geometry, g.start, g.count),
      });
    }
  });
  return out;
}

/**
 * One group of an FBX geometry as flat, de-indexed arrays.
 *
 * De-indexed because FBXLoader hands over non-indexed geometry anyway, and
 * these meshes are hundreds of triangles rather than hundreds of thousands —
 * the index buffer would cost more in code than it saves in bytes.
 *
 * The V coordinate is flipped. glTF measures V down from the top of the image
 * and three (following FBX) measures it up from the bottom, which is why
 * three's own GLTFLoader sets `flipY = false` on everything it loads. Writing
 * the FBX's V straight through renders the texture upside down.
 */
function sliceAttributes(THREE, geometry, start, count) {
  const index = geometry.index;
  const src = geometry.attributes;
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const uv = src.uv ? new Float32Array(count * 2) : null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (let i = 0; i < count; i++) {
    const v = index ? index.getX(start + i) : start + i;
    for (let a = 0; a < 3; a++) {
      const p = src.position.array[v * src.position.itemSize + a];
      position[i * 3 + a] = p;
      if (p < min[a]) min[a] = p;
      if (p > max[a]) max[a] = p;
      normal[i * 3 + a] = src.normal ? src.normal.array[v * src.normal.itemSize + a] : 0;
    }
    if (uv) {
      uv[i * 2] = src.uv.array[v * src.uv.itemSize];
      uv[i * 2 + 1] = 1 - src.uv.array[v * src.uv.itemSize + 1];
    }
  }
  if (!src.normal) {
    // Nothing has arrived without normals so far, but a flat-shaded
    // fallback beats a mesh that renders black.
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.computeVertexNormals();
    normal.set(g.attributes.normal.array);
  }
  return { position, normal, uv, count, min, max };
}

// ---------------------------------------------------------------------------
// Writing the graft into the prefab
// ---------------------------------------------------------------------------

/** Depth-first search of the glTF node tree for one node by name. */
function findNode(json, name) {
  const hit = (json.nodes ?? []).findIndex((n) => n.name === name);
  if (hit < 0) {
    const names = (json.nodes ?? []).map((n) => n.name).filter(Boolean);
    throw new Error(`no node called "${name}". The prefab has: ${names.join(', ')}`);
  }
  return hit;
}

/**
 * Graft the FBX's primitives onto `nodeName` of an already-parsed prefab.
 *
 * Everything is appended: the prefab's own buffer views, accessors, meshes and
 * materials keep their indices, so nothing that already referred to them has to
 * be rewritten. A prefab with an empty BIN chunk — which is what a mesh-less
 * export is — simply starts its buffer here.
 */
export function graft({ json, bin }, primitives, blobBytes, { nodeName, doubleSided, force }) {
  const nodeIndex = findNode(json, nodeName);
  // Grafting appends, so running it twice leaves the node wearing two copies of
  // the same mesh and the file twice the size. The prefabs this is for have an
  // empty node by definition, so a mesh already there means it has been run
  // before — much more likely than a prefab that genuinely wants a second one.
  if (json.nodes[nodeIndex].mesh !== undefined && !force) {
    throw new Error(
      `"${nodeName}" already carries a mesh, so this prefab has been grafted ` +
      `already. Re-stage it, or pass --force to add another.`);
  }
  json.buffers ??= [];
  json.bufferViews ??= [];
  json.accessors ??= [];
  json.meshes ??= [];
  json.materials ??= [];
  json.images ??= [];
  json.textures ??= [];
  json.samplers ??= [];

  const chunks = bin.length ? [bin] : [];
  let offset = bin.length;

  const addView = (data, target) => {
    const slack = (4 - (offset % 4)) % 4;
    if (slack) { chunks.push(Buffer.alloc(slack)); offset += slack; }
    chunks.push(data);
    json.bufferViews.push({
      buffer: 0, byteOffset: offset, byteLength: data.length,
      ...(target ? { target } : {}),
    });
    offset += data.length;
    return json.bufferViews.length - 1;
  };

  const addAccessor = (array, componentType, type, count, extra = {}) => {
    const view = addView(Buffer.from(array.buffer, array.byteOffset, array.byteLength), 34962);
    json.accessors.push({ bufferView: view, componentType, count, type, ...extra });
    return json.accessors.length - 1;
  };

  // One glTF image per distinct source image, however many primitives use it.
  const images = new Map();
  const textureFor = (source) => {
    if (images.has(source)) return images.get(source);
    const bytes = blobBytes.get(source);
    if (!bytes) return null;
    const view = addView(bytes);
    json.images.push({ bufferView: view, mimeType: mimeOf(bytes), name: source });
    if (!json.samplers.length) json.samplers.push({ wrapS: 10497, wrapT: 10497 });
    json.textures.push({ sampler: 0, source: json.images.length - 1 });
    const index = json.textures.length - 1;
    images.set(source, index);
    return index;
  };

  const gltfPrimitives = [];
  for (const p of primitives) {
    const attributes = {
      POSITION: addAccessor(p.position, 5126, 'VEC3', p.count, { min: p.min, max: p.max }),
      NORMAL: addAccessor(p.normal, 5126, 'VEC3', p.count),
    };
    if (p.uv) attributes.TEXCOORD_0 = addAccessor(p.uv, 5126, 'VEC2', p.count);

    const texture = p.material?.map?.userData?.source
      ? textureFor(p.material.map.userData.source) : null;
    const colour = p.material?.color;
    json.materials.push({
      name: p.material?.name ?? `${nodeName}Material`,
      pbrMetallicRoughness: {
        ...(texture !== null && texture !== undefined ? { baseColorTexture: { index: texture } } : {}),
        baseColorFactor: colour ? [colour.r, colour.g, colour.b, 1] : [1, 1, 1, 1],
        // Unity's Lambert has neither, and a metal with no environment map to
        // reflect renders black in the editor's two-light viewport.
        metallicFactor: 0,
        roughnessFactor: 1,
      },
      ...(doubleSided ? { doubleSided: true } : {}),
    });
    gltfPrimitives.push({ attributes, material: json.materials.length - 1 });
  }

  json.meshes.push({ name: nodeName, primitives: gltfPrimitives });
  json.nodes[nodeIndex].mesh = json.meshes.length - 1;

  const buffer = Buffer.concat(chunks);
  json.buffers[0] = { byteLength: buffer.length };
  return { json, bin: buffer, primitives: gltfPrimitives.length };
}

const mimeOf = (bytes) =>
  bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png'
    : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg'
      : 'application/octet-stream';

// ---------------------------------------------------------------------------

export async function graftFile(fbxFile, glbFile, nodeName, opts = {}) {
  const { scale = 0.01, doubleSided = false, dryRun = false, force = false } = opts;
  const fbx = await loadFbx(fbxFile);
  const primitives = collectPrimitives(fbx, scale);
  if (!primitives.length) throw new Error(`${fbxFile} holds no meshes`);

  const blobBytes = new Map();
  for (const [url, blob] of fbx.blobs) {
    blobBytes.set(url, Buffer.from(await blob.arrayBuffer()));
  }

  const prefab = readGlb(glbFile);
  const grafted = graft(prefab, primitives, blobBytes, { nodeName, doubleSided, force });
  const bytes = dryRun ? 0 : writeGlb(glbFile, grafted.json, grafted.bin);

  return {
    primitives: grafted.primitives,
    vertices: primitives.reduce((n, p) => n + p.count, 0),
    images: grafted.json.images.length,
    bytes,
    bounds: primitives.reduce((b, p) => ({
      min: b.min.map((v, i) => Math.min(v, p.min[i])),
      max: b.max.map((v, i) => Math.max(v, p.max[i])),
    }), { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const value = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
  };
  const positional = args.filter((a, i) =>
    !a.startsWith('--') && !(i > 0 && args[i - 1] === '--scale'));
  const [fbx, glb, node] = positional;

  if (!fbx || !glb || !node) {
    console.error('Usage: node tools/graft-fbx.mjs <source.fbx> <target.glb> <NodeName>');
    console.error('       [--scale 0.01] [--double-sided] [--dry-run] [--force]');
    process.exit(1);
  }

  const r = await graftFile(fbx, glb, node, {
    scale: value('--scale', 0.01),
    doubleSided: flag('--double-sided'),
    dryRun: flag('--dry-run'),
    force: flag('--force'),
  });
  const m = (a) => `[${a.map((v) => v.toFixed(3)).join(', ')}]`;
  console.log(`${basename(fbx)} -> ${basename(glb)}  node ${node}`);
  console.log(`  ${r.primitives} primitive(s), ${r.vertices} vertices, ${r.images} image(s)`);
  console.log(`  bounds ${m(r.bounds.min)} .. ${m(r.bounds.max)}`);
  console.log(r.bytes ? `  wrote ${(r.bytes / 1048576).toFixed(2)} MB` : '  dry run, nothing written');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Every way this fails is something the person running it can act on — a
  // node that is not there, a prefab already grafted, three not installed — so
  // say which, rather than printing a stack through someone else's loader.
  main().catch((err) => {
    console.error(err.message?.includes("Cannot find package 'three'")
      ? 'This tool needs three.js to read the FBX. Install it with:\n\n  npm install --no-save three'
      : err.message ?? err);
    process.exit(1);
  });
}
