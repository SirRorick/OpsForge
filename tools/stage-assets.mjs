// ---------------------------------------------------------------------------
// stage-assets.mjs — fill assets/ from the game's own art
// ---------------------------------------------------------------------------
// Usage:
//   npm run stage-assets                     icons and prefabs
//   npm run stage-assets -- --icons          just the icons
//   npm run stage-assets -- --prefabs        just the prefabs
//   npm run stage-assets -- --size 256       icon size (default 128)
//   npm run stage-assets -- --texture-size 0 leave prefab textures alone
//
// `assets/` is where the editor looks for art, and this is what fills it:
//
//   assets/Icons/     library thumbnails, downscaled to 128 px.
//   assets/Prefabs/   the game's meshes, textures capped at 512 px.
//
// Both are committed. They are the game's artwork, redistributed with the
// developers' permission; `assets/Icons/NOTICE.md` records where they came
// from. Anything missing from `assets/Prefabs/` falls back to the stand-in
// shapes in src/placeholders.js, so a partial folder still runs.
//
// So this tool is the bridge from `reference/GameAssets/` — the game's own
// art and definitions as the developers supplied them, a gigabyte of it and
// gitignored — to the few hundred files the editor actually asks for. Run it
// after changing the catalog, and again whenever a newer set arrives.
//
// **Both sizes are size decisions, not quality ones.** Icons are drawn at about
// 100 px and prefabs a few hundred tall in a viewport; the originals are
// 1024 px icons and 2048 px textures. Shipping several times what anyone
// will see, in a repository's permanent history where it can never be taken
// back out, is the waste worth avoiding. Pass `--texture-size 0` for the
// original resolution.
//
// Textures are deliberately not staged. The prefab GLBs embed their own images
// and nothing fetches `Textures/` at runtime, so the 471 MB of them stay in
// `reference/` where they are useful to `tools/match-assets.mjs` and nowhere
// else.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodePng, encodePng } from './slice-icons.mjs';
import { parseGlb, serialiseGlb, repack, viewBytes } from './glb.mjs';
import { BUILTIN_PACKS, WEAPON_ICONS, WEAPON_MODELS, ENEMY_ICONS, ENEMY_MODELS } from '../src/packs.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'reference/GameAssets');
const OUT = join(ROOT, 'assets');

/**
 * Art the editor asks for that the assets do not hold under that name, and how
 * to cut it out of something that does.
 *
 * There is one, and it exists because of the way the game builds that display
 * rather than because anything is missing. The jumbotron's screen is a Unity
 * canvas assembled from UI sprites at runtime, so the prefab is a frame around
 * nothing; the only picture of the assembled screen anywhere is the library
 * icon, which is a photograph of one. `crop` is that icon's frame trimmed off,
 * in its own pixels, leaving the display alone — see `screen` on the Jumbotron
 * entry in src/packs.js.
 *
 * Kept bigger than a thumbnail because it is not one: an icon is drawn at about
 * a hundred pixels in a list, and this is a surface a metre across that you can
 * walk up to in the preview.
 */
const DERIVED_ICONS = {
  Image_JumbotronScreen: {
    from: 'Icon_JumbotronSingleScreen',
    crop: { x: 29, y: 29, width: 312, height: 312 },
    size: 256,
  },
};

/**
 * Everything the running editor can ask for by name.
 *
 * Not just the catalog: the enemy spawner draws a figure of whatever it
 * produces, and the weapon spawner inspector shows a chip per weapon, so
 * ENEMY_MODELS and the two icon tables are part of the contract too. Missing
 * one of those is a silent fallback rather than an error, which is exactly the
 * sort of gap that survives a release.
 */
