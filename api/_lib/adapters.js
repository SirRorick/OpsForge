// ---------------------------------------------------------------------------
// The four things the library's server talks to, each with a stand-in.
// ---------------------------------------------------------------------------
// On Vercel these are Upstash Redis (records, counters, sessions), Vercel Blob
// (the prefab files and their pictures), Resend (the admin's sign-in code) and
// mod.io (who a contributor is). Each is reached over plain HTTPS with fetch:
// no SDK, no npm dependency, the same as the rest of the stack.
//
// Locally — `npm run serve`, and the tests — each has an in-memory twin, chosen
// only when OPSFORGE_DEV=1 says so. A deployment missing a credential does not
// quietly fall back to memory that forgets everything on the next cold start;
// it says the library is not set up.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

const MODIO_ME = 'https://g-11054.modapi.io/v1/me';

// -- Redis ----------------------------------------------------------------------

/**
 * Upstash's REST interface: one command is a JSON array POSTed to the base URL,
 * several are an array of arrays POSTed to /pipeline. Replies are `{ result }`
 * or `{ error }`, one per command.
 */
export function restKv(url, token) {
  const base = String(url).replace(/\/+$/, '');
  const call = async (path, body) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok && res.status !== 400) throw new Error(`Redis answered ${res.status}`);
    return res.json();
  };
  return {
    kind: 'upstash',
    async cmd(...args) {
      const r = await call('', args.map(String));
      if (r.error) throw new Error(`Redis: ${r.error}`);
      return r.result;
    },
    async pipe(cmds) {
      if (!cmds.length) return [];
      const r = await call('/pipeline', cmds.map((c) => c.map(String)));
      return r.map((x) => {
        if (x.error) throw new Error(`Redis: ${x.error}`);
        return x.result;
      });
    },
  };
}

/**
 * Enough of Redis to run the library on, in memory, answering in the shapes
 * Upstash's REST interface uses — HGETALL flat, scores as strings — so code
 * tested against this behaves the same against the real thing.
 */
