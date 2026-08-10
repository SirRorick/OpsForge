// ---------------------------------------------------------------------------
// stage-assets.mjs — fill assets/ from the raw dump
// ---------------------------------------------------------------------------
// Usage:
//   npm run stage-assets              icons and prefabs
//   npm run stage-assets -- --icons   just the icons
//   npm run stage-assets -- --prefabs just the prefabs
//   npm run stage-assets -- --size 256
//
// There is one editor, not two. `assets/` is where it looks for art, and the
// difference between the public build and the private one is only ever what is
// sitting in that folder:
//
//   assets/Icons/     library thumbnails. Committed, downscaled to 128 px.
//   assets/Prefabs/   the game's meshes. **Gitignored.** Present on your
//                     machine, absent in the repo, where the editor falls back
//                     to the stand-in shapes in src/placeholders.js.
//
// So this tool is the bridge from `reference/GameAssets/` — the raw AssetRipper
// dump, a gigabyte of it, gitignored — to the few hundred files the editor
// actually asks for. Run it after changing the catalog, and again if the dump
// is re-extracted.
//
// **The icons are the game's own art.** Downscaling them is not a legal
// argument, it is a size one: they are drawn at about 100 px and shipping five
// times that in a repository's permanent history is waste. Whether they belong
// in a public repository at all is a decision for whoever publishes it, and
// `assets/Icons/NOTICE.md` records where they came from.
//
// Textures are deliberately not staged. The prefab GLBs embed their own images
// and nothing fetches `Textures/` at runtime, so the 471 MB of them stay in the
// dump where they are useful to `tools/match-assets.mjs` and nowhere else.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodePng, encodePng } from './slice-icons.mjs';
import { BUILTIN_PACKS, WEAPON_ICONS, ENEMY_ICONS, ENEMY_MODELS } from '../src/packs.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DUMP = join(ROOT, 'reference/GameAssets');
const OUT = join(ROOT, 'assets');

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
  for (const pack of BUILTIN_PACKS) {
    for (const o of pack.objects) {
      if (o.icon) icons.add(o.icon);
      if (o.model) models.add(o.model);
    }
  }
  for (const v of Object.values(WEAPON_ICONS ?? {})) icons.add(v);
  for (const v of Object.values(ENEMY_ICONS ?? {})) icons.add(v);
  for (const v of Object.values(ENEMY_MODELS ?? {})) models.add(v);
  return { icons: [...icons].sort(), models: [...models].sort() };
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

function stageIcons(icons, size) {
  const dir = join(OUT, 'Icons');
  mkdirSync(dir, { recursive: true });
  // Clear stale icons: a renamed catalog entry should not leave its old
  // thumbnail behind in the repository for ever.
  const keep = new Set(icons.map((i) => `${i}.png`));
  keep.add('NOTICE.md');
  for (const f of readdirSync(dir)) if (!keep.has(f)) rmSync(join(dir, f));

  let bytes = 0;
  const missing = [];
  for (const name of icons) {
    const src = join(DUMP, 'Icons', `${name}.png`);
    if (!existsSync(src)) { missing.push(name); continue; }
    const png = encodePng(downscale(decodePng(readFileSync(src)), size));
    writeFileSync(join(dir, `${name}.png`), png);
    bytes += png.length;
  }
  writeFileSync(join(dir, 'NOTICE.md'), ICON_NOTICE);
  return { count: icons.length - missing.length, bytes, missing };
}

function stagePrefabs(models) {
  const dir = join(OUT, 'Prefabs');
  mkdirSync(dir, { recursive: true });
  let bytes = 0;
  const missing = [];
  for (const name of models) {
    const src = join(DUMP, 'Prefabs', `${name}.glb`);
    if (!existsSync(src)) { missing.push(name); continue; }
    writeFileSync(join(dir, `${name}.glb`), readFileSync(src));
    bytes += statSync(src).size;
  }
  writeFileSync(join(dir, 'README.md'), prefabReadme(models));
  return { count: models.length - missing.length, bytes, missing };
}

const ICON_NOTICE = `# Where these came from

These thumbnails are sliced out of Spatial Ops' own sprite atlases by
\`npm run slice-icons\`, and downscaled by \`npm run stage-assets\`. They are the
game's artwork, reproduced here so the object library is recognisable.

They are not covered by this project's licence. If you are redistributing this
editor and would rather not carry them, delete this folder — the library falls
back to rendering each object's stand-in shape as its thumbnail, and nothing
else changes.
`;

function prefabReadme(models) {
  return `# Real game models go here

This folder is empty in the repository and ignored by git. Without it the editor
draws the stand-in shapes in \`src/placeholders.js\`, which is the normal way to
run it and needs nothing from you.

To see the game's own models instead, extract Spatial Ops with AssetRipper and
copy the files below into this folder as \`.glb\`. Anything missing simply keeps
its stand-in, so a partial set is fine — drop in the barriers alone if that is
all you care about.

The **Stand-ins** switch in the toolbar flips between the two at any time, which
is the quickest way to tell whether a file landed.

${models.length} files:

${models.map((m) => `- ${m}.glb`).join('\n')}
`;
}

function main() {
  const args = process.argv.slice(2);
  const only = { icons: args.includes('--icons'), prefabs: args.includes('--prefabs') };
  const both = !only.icons && !only.prefabs;
  const sizeArg = args.indexOf('--size');
  const size = sizeArg >= 0 ? Number(args[sizeArg + 1]) : 128;
  if (!Number.isFinite(size) || size < 16) {
    console.error('--size wants a number of pixels, 16 or more.');
    process.exit(1);
  }

  const { icons, models } = requiredAssets();
  console.log(`Catalog asks for ${icons.length} icons and ${models.length} models.`);

  if (!existsSync(DUMP)) {
    console.error(`\nNo dump at ${DUMP}.`);
    console.error('That folder is the gitignored AssetRipper extraction. Without it there is');
    console.error('nothing to stage — the editor runs on its stand-in shapes regardless.');
    process.exit(1);
  }

  if (both || only.icons) {
    const r = stageIcons(icons, size);
    console.log(`Icons    ${String(r.count).padStart(4)} at ${size}px  ${mb(r.bytes).padStart(9)}  -> assets/Icons`);
    if (r.missing.length) console.log(`         ${r.missing.length} not in the dump: ${r.missing.slice(0, 4).join(', ')}${r.missing.length > 4 ? ' ...' : ''}`);
  }
  if (both || only.prefabs) {
    const r = stagePrefabs(models);
    console.log(`Prefabs  ${String(r.count).padStart(4)}            ${mb(r.bytes).padStart(9)}  -> assets/Prefabs  (gitignored)`);
    if (r.missing.length) console.log(`         ${r.missing.length} not in the dump: ${r.missing.slice(0, 4).join(', ')}${r.missing.length > 4 ? ' ...' : ''}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