export function requiredAssets() {
  const icons = new Set();
  const models = new Set();
  const derived = new Set();
  for (const pack of BUILTIN_PACKS) {
    for (const o of pack.objects) {
      if (o.icon) icons.add(o.icon);
      if (o.model) models.add(o.model);
      if (o.screen?.image) derived.add(o.screen.image);
    }
  }
  for (const v of Object.values(WEAPON_ICONS ?? {})) icons.add(v);
  for (const v of Object.values(ENEMY_ICONS ?? {})) icons.add(v);
  for (const v of Object.values(ENEMY_MODELS ?? {})) models.add(v);
  for (const v of Object.values(WEAPON_MODELS ?? {})) models.add(v.model);
  return { icons: [...icons].sort(), models: [...models].sort(), derived: [...derived].sort() };
}

/** Cut a rectangle out of decoded RGBA. */
export function crop({ width, height, data }, rect) {
  const w = Math.min(rect.width, width - rect.x);
  const h = Math.min(rect.height, height - rect.y);
  if (w <= 0 || h <= 0) throw new Error('crop falls outside the image');
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    data.copy(out, y * w * 4, ((y + rect.y) * width + rect.x) * 4,
      ((y + rect.y) * width + rect.x + w) * 4);
  }
  return { width: w, height: h, data: out };
}

/**
 * Box-filter downscale of RGBA, averaging every source pixel that falls in a
 * destination cell.
 *
 * Box rather than bilinear on purpose. These are sprites on transparent
 * backgrounds, and a bilinear tap that lands between two pixels pulls in the
 * colour of fully transparent neighbours, which fringes the edges. Averaging
 * whole cells with the alpha weighted in keeps the outline clean.
 */
export function downscale({ width, height, data }, target) {
  if (width <= target && height <= target) return { width, height, data };
  const scale = target / Math.max(width, height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / w));
      let r = 0, g = 0, b = 0, a = 0, wsum = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * width + sx) * 4;
          const alpha = data[i + 3];
          // Premultiplied: a transparent pixel contributes its alpha to the
          // average but not its (undefined) colour.
          r += data[i] * alpha;
          g += data[i + 1] * alpha;
          b += data[i + 2] * alpha;
          a += alpha;
          wsum += alpha;
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = wsum ? Math.round(r / wsum) : 0;
      out[o + 1] = wsum ? Math.round(g / wsum) : 0;
      out[o + 2] = wsum ? Math.round(b / wsum) : 0;
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width: w, height: h, data: out };
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

/**
 * Cap the textures a prefab carries, and share the ones it repeats.
 *
 * The prefabs are 88% embedded PNG by weight, at up to 2048 square, and
 * that is the wrong trade for this editor twice over. Objects are drawn a few
 * hundred pixels tall in a viewport — the same argument that puts the icons at
 * 128 px — and the folder has to be small enough to live in a repository's
 * permanent history. A 2048 map on a crate is detail nobody will ever see at a
 * cost everybody pays on every clone.
 *
 * Sharing comes free alongside it and is worth more than the resizing: the five
 * street-style barriers each embed their own copy of the same 5 MB sheet, and
 * across the set that duplication is over half the bytes. `repack` folds
 * identical views into one.
 *
 * Anything that is not a plain 8-bit PNG is passed through untouched rather
 * than guessed at. The decoder is deliberately narrow and a prefab that trips
 * it should arrive intact and oversized, not mangled.
 */
export function shrinkTextures(bytes, cap) {
  const { json, bin } = parseGlb(bytes);
  const images = new Map();   // buffer view index -> replacement bytes
  let before = 0, after = 0, resized = 0;

  for (const image of json.images ?? []) {
    if (image.bufferView === undefined || images.has(image.bufferView)) continue;
    const src = viewBytes(json, bin, image.bufferView);
    before += src.length;
    let out = src;
    try {
      const px = decodePng(src);
      if (Math.max(px.width, px.height) > cap) resized++;
      // Re-encoded even at its existing size: the originals are written for
      // speed, and a Paeth filter at deflate level 9 takes a third off them
      // without touching a pixel.
      out = encodePng(downscale(px, cap));
      if (out.length >= src.length) out = src;
    } catch {
      // Not a PNG this decoder handles — a JPEG, 16-bit, or interlaced.
    }
    after += out.length;
    images.set(image.bufferView, out);
  }

  const packed = repack(json, bin, (i) => images.get(i) ?? null);
  return {
    bytes: serialiseGlb(packed.json, packed.bin),
    before, after, resized, shared: packed.shared,
  };
}

