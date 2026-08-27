// ---------------------------------------------------------------------------
// package.mjs — assemble the release into dist/
// ---------------------------------------------------------------------------
// Usage:
//   npm run package                build dist/
//   npm run package -- --no-zip    the folder only, skip the archive
//   npm run package -- --out DIR   somewhere other than dist/
//
// There used to be two of these: a public build with thumbnails and stand-in
// shapes, and a private one with the game's models beside it, because the
// models could not go in the repository. They can now — the developers gave
// permission to redistribute them — so there is one build, it has everything,
// and this is it.
//
// `npm run build` writes the editor as a single HTML file, which is genuinely
// the whole editor: open it and it works. What it cannot carry is the art,
// because `assets/` is fetched at runtime rather than inlined. So a release is
// that file plus the folders it fetches, and this puts them together.
//
// Everything here is reproducible from src/ and assets/, which is why dist/ is
// gitignored. The zip is the deliverable to attach to a GitHub release; the
// folder beside it is what went in, kept so you can look before uploading.
// ---------------------------------------------------------------------------

import {
  readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync, cpSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from '../build.mjs';
import { zipDirectory } from './zip.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const THREE_VERSION = '0.169.0';
const NAME = 'spatial-ops-map-editor';

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

/**
 * Empty a directory without deleting the directory itself.
 *
 * Deleting the folder outright is the obvious thing and it is wrong here.
 * Anything holding the directory open — a static server run from inside it,
 * which is exactly what this folder is for — makes Windows refuse the removal
 * with EPERM, and it refuses it *after* having already deleted the contents.
 * That leaves the release folder empty and the run failed, which is the worst
 * of both. Removing the entries and keeping the directory never needs the
 * handle nobody will give up.
 */
function emptyDirectory(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    return;
  }
  for (const entry of readdirSync(dir)) {
    rmSync(join(dir, entry), { recursive: true, force: true });
  }
}

function dirSize(dir) {
  let total = 0, files = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { total += statSync(p).size; files++; }
    }
  };
  if (existsSync(dir)) walk(dir);
  return { total, files };
}

function howToRun() {
  return `# Running the editor

Unzip anywhere, then serve this folder over HTTP and open the address it prints:

    npx serve .            # or: python -m http.server

**It has to be served, not opened from disk.** Browsers refuse to let a
\`file://\` page fetch the thumbnails and models, so double-clicking
\`index.html\` gives you an editor with no artwork. Any static web server will
do — \`npx serve\` needs [Node.js](https://nodejs.org) 18 or newer, and if you
already run a web server, point it at this folder instead.

three.js is loaded from a CDN (jsdelivr, three ${THREE_VERSION}), so the browser
opening this page needs internet the first time even though the editor itself
is local.

## What is in here

    index.html        the whole editor, one file
    assets/Icons/     library thumbnails
    assets/Prefabs/   the game's models

Delete anything from \`assets/Prefabs/\` and those objects fall back to the
editor's own stand-in shapes; the **Stand-ins** switch at the foot of the
Library panel shows them at any time. \`assets/\` is Spatial Ops' artwork,
owned by its makers and included with their permission to redistribute it
with this editor. Everything here is under the OpsForge Project & Asset
License — see \`LICENSE.md\`.

Exported maps have **no file extension**. That is correct — copy the file
straight into the game's maps folder.
`;
}

/**
 * The release: the bundled editor and everything it fetches beside it.
 *
 * Always rebuilds, so the package cannot quietly be older than src/.
 */
export function packageRelease({ out, zip = true } = {}) {
  const dist = out || join(ROOT, 'dist');
  const dest = join(dist, NAME);
  const bundle = build();

  emptyDirectory(dest);
  writeFileSync(join(dest, 'index.html'), readFileSync(bundle, 'utf8'), 'utf8');

  const assets = join(ROOT, 'assets');
  const prefabs = join(assets, 'Prefabs');
  if (!existsSync(prefabs) || readdirSync(prefabs).length <= 1) {
    console.warn('assets/Prefabs is empty — run `npm run stage-assets` first, or this');
    console.warn('release ships with stand-in shapes instead of the game\'s models.');
  }
  cpSync(assets, join(dest, 'assets'), { recursive: true });

  // LICENSE.md travels with every copy — section 3.2 requires it.
  for (const f of ['README.md', 'LICENSE.md']) {
    if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(dest, f));
  }
  writeFileSync(join(dest, 'HOW-TO-RUN.md'), howToRun(), 'utf8');

  return { dest, zip: zip ? zipDirectory(dest, `${dest}.zip`) : null };
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--out');
  const made = packageRelease({
    out: i >= 0 && args[i + 1] ? join(ROOT, args[i + 1]) : null,
    zip: !args.includes('--no-zip'),
  });

  const total = dirSize(made.dest);
  console.log(`Packaged ${made.dest}`);
  for (const part of ['assets/Icons', 'assets/Prefabs']) {
    const s = dirSize(join(made.dest, part));
    if (s.files) console.log(`  ${part.padEnd(16)} ${String(s.files).padStart(4)} files  ${mb(s.total).padStart(9)}`);
  }
  console.log(`  ${'index.html'.padEnd(16)}    1 file   ${mb(statSync(join(made.dest, 'index.html')).size).padStart(9)}`);
  console.log(`  ${'total'.padEnd(16)} ${String(total.files).padStart(4)} files  ${mb(total.total).padStart(9)}`);

  if (made.zip) {
    console.log(`\nDeliverable  ${made.zip.file}`);
    console.log(`             ${made.zip.entries} entries, ${mb(made.zip.bytes)} — attach this to the release.`);
    console.log('The folder beside it is what went in, kept so you can look before uploading.');
  } else {
    console.log('\nNo zip asked for. Serve the folder with `npx serve .` from inside it.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
