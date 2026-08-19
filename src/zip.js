// ---------------------------------------------------------------------------
// zip.js — read and write ZIP archives in the browser
// ---------------------------------------------------------------------------
// The browser side of `tools/zip.mjs`: same header layout, same
// store-when-deflating-made-it-bigger rule, same CRC32 table, because a
// downloaded map has to unzip and an uploaded one has to zip, and there is no
// reason for the two ends of that round trip to disagree. Two substitutions
// carry the port: `CompressionStream`/`DecompressionStream('deflate-raw')`
// stand in for `node:zlib`, and `DataView`/`Uint8Array` stand in for `Buffer`.
//
// Deliberately as narrow as its Node sibling: store and deflate only, no
// zip64, no encryption. A map is 2-4 KB.
// ---------------------------------------------------------------------------

// 1980-01-01 00:00:00 in MS-DOS date/time, the epoch the format starts at.
const DOS_TIME = 0;
const DOS_DATE = 0x21;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function checksum(bytes) {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

async function pipeThrough(bytes, Ctor, name) {
  const stream = new Ctor(name);
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

const deflateRaw = (bytes) => pipeThrough(bytes, CompressionStream, 'deflate-raw');
const inflateRaw = (bytes) => pipeThrough(bytes, DecompressionStream, 'deflate-raw');

/** The PK\x03\x04 magic every ZIP local file header starts with. */
export function zipLooksLikeArchive(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

/**
 * `[{name, data}]` -> `Blob`. `data` is a string (encoded as UTF-8) or bytes.
 * Entries are written in the order given, mirroring `tools/zip.mjs`.
 */
export async function zipWrite(entries) {
  const enc = new TextEncoder();
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const raw = typeof data === 'string' ? enc.encode(data) : new Uint8Array(data);
    const deflated = await deflateRaw(raw);
    // Storing beats deflating when deflating made it bigger.
    const stored = deflated.length >= raw.length;
    const body = stored ? raw : deflated;
    const method = stored ? 0 : 8;
    const crc = checksum(raw);
    const nameBytes = enc.encode(name);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);  // local file header
    local.setUint16(4, 20, true);          // version needed
    local.setUint16(6, 0x0800, true);      // UTF-8 names
    local.setUint16(8, method, true);
    local.setUint16(10, DOS_TIME, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);          // no extra field
    locals.push(new Uint8Array(local.buffer), nameBytes, body);

    const dirEntry = new DataView(new ArrayBuffer(46));
    dirEntry.setUint32(0, 0x02014b50, true); // central directory header
    dirEntry.setUint16(4, 20, true);         // version made by
    dirEntry.setUint16(6, 20, true);         // version needed
    dirEntry.setUint16(8, 0x0800, true);
    dirEntry.setUint16(10, method, true);
    dirEntry.setUint16(12, DOS_TIME, true);
    dirEntry.setUint16(14, DOS_DATE, true);
    dirEntry.setUint32(16, crc, true);
    dirEntry.setUint32(20, body.length, true);
    dirEntry.setUint32(24, raw.length, true);
    dirEntry.setUint16(28, nameBytes.length, true);
    // 30 extra len, 32 comment len, 34 disk, 36 internal attrs, 38 external
    // attrs — all zero. 42 is the local header's offset.
    dirEntry.setUint32(42, offset, true);
    central.push(new Uint8Array(dirEntry.buffer), nameBytes);

    offset += local.byteLength + nameBytes.length + body.length;
  }

  const centralLength = central.reduce((n, part) => n + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); // end of central directory
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralLength, true);
  end.setUint32(16, offset, true);

  return new Blob([...locals, ...central, new Uint8Array(end.buffer)]);
}

/**
 * The Zip64 extended-information field mod.io's own uploads carry — .NET's
 * `ZipArchive` writes one on every entry, small files included, rather than
 * only where a 32-bit size would overflow. Where a central-directory field
 * reads as the `0xFFFFFFFF` sentinel, its real value is an 8-byte field inside
 * this extra record instead, in a fixed order: uncompressed size first,
 * compressed size second, local header offset third — present only for the
 * fields that were actually sentinels.
 */
function readZip64Sizes(view, extraStart, extraLen, compSize, uncompSize, localOffset) {
  let p = extraStart;
  const end = extraStart + extraLen;
  while (p + 4 <= end) {
    const id = view.getUint16(p, true);
    const size = view.getUint16(p + 2, true);
    if (id === 0x0001) {
      let q = p + 4;
      if (uncompSize === 0xffffffff) { uncompSize = Number(view.getBigUint64(q, true)); q += 8; }
      if (compSize === 0xffffffff) { compSize = Number(view.getBigUint64(q, true)); q += 8; }
      if (localOffset === 0xffffffff) { localOffset = Number(view.getBigUint64(q, true)); q += 8; }
      break;
    }
    p += 4 + size;
  }
  return { compSize, uncompSize, localOffset };
}

/** `ArrayBuffer` -> `[{name, bytes}]`, read by walking the central directory. */
export async function zipRead(arrayBuffer) {
  const buf = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);

  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip archive (no end-of-central-directory record)');

  const count = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const dec = new TextDecoder();

  const entries = [];
  let p = centralOffset;
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('Malformed central directory');
    const method = view.getUint16(p + 10, true);
    let compSize = view.getUint32(p + 20, true);
    let uncompSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    let localOffset = view.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));

    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      ({ compSize, uncompSize, localOffset } =
        readZip64Sizes(view, p + 46 + nameLen, extraLen, compSize, uncompSize, localOffset));
    }

    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const compData = buf.subarray(dataStart, dataStart + compSize);

    let bytes;
    if (method === 0) bytes = compData;
    else if (method === 8) bytes = await inflateRaw(compData);
    else throw new Error(`Unsupported zip compression method ${method}`);

    entries.push({ name, bytes });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