function stageIcons(icons, derived, size) {
  const dir = join(OUT, 'Icons');
  mkdirSync(dir, { recursive: true });
  // Clear stale icons: a renamed catalog entry should not leave its old
  // thumbnail behind in the repository for ever.
  const keep = new Set([...icons, ...derived].map((i) => `${i}.png`));
  keep.add('NOTICE.md');
  for (const f of readdirSync(dir)) if (!keep.has(f)) rmSync(join(dir, f));

  let bytes = 0;
  const missing = [];
  const write = (name, png) => {
    writeFileSync(join(dir, `${name}.png`), png);
    bytes += png.length;
  };
  for (const name of icons) {
    const src = join(SOURCE, 'Icons', `${name}.png`);
    if (!existsSync(src)) { missing.push(name); continue; }
    write(name, encodePng(downscale(decodePng(readFileSync(src)), size)));
  }
  for (const name of derived) {
    const spec = DERIVED_ICONS[name];
    if (!spec) { missing.push(name); continue; }
    const src = join(SOURCE, 'Icons', `${spec.from}.png`);
    if (!existsSync(src)) { missing.push(name); continue; }
    write(name, encodePng(downscale(crop(decodePng(readFileSync(src)), spec.crop), spec.size)));
  }
  writeFileSync(join(dir, 'NOTICE.md'), ICON_NOTICE);
  return { count: icons.length + derived.length - missing.length, bytes, missing };
}

function stagePrefabs(models, cap, onProgress) {
  const dir = join(OUT, 'Prefabs');
  mkdirSync(dir, { recursive: true });
  // Clear stale models, the way the icons are cleared: a renamed catalog entry
  // should not leave ten megabytes behind in the repository for ever.
  const keep = new Set(models.map((m) => `${m}.glb`));
  keep.add('README.md');
  for (const f of readdirSync(dir)) if (!keep.has(f)) rmSync(join(dir, f));

  let bytes = 0, raw = 0, resized = 0, shared = 0;
  const missing = [];
  for (const [i, name] of models.entries()) {
    const src = join(SOURCE, 'Prefabs', `${name}.glb`);
    if (!existsSync(src)) { missing.push(name); continue; }
    onProgress?.(i + 1, models.length, name);
    raw += statSync(src).size;
    let out = readFileSync(src);
    if (cap) {
      const r = shrinkTextures(out, cap);
      out = r.bytes;
      resized += r.resized;
      shared += r.shared;
    }
    writeFileSync(join(dir, `${name}.glb`), out);
    bytes += out.length;
  }
  writeFileSync(join(dir, 'README.md'), prefabReadme(models));
  return { count: models.length - missing.length, bytes, raw, resized, shared, missing };
}

const ICON_NOTICE = `# Where these came from

These thumbnails are sliced out of Spatial Ops' own sprite atlases by
\`npm run slice-icons\`, and downscaled to 128 px by \`npm run stage-assets\`.

\`Image_*\` files are not thumbnails. They are the same artwork cropped and kept
larger because the editor draws them as surfaces in the scene rather than as
icons in a list — \`Image_JumbotronScreen\` is the jumbotron's display, which the
prefab itself does not carry, because the game assembles it from UI sprites at
runtime.

They are the game's artwork, owned by its makers and included here with their
permission to redistribute them with this editor. That permission covers this
project; it is not a grant to reuse the artwork anywhere else. See
[LICENSE.md](../../LICENSE.md), section 5.

If you fork this and would rather not carry them, delete the folder: the
library falls back to drawing each object's stand-in shape as its thumbnail,
and nothing else changes.
`;

