// Bundle the editor into one self-contained HTML file.
//
// The multi-file version in src/ needs a local web server, because browsers
// refuse to load ES modules over file://. This flattens everything into a
// single module so the result opens by double-clicking. three.js still comes
// from the CDN.
//
// Node rather than Python so the same command works on Windows, macOS and
// Linux without a second runtime installed.

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const ORDER = [
  'unity.js', 'rules.js', 'format.js', 'packs.js', 'catalog.js',
  'placeholders.js', 'gizmo.js', 'scene.js', 'app.js',
];

// Matches single- and multi-line imports alike, capturing the module specifier
// so relative imports can be dropped and bare ones hoisted to the top.
const IMPORT_STMT = /^import\s[\s\S]*?from\s+['"]([^'"]+)['"];[ \t]*$/gm;
const EXPORT_KW = /^export\s+(?=(?:const|let|var|function|async|class)\b)/gm;

const SCRIPT_TAG = '<script type="module" src="./src/app.js"></script>';

export function build() {
  const hoisted = [];
  const bodies = [];

  for (const name of ORDER) {
    let src = readFileSync(join(ROOT, 'src', name), 'utf8');

    src = src.replace(IMPORT_STMT, (stmt, specifier) => {
      if (specifier.startsWith('.')) return ''; // local module, inlined below
      const trimmed = stmt.trim();
      if (!hoisted.includes(trimmed)) hoisted.push(trimmed);
      return '';
    });
    src = src.replace(EXPORT_KW, '');

    bodies.push(`// ==== src/${name} ${'='.repeat(Math.max(0, 60 - name.length))}\n${src.trim()}\n`);
  }

  const bundle = `${hoisted.join('\n')}\n\n${bodies.join('\n\n')}`;
  checkForCollisions(bundle);

  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  if (!html.includes(SCRIPT_TAG)) {
    throw new Error('index.html no longer contains the expected module script tag.');
  }

  mkdirSync(join(ROOT, 'dist'), { recursive: true });
  const out = join(ROOT, 'dist', 'spatial-ops-map-editor.html');
  writeFileSync(out, html.replace(SCRIPT_TAG, `<script type="module">\n${bundle}\n</script>`), 'utf8');
  return out;
}

/**
 * Flattening eight modules into one script also flattens eight scopes into one.
 * Two modules may each declare a `clampInt` quite happily while they are
 * modules — one importing the other under an alias even hides it — but the
 * bundle is a single scope and the second declaration is a SyntaxError that
 * kills the whole editor on load.
 *
 * Nothing else catches it: `npm test` never imports `app.js` or `scene.js`
 * because they pull in three.js, so the first sign is a blank page. Cheap to
 * check here, where the flat scope is actually built.
 *
 * Top-level declarations only — the regex is anchored at column zero, so
 * anything indented is inside a function and has a scope of its own.
 */
export function checkForCollisions(bundle) {
  const DECL = /^(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  const seen = new Map();
  const clashes = [];
  for (const [, name] of bundle.matchAll(DECL)) {
    if (seen.has(name)) clashes.push(name);
    else seen.set(name, true);
  }
  if (clashes.length) {
    throw new Error(
      `Two modules declare the same top-level name, which is fine as modules ` +
      `but a SyntaxError once bundled into one scope: ${[...new Set(clashes)].join(', ')}. ` +
      `Rename one of them — an import alias does not help here.`
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = build();
  console.log(`Built ${out} (${Math.round(statSync(out).size / 1024)} KB)`);
}
