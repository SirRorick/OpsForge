// ---------------------------------------------------------------------------
// slice-icons.mjs — cut every sprite out of the packed atlases
// ---------------------------------------------------------------------------
// Usage:  npm run slice-icons -- [--filter <substr>] [--out <dir>] [--dry-run]
//
// Reads the game's sprite sheets and writes one cropped PNG per sprite to
// reference/GameAssets/Icons/.
//
//   reference/GameAssets/Sprite/*.json      one per sprite: its packed rect and
//                                           the PathID of the texture it is on
//   reference/GameAssets/SpriteAtlas/*.json which sprites an atlas owns, and
//                                           the texture PathIDs of its pages
//   reference/GameAssets/Textures/sactx-*   the packed sheets themselves
//
// Zero dependencies. The sheets are 8-bit non-interlaced PNG throughout
// (checked
// across all 693 files: 682 RGBA, 11 RGB), so node:zlib plus ~80 lines of
// filtering is a complete codec for it. A general-purpose PNG library would
// carry 16-bit, palette and Adam7 paths this data never exercises.
//
// Two things that are easy to get wrong and are therefore load-bearing here:
//
// **The Y axis is flipped.** Unity sprite rects are measured from the atlas's
// bottom-left; PNG rows run top-down. The source row for a sprite of height h
// at rect y is `pageHeight - (y + h)`, not `y`. Getting this wrong yields a
// plausible-looking crop of a neighbouring icon rather than an obvious error,
// so `npm run slice-icons` prints Icon_Crate's provenance and the check is to
// open the file: it must be a crate.
//
// **PathID -> page is positional.** A sprite names its texture by PathID, and
// nothing in the sprite metadata maps a PathID to a filename. The atlas JSON
// lists the
// PathIDs of its own pages, and the pages are on disk as `sactx-<n>-...`, so
// the nth-lowest PathID is page n. That is an inference, and `--dry-run`
// re-checks it the way it was established: every sprite rect must fit inside
// the page it lands on. It holds for all 633 packed sprites, including the
// three atlases whose last page is half-height and would catch a misordering.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync, deflateSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'reference/GameAssets');
const SPRITES = join(ASSETS, 'Sprite');
const ATLASES = join(ASSETS, 'SpriteAtlas');
const TEXTURES = join(ASSETS, 'Textures');
const OUT = join(ASSETS, 'Icons');

// --- PNG ---------------------------------------------------------------------

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decode to a tightly packed RGBA buffer. Throws on anything these are not. */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('not a PNG');
  let pos = 8, width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
  if (interlace !== 0) throw new Error('interlaced PNG unsupported');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let off = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[off++];
    const line = Buffer.from(raw.subarray(off, off + stride));
    off += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      else if (filter !== 0) throw new Error(`bad filter ${filter} on row ${y}`);
      line[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels, d = (y * width + x) * 4;
      if (channels >= 3) {
        out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2];
        out[d + 3] = channels === 4 ? line[s + 3] : 255;
      } else {
        out[d] = out[d + 1] = out[d + 2] = line[s];
        out[d + 3] = channels === 2 ? line[s + 1] : 255;
      }
    }
    prev = line;
  }
  return { width, height, data: out };
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * Encode RGBA. Paeth-filtered throughout, which is what these icons like.
 *
 * The alpha channel is dropped when every pixel is opaque. That is lossless by
 * definition and it is not a micro-optimisation: it takes a quarter off the
 * bytes the filter and deflate then have to chew through, and the prefab
 * textures — where this matters, hundreds of megabytes of them — are mostly
 * diffuse maps with no transparency at all. Icons are sprites on a transparent
 * background, so they keep their alpha and nothing about them changes.
 */