function prefabReadme(models) {
  return `# The game's models

Spatial Ops' own meshes, which is what the editor draws by default. They are
written here by \`npm run stage-assets\`, which caps their textures at 512 px —
objects are drawn a few hundred pixels tall in a viewport, and the 2048 px
originals are four hundred megabytes of detail nobody sees.

Like \`../Icons\`, these are the game's artwork, owned by its makers and included
with their permission to redistribute them with this editor. That permission
covers this project; it is not a grant to reuse the models anywhere else. See
[LICENSE.md](../../LICENSE.md), section 5.

Delete any of them and that object falls back to its stand-in shape from
\`src/placeholders.js\` — a partial folder is fine, and an empty one still runs.
The **Stand-ins** switch in the toolbar flips between the two at any time.

${models.length} files:

${models.map((m) => `- ${m}.glb`).join('\n')}
`;
}

function main() {
  const args = process.argv.slice(2);
  const only = { icons: args.includes('--icons'), prefabs: args.includes('--prefabs') };
  const both = !only.icons && !only.prefabs;
  const number = (flag, fallback, floor) => {
    const i = args.indexOf(flag);
    if (i < 0) return fallback;
    const n = Number(args[i + 1]);
    if (!Number.isFinite(n) || (n !== 0 && n < floor)) {
      console.error(`${flag} wants a number of pixels, ${floor} or more (or 0 to leave them alone).`);
      process.exit(1);
    }
    return n;
  };
  const size = number('--size', 128, 16);
  const cap = number('--texture-size', 512, 64);

  const { icons, models, derived } = requiredAssets();
  console.log(`Catalog asks for ${icons.length + derived.length} icons and ${models.length} models.`);

  if (!existsSync(SOURCE)) {
    console.error(`\nNo game assets at ${SOURCE}.`);
    console.error('That folder is the gitignored game assets. Without them');
    console.error('there is nothing to stage — the editor runs on its stand-ins.');
    process.exit(1);
  }

  if (both || only.icons) {
    const r = stageIcons(icons, derived, size);
    console.log(`Icons    ${String(r.count).padStart(4)} at ${size}px  ${mb(r.bytes).padStart(9)}  -> assets/Icons`);
    if (r.missing.length) console.log(`         ${r.missing.length} not among the assets: ${r.missing.slice(0, 4).join(', ')}${r.missing.length > 4 ? ' ...' : ''}`);
  }
  if (both || only.prefabs) {
    // Re-encoding 180 prefabs takes a minute and a half, so say where it is up
    // to — but only to a terminal. Piped to a file, 180 lines of progress are
    // just noise around the one line that matters.
    const tick = (n, of, name) => {
      process.stdout.write(`\rPrefabs  ${String(n).padStart(4)}/${of}  ${name.slice(0, 34).padEnd(34)}`);
    };
    const r = stagePrefabs(models, cap, cap && process.stdout.isTTY ? tick : null);
    if (process.stdout.isTTY) process.stdout.write(`\r${' '.repeat(56)}\r`);
    const at = cap ? ` at ${cap}px` : '';
    console.log(`Prefabs  ${String(r.count).padStart(4)}${at.padEnd(12)}${mb(r.bytes).padStart(9)}  -> assets/Prefabs`);
    if (cap) {
      console.log(`         ${r.resized} textures resized, ${r.shared} duplicate views shared, ` +
        `down from ${mb(r.raw)} (${(100 - (r.bytes / r.raw) * 100).toFixed(0)}% off)`);
    }
    if (r.missing.length) console.log(`         ${r.missing.length} not among the assets: ${r.missing.slice(0, 4).join(', ')}${r.missing.length > 4 ? ' ...' : ''}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
