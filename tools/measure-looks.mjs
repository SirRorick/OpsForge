// ---------------------------------------------------------------------------
// measure-looks.mjs — what colour every piece really is
// ---------------------------------------------------------------------------
// Usage:  npm run measure-looks            rewrite src/looks.js
//         npm run measure-looks -- --print  show the table, write nothing
//
// The catalog has carried a `color` since before the game's art was in the
// repository, and it is the stand-in's: the tint the procedural placeholder is
// painted when the real model is absent. It was chosen to tell themes apart at
// a glance, not to describe them, and it describes most of them badly — Camo's
// is a blue-grey where the art is tan brick and green camouflage, and Mykea's
// is a light tan where the art is bookshelves, a blue sofa and dark red
// upholstery. The assistant was being told those colours, and picking pieces
// for "a red wall" or "something wooden" by them.
//
// So this measures the real thing. Each library icon is the game's own render
// of the piece, lit and textured as a player sees it, and this reads the
// colours off it: every opaque pixel, less the pale outline every icon is
// drawn with, clustered into the few colours that cover most of it. What it
// writes is a measurement, the way `size` in packs.js is — no pixel of the art
// is copied, only the shares of a handful of averages.
//
// The words (`look` in packs.js) are the other half and are written by hand:
// "a tall wooden bookshelf" is not something an average colour can say.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodePng } from './slice-icons.mjs';
import { BUILTIN_PACKS } from '../src/packs.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = join(ROOT, 'assets/Icons');
const OUT = join(ROOT, 'src/looks.js');

const MAX_COLOURS = 3;
const MIN_SHARE = 0.12;       // a colour covering less of the piece than this is a detail
const K = 5;                  // clusters tried before small and similar ones are dropped

// -- colour arithmetic --------------------------------------------------------

const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };

