// ---------------------------------------------------------------------------
// glb.mjs — read, write and repack binary glTF
// ---------------------------------------------------------------------------
// A .glb is a 12-byte header and a run of chunks: one JSON chunk describing the
// scene, one BIN chunk holding everything the JSON points into by byte offset.
// That is the whole format, and it is small enough to handle here rather than
// take a dependency for.
//
// The offsets are the catch. Nothing in a .glb is self-delimiting — an accessor
// says "24 bytes into buffer view 7" and a buffer view says "1.2 MB into the
// buffer" — so changing the size of anything means rewriting every offset after
// it. `repack` is the one function that knows how, and both callers go through
// it rather than doing arithmetic of their own.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs';

const GLB_MAGIC = 0x46546c67;   // 'glTF'
const CHUNK_JSON = 0x4e4f534a;  // 'JSON'
const CHUNK_BIN = 0x004e4942;   // 'BIN\0'

export function parseGlb(buf) {
  if (buf.length < 12 || buf.readUInt32LE(0) !== GLB_MAGIC) {
    throw new Error('not a binary glTF');
  }
  let off = 12, json = null, bin = Buffer.alloc(0);
  while (off + 8 <= buf.length) {
    const length = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + length);
    if (type === CHUNK_JSON) json = JSON.parse(data.toString('utf8'));
    else if (type === CHUNK_BIN) bin = Buffer.from(data);
    off += 8 + length;
  }
  if (!json) throw new Error('no JSON chunk');
  return { json, bin };
}

export const readGlb = (file) => parseGlb(readFileSync(file));

/** Pad to the 4-byte boundary every chunk and buffer view is aligned to. */
const padTo4 = (buf, fill) => {
  const slack = (4 - (buf.length % 4)) % 4;
  return slack ? Buffer.concat([buf, Buffer.alloc(slack, fill)]) : buf;
};

export function serialiseGlb(json, bin) {
  const jsonChunk = padTo4(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const binChunk = padTo4(bin, 0);
  const parts = [Buffer.alloc(12)];
  const chunk = (data, type) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(data.length, 0);
    head.writeUInt32LE(type, 4);
    parts.push(head, data);
  };
  chunk(jsonChunk, CHUNK_JSON);
  if (binChunk.length) chunk(binChunk, CHUNK_BIN);

  const total = parts.reduce((n, p) => n + p.length, 0);
  parts[0].writeUInt32LE(GLB_MAGIC, 0);
  parts[0].writeUInt32LE(2, 4);
  parts[0].writeUInt32LE(total, 8);
  return Buffer.concat(parts);
}

export function writeGlb(file, json, bin) {
  const out = serialiseGlb(json, bin);
  writeFileSync(file, out);
  return out.length;
}

/** The bytes a buffer view covers. */
export function viewBytes(json, bin, index) {
  const v = json.bufferViews[index];
  const off = v.byteOffset ?? 0;
  return bin.subarray(off, off + v.byteLength);
}

/**
 * Rebuild the BIN chunk, giving `replace` a chance to swap any view's contents.
 *
 * Views come out in their existing order and keep their contents byte for byte
 * unless replaced, which is what makes this safe: an accessor addresses its
 * data as an offset *within* a view, so as long as a view's bytes are intact
 * every accessor pointing into it still is. Only the views themselves move, and
 * their `byteOffset` is rewritten to say so.
 *
 * Two views that end up with identical bytes are emitted once and shared. That
 * is the single biggest saving available here — the dump embeds the same 5 MB
 * texture in each of the five street-style barriers — and it is free, because
 * a buffer view is a read-only window and nothing can tell two apart.
 *
 * Views left unreferenced by the sharing are dropped, so every index in the
 * JSON has to be renumbered; `remap` below is not optional tidying.
 */
export function repack(json, bin, replace = () => null) {
  const chunks = [];
  const emitted = new Map();   // payload hash -> new view index
  const remap = new Map();     // old view index -> new view index
  const views = [];
  let offset = 0;

  for (let i = 0; i < (json.bufferViews ?? []).length; i++) {
    const old = json.bufferViews[i];
    const bytes = replace(i, viewBytes(json, bin, i)) ?? viewBytes(json, bin, i);

    // Only views whose whole contents are one opaque blob may be shared —
    // an image is, a vertex buffer several accessors carve up is not, because
    // two of those can hold the same bytes and mean different things only by
    // way of the byteStride and offsets pointing into them.
    const shareable = old.byteStride === undefined && !old.target;
    const key = shareable ? `${bytes.length}:${bytes.toString('latin1')}` : null;
    if (key !== null && emitted.has(key)) {
      remap.set(i, emitted.get(key));
      continue;
    }

    const slack = (4 - (offset % 4)) % 4;
    if (slack) { chunks.push(Buffer.alloc(slack)); offset += slack; }
    const next = { ...old, byteOffset: offset, byteLength: bytes.length };
    delete next.buffer;
    views.push({ buffer: 0, ...next });
    chunks.push(bytes);
    offset += bytes.length;

    remap.set(i, views.length - 1);
    if (key !== null) emitted.set(key, views.length - 1);
  }

  const at = (index) => {
    const to = remap.get(index);
    if (to === undefined) throw new Error(`buffer view ${index} vanished during repack`);
    return to;
  };
  for (const a of json.accessors ?? []) {
    if (a.bufferView !== undefined) a.bufferView = at(a.bufferView);
    if (a.sparse) {
      a.sparse.indices.bufferView = at(a.sparse.indices.bufferView);
      a.sparse.values.bufferView = at(a.sparse.values.bufferView);
    }
  }
  for (const im of json.images ?? []) {
    if (im.bufferView !== undefined) im.bufferView = at(im.bufferView);
  }

  const buffer = Buffer.concat(chunks);
  json.bufferViews = views;
  json.buffers = [{ byteLength: buffer.length }];
  return { json, bin: buffer, shared: remap.size - views.length };
}
