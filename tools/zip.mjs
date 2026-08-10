// ---------------------------------------------------------------------------
// zip.mjs — the smallest ZIP writer that produces a valid archive
// ---------------------------------------------------------------------------
// Node ships `zlib` but no archive format, and this project has no npm
// dependencies, so the release zip is written here: local file headers, deflated
// entries, and a central directory. About a hundred lines, and everything it
// emits is the 1989 spec that every unzipper has understood since.
//
// Deliberately narrow. No zip64, no encryption, no directory entries, no
// timestamps beyond a fixed one. Anything that needs those wants a real library
// instead of this.
//
// The fixed timestamp is on purpose: packaging the same tree twice should give
// the same bytes, so a release artefact can be compared against a rebuild.
// ---------------------------------------------------------------------------

import { deflateRawSync, crc32 } from 'node:zlib';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// 1980-01-01 00:00:00 in MS-DOS date/time, the epoch the format starts at.
const DOS_TIME = 0;
const DOS_DATE = 0x21;

/** node:zlib gained crc32 in v20.15 / v22.2; this is the fallback table. */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function checksum(buf) {
  if (typeof crc32 === 'function') return crc32(buf) >>> 0;
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Every file under `dir`, as archive-relative paths with forward slashes.
 * ZIP paths are always `/` separated whatever wrote them; a Windows `\` in
 * there produces one file with a backslash in its name rather than a folder.
 */
export function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

/**
 * Zip a directory. Entries are stored in the order `walk` finds them, which is
 * directory order — stable for the same tree on the same platform, which is all
 * the reproducibility this needs.
 */
export function zipDirectory(dir, outFile) {
  const names = walk(dir);
  const locals = [];
  const central = [];
  let offset = 0;

  for (const name of names) {
    const raw = readFileSync(join(dir, name));
    const deflated = deflateRawSync(raw, { level: 9 });
    // Storing beats deflating when deflating made it bigger, which happens on
    // anything already compressed — the PNGs and the GLBs both.
    const stored = deflated.length >= raw.length;
    const body = stored ? raw : deflated;
    const method = stored ? 0 : 8;
    const crc = checksum(raw);
    const nameBuf = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);      // local file header
    local.writeUInt16LE(20, 4);              // version needed
    local.writeUInt16LE(0x0800, 6);          // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);              // no extra field
    locals.push(local, nameBuf, body);

    const dirEntry = Buffer.alloc(46);
    dirEntry.writeUInt32LE(0x02014b50, 0);   // central directory header
    dirEntry.writeUInt16LE(20, 4);           // version made by
    dirEntry.writeUInt16LE(20, 6);           // version needed
    dirEntry.writeUInt16LE(0x0800, 8);
    dirEntry.writeUInt16LE(method, 10);
    dirEntry.writeUInt16LE(DOS_TIME, 12);
    dirEntry.writeUInt16LE(DOS_DATE, 14);
    dirEntry.writeUInt32LE(crc, 16);
    dirEntry.writeUInt32LE(body.length, 20);
    dirEntry.writeUInt32LE(raw.length, 24);
    dirEntry.writeUInt16LE(nameBuf.length, 28);
    // 30 extra len, 32 comment len, 34 disk, 36 internal attrs, 38 external
    // attrs — all zero from Buffer.alloc. 42 is the local header's offset, and
    // writing anything else there points the unzipper at the wrong bytes.
    dirEntry.writeUInt32LE(offset, 42);
    central.push(dirEntry, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);          // end of central directory
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  const archive = Buffer.concat([...locals, centralBuf, end]);
  writeFileSync(outFile, archive);
  return { file: outFile, entries: names.length, bytes: archive.length };
}
