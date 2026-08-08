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
const ORDER = ['unity.js', 'format.js', 'catalog.js', 'placeholders.js', 'scene.js', 'app.js'];

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

  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  if (!html.includes(SCRIPT_TAG)) {
    throw new Error('index.html no longer contains the expected module script tag.');
  }

  mkdirSync(join(ROOT, 'dist'), { recursive: true });
  const out = join(ROOT, 'dist', 'spatial-ops-map-editor.html');
  writeFileSync(out, html.replace(SCRIPT_TAG, `<script type="module">\n${bundle}\n</script>`), 'utf8');
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = build();
  console.log(`Built ${out} (${Math.round(statSync(out).size / 1024)} KB)`);
}