export function memoryKv(now = () => Date.now()) {
  const data = new Map(); // key -> { type, v, exp }
  const live = (key) => {
    const e = data.get(key);
    if (e && e.exp && e.exp <= now()) { data.delete(key); return null; }
    return e || null;
  };
  const of = (key, type, make) => {
    let e = live(key);
    if (!e) { e = { type, v: make(), exp: 0 }; data.set(key, e); }
    if (e.type !== type) throw new Error(`WRONGTYPE ${key}`);
    return e.v;
  };
  const get = (key, type) => {
    const e = live(key);
    if (!e) return null;
    if (e.type !== type) throw new Error(`WRONGTYPE ${key}`);
    return e.v;
  };
  const run = (args) => {
    const [name, ...a] = args.map(String);
    const c = name.toUpperCase();
    switch (c) {
      case 'GET': return get(a[0], 'str');
      case 'MGET': return a.map((k) => get(k, 'str'));
      case 'SET': {
        const nx = a.includes('NX');
        if (nx && live(a[0])) return null;
        const ex = a.indexOf('EX');
        data.set(a[0], { type: 'str', v: a[1], exp: ex > 0 ? now() + Number(a[ex + 1]) * 1000 : 0 });
        return 'OK';
      }
      case 'DEL': return a.reduce((n, k) => n + (data.delete(k) ? 1 : 0), 0);
      case 'EXISTS': return a.reduce((n, k) => n + (live(k) ? 1 : 0), 0);
      case 'EXPIRE': { const e = live(a[0]); if (!e) return 0; e.exp = now() + Number(a[1]) * 1000; return 1; }
      case 'INCR': {
        const e = live(a[0]);
        const v = (e ? Number(e.v) : 0) + 1;
        data.set(a[0], { type: 'str', v: String(v), exp: e?.exp || 0 });
        return v;
      }
      case 'HSET': { const h = of(a[0], 'hash', () => new Map()); let n = 0; for (let i = 1; i < a.length; i += 2) { if (!h.has(a[i])) n++; h.set(a[i], a[i + 1]); } return n; }
      case 'HSETNX': { const h = of(a[0], 'hash', () => new Map()); if (h.has(a[1])) return 0; h.set(a[1], a[2]); return 1; }
      case 'HGET': return get(a[0], 'hash')?.get(a[1]) ?? null;
      case 'HDEL': { const h = get(a[0], 'hash'); if (!h) return 0; let n = 0; for (const f of a.slice(1)) if (h.delete(f)) n++; if (!h.size) data.delete(a[0]); return n; }
      case 'HLEN': return get(a[0], 'hash')?.size ?? 0;
      case 'HGETALL': { const h = get(a[0], 'hash'); return h ? [...h].flat() : []; }
      case 'SADD': { const s = of(a[0], 'set', () => new Set()); let n = 0; for (const m of a.slice(1)) if (!s.has(m)) { s.add(m); n++; } return n; }
      case 'SREM': { const s = get(a[0], 'set'); if (!s) return 0; let n = 0; for (const m of a.slice(1)) if (s.delete(m)) n++; if (!s.size) data.delete(a[0]); return n; }
      case 'SISMEMBER': return get(a[0], 'set')?.has(a[1]) ? 1 : 0;
      case 'SMEMBERS': return [...(get(a[0], 'set') || [])];
      case 'SCARD': return get(a[0], 'set')?.size ?? 0;
      case 'ZADD': { const z = of(a[0], 'zset', () => new Map()); let n = 0; for (let i = 1; i < a.length; i += 2) { if (!z.has(a[i + 1])) n++; z.set(a[i + 1], Number(a[i])); } return n; }
      case 'ZREM': { const z = get(a[0], 'zset'); if (!z) return 0; let n = 0; for (const m of a.slice(1)) if (z.delete(m)) n++; if (!z.size) data.delete(a[0]); return n; }
      case 'ZSCORE': { const v = get(a[0], 'zset')?.get(a[1]); return v === undefined ? null : String(v); }
      case 'ZCARD': return get(a[0], 'zset')?.size ?? 0;
      case 'ZRANGE': {
        const z = get(a[0], 'zset');
        if (!z) return [];
        const rev = a.includes('REV');
        const sorted = [...z].sort((x, y) => (rev ? y[1] - x[1] : x[1] - y[1]) || (x[0] < y[0] ? -1 : 1));
        const start = Number(a[1]);
        const stop = Number(a[2]);
        const end = stop < 0 ? sorted.length + stop + 1 : stop + 1;
        return sorted.slice(start, end).map(([m]) => m);
      }
      default: throw new Error(`memoryKv: ${c} is not implemented`);
    }
  };
  return {
    kind: 'memory',
    async cmd(...args) { return run(args); },
    async pipe(cmds) { return cmds.map(run); },
  };
}

// -- files ------------------------------------------------------------------------

const BLOB_API = 'https://vercel.com/api/blob';
const BLOB_API_VERSION = '13'; // what @vercel/blob 2.8 sends

/**
 * Vercel Blob over HTTP, the two calls the library needs. A file is written
 * once, under a pathname with a random suffix the store adds, and never
 * overwritten — so the CDN can cache it for a year and nobody can guess the
 * address of one they were not shown.
 */