/** sRGB 0-255 to CIE Lab, which is where "near" means near to an eye. */
export function toLab([r, g, b]) {
  const R = lin(r), G = lin(g), B = lin(b);
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

function hsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

/**
 * A plain English name for a colour, from a short fixed list. Plain on purpose:
 * this is read by a model choosing between "brown" and "red" for somebody who
 * asked for one of them, and a paint chart's name helps nobody do that.
 */
export function colourName(rgb) {
  const [h, s, l] = hsl(rgb);
  if (s < 0.14 || l < 0.08 || l > 0.94) {
    if (l < 0.13) return 'black';
    if (l < 0.3) return 'dark grey';
    if (l < 0.62) return 'grey';
    if (l < 0.86) return 'light grey';
    return 'white';
  }
  const dark = l < 0.3, light = l > 0.68;
  // Red with the colour drained out of it is wood, not paint: a mahogany
  // bookshelf and a saloon door both measure as a dull red, and "red" would
  // send somebody asking for a red wall to a bookcase.
  const reddish = (h >= 320 && (s < 0.5 || l < 0.35)) || h < 14 || (h < 25 && s < 0.35);
  let base;
  if (reddish) base = s < 0.35 ? (l < 0.22 ? 'dark brown' : 'reddish brown') : 'red';
  else if (h < 42) base = s >= 0.45 ? 'orange' : (l < 0.45 ? 'brown' : 'tan');
  else if (h < 66) base = l < 0.42 ? 'olive' : (s < 0.4 ? 'tan' : 'yellow');
  else if (h < 160) base = h < 90 && l < 0.45 ? 'olive' : 'green';
  else if (h < 196) base = 'teal';
  else if (h < 250) base = dark ? 'navy' : 'blue';
  else if (h < 290) base = 'purple';
  else base = light ? 'pink' : 'magenta';
  if (['brown', 'dark brown', 'reddish brown', 'olive', 'navy', 'tan'].includes(base)) return base;
  if (dark) return `dark ${base}`;
  if (light) return `light ${base}`;
  return base;
}

const hex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

// -- reading an icon ----------------------------------------------------------

/**
 * The pixels that are the piece. Opaque only, and not the outline: every icon
 * is drawn with a pale rim a couple of pixels wide, which is the icon's and
 * not the object's, so near-white pixels with almost no colour in them are
 * dropped. A piece that is genuinely white keeps its body, which is far wider
 * than any rim.
 */
function piecePixels({ width, height, data }) {
  const out = [];
  for (let i = 0; i < width * height; i++) {
    const a = data[i * 4 + 3];
    if (a < 250) continue;
    const rgb = [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
    const [h, s, l] = hsl(rgb);
    if (l > 0.86 && s < 0.35) continue;
    // The rim itself is a pale cyan glow, not white.
    if (l > 0.8 && h >= 160 && h < 205) continue;
    out.push(rgb);
  }
  return out;
}

/** k-means in Lab, seeded deterministically, so the file is the same every run. */
function clusters(pixels) {
  if (!pixels.length) return [];
  const labs = pixels.map(toLab);
  // Seeds spread through the pixels in lightness order: the same every run,
  // and one from each part of the range rather than five from the darkest.
  const order = labs.map((_, i) => i).sort((a, b) => labs[a][0] - labs[b][0]);
  let centres = Array.from({ length: K }, (_, k) => labs[order[Math.floor(((k + 0.5) / K) * order.length)]]);
  let assign = new Array(labs.length).fill(0);
  for (let iter = 0; iter < 20; iter++) {
    assign = labs.map((p) => {
      let best = 0, bd = Infinity;
      centres.forEach((c, k) => { const d = dist2(p, c); if (d < bd) { bd = d; best = k; } });
      return best;
    });
    centres = centres.map((c, k) => {
      const mine = labs.filter((_, i) => assign[i] === k);
      if (!mine.length) return c;
      return [0, 1, 2].map((j) => mine.reduce((n, p) => n + p[j], 0) / mine.length);
    });
  }
  const groups = centres.map((_, k) => {
    const members = pixels.filter((_, i) => assign[i] === k);
    const rgb = members.length
      ? [0, 1, 2].map((j) => members.reduce((n, p) => n + p[j], 0) / members.length)
      : [0, 0, 0];
    return { rgb, share: members.length / pixels.length };
  });
  // Two clusters the same word apart are one colour to anyone reading it.
  const named = new Map();
  for (const g of groups) {
    const name = colourName(g.rgb);
    const prev = named.get(name);
    if (!prev) { named.set(name, { ...g, name }); continue; }
    const share = prev.share + g.share;
    prev.rgb = prev.rgb.map((v, j) => (v * prev.share + g.rgb[j] * g.share) / share);
    prev.share = share;
  }
  return [...named.values()].sort((a, b) => b.share - a.share);
}

/** The colours of one catalog entry, or null when it has no icon to read. */
export function measureIcon(file) {
  if (!existsSync(file)) return null;
  const found = clusters(piecePixels(decodePng(readFileSync(file))));
  const kept = found.filter((c) => c.share >= MIN_SHARE).slice(0, MAX_COLOURS);
  return (kept.length ? kept : found.slice(0, 1)).map((c) => ({
    name: c.name, hex: hex(c.rgb), share: Math.round(c.share * 100) / 100,
  }));
}

function main() {
  const print = process.argv.includes('--print');
  const looks = {};
  let missing = 0;
  for (const pack of BUILTIN_PACKS) {
    for (const o of pack.objects) {
      const key = o.key || o.type;
      if (!o.icon) { missing++; continue; }
      const m = measureIcon(join(ICONS, `${o.icon}.png`));
      if (!m) { missing++; continue; }
      looks[key] = m;
      if (print) console.log(key.padEnd(34), m.map((c) => `${c.name} ${Math.round(c.share * 100)}%`).join(', '));
    }
  }
  if (print) return;
  const rows = Object.entries(looks).map(([k, cs]) =>
    `  ${JSON.stringify(k)}: [${cs.map((c) => `[${JSON.stringify(c.name)}, ${JSON.stringify(c.hex)}, ${c.share}]`).join(', ')}],`);
  writeFileSync(OUT, `${HEADER}export const LOOK_COLOURS = {\n${rows.join('\n')}\n};\n`);
  console.log(`Measured ${Object.keys(looks).length} pieces -> src/looks.js${missing ? ` (${missing} without an icon)` : ''}`);
}

const HEADER = `// ---------------------------------------------------------------------------
// looks.js — the colours every piece really is
// ---------------------------------------------------------------------------
// GENERATED by \`npm run measure-looks\` from the library icons, which are the
// game's own renders of each piece. Do not edit by hand; change the tool and
// run it again.
//
// Each entry is up to three colours, largest first: [plain name, average hex,
// share of the piece]. These are measurements of the real art, which is the
// point — the catalog's \`color\` is the stand-in's tint and says nothing
// reliable about what the piece looks like in the game. See
// tools/measure-looks.mjs, and \`look\` in packs.js for the words.
//
// Read by ai.js, so the assistant chooses pieces by how they look in the
// headset. No three.js here, and nothing imports anything.
// ---------------------------------------------------------------------------

`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