export function encodePng({ width, height, data }) {
  let opaque = true;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) { opaque = false; break; }
  }
  const channels = opaque ? 3 : 4;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    // Repack to RGB on the way in when there is no alpha to carry.
    let line;
    if (opaque) {
      line = Buffer.alloc(stride);
      for (let x = 0; x < width; x++) {
        const s = (y * width + x) * 4;
        line[x * 3] = data[s]; line[x * 3 + 1] = data[s + 1]; line[x * 3 + 2] = data[s + 2];
      }
    } else {
      line = data.subarray(y * stride, (y + 1) * stride);
    }
    const o = y * (stride + 1);
    raw[o] = 4;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const c = i >= channels ? prev[i - channels] : 0;
      raw[o + 1 + i] = (line[i] - paeth(a, prev[i], c)) & 0xff;
    }
    prev = line;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = opaque ? 2 : 6;
  return Buffer.concat([
    PNG_MAGIC,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Copy a rect out of a decoded page, flipping the Y axis on the way: Unity
 * measures `rect.y` up from the bottom of the sheet, PNG row 0 is the top.
 */
function cropFlipped(page, rect) {
  const { x, y, w, h } = rect;
  const top = page.height - (y + h);
  const out = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row++) {
    const src = ((top + row) * page.width + x) * 4;
    page.data.copy(out, row * w * 4, src, src + w * 4);
  }
  return { width: w, height: h, data: out };
}

// --- the sprite sheets -------------------------------------------------------

/** Atlas pages on disk, grouped by atlas name and ordered by their page index. */
function loadPages() {
  const pages = {};
  for (const f of readdirSync(TEXTURES)) {
    const m = /^sactx-(\d+)-(\d+)x(\d+)-.*-(.+)-[0-9a-f]{8}\.png$/.exec(f);
    if (!m) continue;
    (pages[m[4]] ??= []).push({ index: +m[1], file: f, width: +m[2], height: +m[3] });
  }
  for (const list of Object.values(pages)) list.sort((a, b) => a.index - b.index);
  return pages;
}

/** texture PathID -> the page it names, via the positional rule above. */
function mapTextureIds(pages) {
  const byId = new Map();
  for (const f of readdirSync(ATLASES)) {
    if (!f.endsWith('.json')) continue;
    const atlas = JSON.parse(readFileSync(join(ATLASES, f), 'utf8'));
    const ids = [...new Set((atlas.m_RenderDataMap ?? [])
      .map((e) => e.Value?.m_Texture?.m_PathID).filter(Boolean))].sort((a, b) => a - b);
    const list = pages[atlas.m_Name] ?? [];
    if (ids.length !== list.length) {
      console.warn(`  ! ${atlas.m_Name}: ${ids.length} texture ids but ${list.length} pages on disk`);
    }
    ids.forEach((id, i) => { if (list[i]) byId.set(id, { atlas: atlas.m_Name, page: list[i] }); });
  }
  return byId;
}

function loadSprites() {
  const out = [];
  for (const f of readdirSync(SPRITES)) {
    if (!f.endsWith('.json')) continue;
    const s = JSON.parse(readFileSync(join(SPRITES, f), 'utf8'));
    const rd = s.m_RD ?? {};
    const r = rd.m_TextureRect ?? s.m_Rect;
    if (!r?.m_Width || !r?.m_Height) continue;
    out.push({
      name: s.m_Name,
      stem: f.slice(0, -5),
      textureId: rd.m_Texture?.m_PathID ?? 0,
      packed: (rd.m_SettingsRaw & 1) === 1,
      rotation: (rd.m_SettingsRaw >> 2) & 0xf,
      // Atlas-packed rects are whole pixels, but a trimmed standalone sprite
      // can carry a fractional one — TPBulletHoleConcrete's height overshoots
      // its 512px texture by 1.2e-5, which a strict bounds check would reject.
      rect: {
        x: Math.round(r.m_X), y: Math.round(r.m_Y),
        w: Math.round(r.m_Width), h: Math.round(r.m_Height),
      },
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Windows rejects these outright, and some sprite names carry spaces.
const safeName = (n) => n.replace(/[<>:"/\\|?*]/g, '_').trim();

/**
 * Output filename per sprite. `m_Name` is not unique — five distinct sprites
 * are all called `Icon_BoxSolid`, one per theme, and naming the files after
 * m_Name alone silently overwrites four of them. Where a name is shared, fall
 * back to the asset filename (`Icon_BoxSolid_2`), which the assets guarantee is
 * unique; the ~90% of sprites with a unique name keep it unchanged.
 *
 * Uniqueness is judged case-insensitively because the tool has to work on
 * Windows, where `LabRats_Briefing` and `Labrats_Briefing` — two real and
 * different sprites — are the same file. A numeric suffix settles anything
 * still colliding after the fallback, since those two differ in their asset
 * filenames only by case as well.
 */
function outputNames(sprites) {
  const counts = new Map();
  for (const s of sprites) {
    const k = s.name.toLowerCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const used = new Set();
  const names = new Map();
  for (const s of sprites) {
    const base = safeName(counts.get(s.name.toLowerCase()) > 1 ? s.stem : s.name);
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base}_${i}`;
    used.add(name.toLowerCase());
    names.set(s, name);
  }
  return names;
}

// --- main --------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const filter = opt('--filter');
  const dryRun = args.includes('--dry-run');
  const outDir = opt('--out') ?? OUT;

  if (!existsSync(SPRITES)) {
    console.error(`No sprites at ${SPRITES}. This tool needs the (gitignored) assets.`);
    process.exit(1);
  }

  const pages = loadPages();
  const byId = mapTextureIds(pages);
  let sprites = loadSprites();
  // Uniqueness is decided over the whole set, so a --filter run names its
  // files exactly as a full run would.
  const names = outputNames(sprites);
  const shared = sprites.filter((s) => names.get(s) !== safeName(s.name)).length;
  if (filter) sprites = sprites.filter((s) => s.name.toLowerCase().includes(filter.toLowerCase()));

  // Standalone (unpacked) sprites are their own texture rather than a sheet;
  // the assets name those files after the sprite.
  const textureFiles = new Set(readdirSync(TEXTURES));
  const jobs = new Map();   // page file -> sprites to cut from it
  const skipped = [];
  let rotated = 0;

  for (const s of sprites) {
    if (s.rotation !== 0) { rotated++; skipped.push(`${s.name}: packed with rotation ${s.rotation}`); continue; }
    const hit = byId.get(s.textureId);
    // A sprite cut from a plain spritesheet rather than a packed atlas keeps
    // the sheet's name with an index appended (lock_icon_spritesheet_small_3),
    // so fall back to the base name once the exact one misses.
    const sheet = s.name.replace(/_\d+$/, '');
    let file;
    if (hit) file = hit.page.file;
    else if (textureFiles.has(`${s.name}.png`)) file = `${s.name}.png`;
    else if (textureFiles.has(`${sheet}.png`)) file = `${sheet}.png`;
    else { skipped.push(`${s.name}: texture ${s.textureId} is in no atlas and has no standalone PNG`); continue; }
    if (!jobs.has(file)) jobs.set(file, []);
    jobs.get(file).push(s);
  }

  if (!dryRun) mkdirSync(outDir, { recursive: true });

  let written = 0, oob = 0;
  const provenance = [];
  for (const [file, list] of [...jobs].sort()) {
    const page = decodePng(readFileSync(join(TEXTURES, file)));
    for (const s of list) {
      const { x, y, w, h } = s.rect;
      if (x < 0 || y < 0 || x + w > page.width || y + h > page.height) {
        skipped.push(`${s.name}: rect ${x},${y} ${w}x${h} does not fit ${file} (${page.width}x${page.height})`);
        oob++;
        continue;
      }
      if (s.name === 'Icon_Crate' || filter) {
        provenance.push(`${names.get(s)}.png  <-  ${file}  rect=${x},${y} ${w}x${h}  ` +
          `png rows ${page.height - (y + h)}..${page.height - y - 1}`);
      }
      if (!dryRun) writeFileSync(join(outDir, `${names.get(s)}.png`), encodePng(cropFlipped(page, s.rect)));
      written++;
    }
  }

  console.log(`${dryRun ? 'Would write' : 'Wrote'} ${written} icons to ${outDir}`);
  console.log(`  ${jobs.size} source sheets, ${skipped.length} skipped` +
    (rotated ? `, ${rotated} rotated` : '') + (oob ? `, ${oob} out of bounds` : '') +
    (shared ? `, ${shared} named after their asset to avoid a shared m_Name` : ''));
  if (provenance.length) {
    console.log('\nProvenance (open the file and confirm it is what it says):');
    provenance.forEach((p) => console.log('  ' + p));
  }
  if (skipped.length) {
    console.log('\nSkipped:');
    skipped.slice(0, 20).forEach((s) => console.log('  ' + s));
    if (skipped.length > 20) console.log(`  ... and ${skipped.length - 20} more`);
  }
}

// Guarded so the PNG codec above can be imported — stage-assets reuses it to
// downscale the icons — without the slicer running as a side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