export function blobFiles(token) {
  // A classic token names its store (vercel_blob_rw_<store>_<secret>); a newer
  // one does not, and the API reads the store from the token itself — as
  // @vercel/blob does, the header is only sent when there is a store to name.
  const storeId = /^vercel_blob_rw_/.test(token) ? String(token).split('_')[3] : '';
  const headers = (extra = {}) => ({
    authorization: `Bearer ${token}`,
    'x-api-version': BLOB_API_VERSION,
    ...(storeId ? { 'x-vercel-blob-store-id': storeId } : {}),
    ...extra,
  });
  return {
    kind: 'blob',
    async put(pathname, bytes, contentType) {
      const res = await fetch(`${BLOB_API}/?${new URLSearchParams({ pathname })}`, {
        method: 'PUT',
        headers: headers({
          'x-vercel-blob-access': 'public',
          'x-content-type': contentType,
          'x-add-random-suffix': '1',
          'x-cache-control-max-age': '31536000',
        }),
        body: bytes,
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`Blob store answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const out = await res.json();
      return { url: out.url, pathname: out.pathname };
    },
    async del(urls) {
      const list = urls.filter(Boolean);
      if (!list.length) return;
      const res = await fetch(`${BLOB_API}/delete`, {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ urls: list }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`Blob store answered ${res.status} to a delete`);
    },
  };
}

/** Files kept in memory and served by the dev server at /api/file/<name>. */
export function memoryFiles() {
  const files = new Map();
  let n = 0;
  return {
    kind: 'memory',
    async put(pathname, bytes, contentType) {
      const name = `${pathname.replace(/[^A-Za-z0-9._-]+/g, '-')}-${(++n).toString(36)}`;
      files.set(name, { bytes: Buffer.from(bytes), contentType });
      return { url: `/api/file/${name}`, pathname: name };
    },
    async del(urls) {
      for (const u of urls) files.delete(String(u).split('/api/file/')[1]);
    },
    read(name) { return files.get(name) || null; },
    count() { return files.size; },
  };
}

// -- mail ---------------------------------------------------------------------------

export function resendMail(apiKey, from) {
  return {
    kind: 'resend',
    async send({ to, subject, text, html }) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text, html }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Resend answered ${res.status}`);
    },
  };
}

/** Dev mail: the last message is kept so a test can read the code out of it. */
export function memoryMail() {
  const sent = [];
  return {
    kind: 'memory',
    async send(msg) { sent.push(msg); console.log(`[dev mail] to ${msg.to}: ${msg.subject}\n${msg.text}`); },
    sent,
  };
}

// -- mod.io ---------------------------------------------------------------------------

/**
 * Who a mod.io token belongs to, asked of mod.io itself. The token is the one
 * the editor already holds for publishing maps; it is used for this one call
 * and never stored — only a hash of it, for ten minutes, so a burst of reports
 * does not ask mod.io the same question twenty times.
 */
export function modioIdentity(kv) {
  return {
    async whoIs(token) {
      if (!token || token.length > 4000) return null;
      const key = `of:mt:${createHash('sha256').update(token).digest('hex').slice(0, 40)}`;
      const cached = await kv.cmd('GET', key);
      if (cached) return JSON.parse(cached);
      const res = await fetch(MODIO_ME, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 401 || res.status === 403) return null;
      if (!res.ok) throw new Error(`mod.io answered ${res.status}`);
      const me = await res.json();
      if (!Number.isInteger(me?.id)) return null;
      const user = {
        id: String(me.id),
        name: String(me.username || me.name_id || `mod.io user ${me.id}`).slice(0, 60),
        profile: /^https:\/\/([a-z0-9-]+\.)*mod\.io\//i.test(me.profile_url || '') ? me.profile_url : null,
      };
      await kv.cmd('SET', key, JSON.stringify(user), 'EX', 600);
      return user;
    },
  };
}

/** Dev identities: a token "dev:<id>:<name>" is that person. Never on a deployment. */
export function devIdentity() {
  return {
    async whoIs(token) {
      const m = /^dev:(\d{1,12}):(.{1,60})$/.exec(String(token || ''));
      return m ? { id: m[1], name: m[2], profile: null } : null;
    },
  };
}

/**
 * Pick each adapter from the environment. `null` for the whole set means the
 * library is not set up on this deployment, which every endpoint reports
 * plainly rather than half-working.
 */
export function adaptersFrom(env) {
  const dev = env.OPSFORGE_DEV === '1';
  const kvUrl = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const kvToken = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  const kv = kvUrl && kvToken ? restKv(kvUrl, kvToken) : dev ? memoryKv() : null;
  const files = env.BLOB_READ_WRITE_TOKEN ? blobFiles(env.BLOB_READ_WRITE_TOKEN) : dev ? memoryFiles() : null;
  if (!kv || !files) return null;
  const mail = env.RESEND_API_KEY && env.RESEND_FROM ? resendMail(env.RESEND_API_KEY, env.RESEND_FROM)
    : dev ? memoryMail() : null;
  const modio = dev && env.OPSFORGE_DEV_MODIO === '1' ? devIdentity() : modioIdentity(kv);
  return { kv, files, mail, modio };
}
