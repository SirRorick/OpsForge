// Local dev server for the multi-file version in src/.
//
// Browsers refuse to load ES modules over file://, so index.html needs to be
// served over http. Node rather than Python so it works the same everywhere.
//
//   npm run serve              -> http://localhost:8000
//   npm run serve -- --no-open  the same, without opening a browser
//   npm run serve -- 9000
//   npm run serve -- --lan     also answer other machines on the network
//
// Loopback only unless asked, and only the files the editor itself loads. The
// working tree also holds .git, the private reference/ dump and local notes,
// and none of that is anybody else's business on a shared network.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname, sep } from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ARGS = process.argv.slice(2);
const PORT = Number(ARGS.find((a) => /^\d+$/.test(a))) || 8000;
const HOST = ARGS.includes('--lan') ? '0.0.0.0' : '127.0.0.1';

/** Top-level names the editor fetches. Anything else answers 404. */
const SERVED = new Set(['index.html', 'src', 'assets', 'packs', 'dist', 'admin', 'favicon.ico']);

// The prefab library's API, run here the way Vercel runs it, against an
// in-memory store that lasts as long as this process. Nothing is sent to
// mod.io: a token "dev:<id>:<name>" is that person (devIdentity), and the
// admin code is printed to this console instead of mailed. The admin address
// is OPSFORGE_ADMIN_EMAILS if set, else admin@opsforge.test.
process.env.OPSFORGE_DEV ??= '1';
process.env.OPSFORGE_DEV_MODIO ??= '1';
process.env.OPSFORGE_ADMIN_EMAILS ??= 'admin@opsforge.test';
const api = await import('./api/index.js');

/** A Node request as the Web Request the function expects, and its Response back. */
async function runApi(req, res, url) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(url, {
    method: req.method,
    headers: Object.entries(req.headers).filter(([, v]) => typeof v === 'string'),
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  });
  const fn = api[req.method];
  const out = fn ? await fn(request) : new Response('Method not allowed', { status: 405 });
  const headers = Object.fromEntries(out.headers);
  // Two cookies are two headers; folded into one they are neither.
  const cookies = out.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  // Local is http, and a Secure cookie set over http is dropped by every
  // browser but Chrome's localhost exception; say so rather than fail quietly.
  res.writeHead(out.status, headers);
  res.end(Buffer.from(await out.arrayBuffer()));
}

function servable(rel) {
  const parts = rel.split('/').filter(Boolean);
  if (!parts.length || !SERVED.has(parts[0])) return false;
  // No dotfiles anywhere under them either.
  return !parts.some((p) => p.startsWith('.'));
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.map': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname.startsWith('/api/')) return void await runApi(req, res, url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';

    // Keep requests inside the project directory.
    const target = normalize(join(ROOT, rel));
    if (!target.startsWith(ROOT + sep) && target !== ROOT) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (!servable(target.slice(ROOT.length).split(sep).join('/'))) {
      res.writeHead(404).end('Not found');
      return;
    }

    const info = await stat(target);
    const file = info.isDirectory() ? join(target, 'index.html') : target;
    const body = await readFile(file);

    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      // Always serve fresh files; a cached editor during development is a trap.
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch (err) {
    const missing = err.code === 'ENOENT' || err.code === 'ENOTDIR';
    res.writeHead(missing ? 404 : 500).end(missing ? 'Not found' : 'Server error');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try: npm run serve -- ${PORT + 1}`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}/index.html`;
  const reach = HOST === '0.0.0.0' ? 'this machine and the network' : 'this machine only (--lan to share)';
  console.log(`Serving ${ROOT}\n  ${url}\n  reachable from ${reach}\n  Ctrl+C to stop`);
  if (!ARGS.includes('--no-open')) open(url);
});

function open(url) {
  const cmd =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try {
    spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // No browser to launch; the URL is printed above.
  }
}
