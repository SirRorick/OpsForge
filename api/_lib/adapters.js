// ---------------------------------------------------------------------------
// What the library's server talks to, each with a stand-in.
// ---------------------------------------------------------------------------
// On Vercel there is one store, a *private* Vercel Blob store, holding both the
// prefab files and the library's records. Resend carries the admin's sign-in
// code and mod.io says who a contributor is. Each is reached over plain HTTPS
// with fetch: no SDK, no npm dependency, the same as the rest of the stack.
//
// The records are one JSON document, `library/state.json`, and every request
// works on a copy of it through `docKv` — the same few Redis commands the
// library was written against, run in memory — which is written back once, at
// the end, only if something actually changed, and only over the version it
// was read from (an ETag precondition). Two writers at once cannot lose each
// other's work: the second one re-reads and re-applies its changes.
//
// Locally — `npm run serve`, and the tests — the store is `memoryStore`, chosen
// only when OPSFORGE_DEV=1 says so; everything above it is the same code. A
// deployment missing its store does not quietly fall back to memory that
// forgets everything on the next cold start; it says the library is not set up.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

const MODIO_ME = 'https://g-11054.modapi.io/v1/me';
const DAY = 86_400;
const YEAR = 365 * DAY;

/** A write that lost the race: the stored version is not the one it was read from. */
export class StoreConflict extends Error {
  constructor() { super('The stored version changed underneath this write.'); }
}

// -- the commands --------------------------------------------------------------------

/**
 * Enough of Redis to run the library on, in memory, answering in the shapes
 * Upstash's REST interface uses — HGETALL flat, scores as strings — because
 * that is what the library was first written against. `data` is the live map,
 * so `docKv` can hand one in and read it back out.
 */
export function memoryKv(now = () => Date.now(), data = new Map()) {
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
    data,
    async cmd(...args) { return run(args); },
    async pipe(cmds) { return cmds.map(run); },
  };
}

const WRITES = new Set(['SET', 'DEL', 'EXPIRE', 'INCR', 'HSET', 'HSETNX', 'HDEL', 'SADD', 'SREM', 'ZADD', 'ZREM']);

/** The map as JSON, without what has expired and without what `skip` says to leave out. */
function encodeKv(data, at, skip = () => false) {
  const out = {};
  for (const [k, e] of [...data].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if ((e.exp && e.exp <= at) || skip(k)) continue;
    const v = e.type === 'hash' || e.type === 'zset' ? Object.fromEntries(e.v)
      : e.type === 'set' ? [...e.v] : e.v;
    out[k] = e.exp ? { t: e.type, v, e: e.exp } : { t: e.type, v };
  }
  return out;
}

function decodeKv(obj) {
  const data = new Map();
  for (const [k, { t, v, e = 0 }] of Object.entries(obj || {})) {
    const val = t === 'hash' ? new Map(Object.entries(v))
      : t === 'zset' ? new Map(Object.entries(v).map(([m, s]) => [m, Number(s)]))
        : t === 'set' ? new Set(v) : String(v);
    data.set(k, { type: t, v: val, exp: e });
  }
  return data;
}

const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);

/**
 * The library's records as one document in `store`, worked on a request at a
 * time. `begin` reads it — through the CDN cache, or straight from storage
 * when `fresh` — and returns a transaction with the memoryKv commands plus:
 *
 *   commit()  write it back if anything changed; false if nothing did
 *   spend(n)  count n uploads this request made, against the month's allowance
 *   budget()  { used } — uploads and writes so far this calendar month (UTC)
 *
 * Keys `soft` says are soft (rate-limit counters) are carried along but never
 * cause a write by themselves, so a request that was refused, or changed
 * nothing, costs nothing. A commit that loses the race re-reads the document
 * and replays this request's writes onto it, up to four times.
 */
export function docKv(store, { pathname = 'library/state.json', soft = () => false } = {}) {
  const load = async (fresh) => {
    const got = await store.get(pathname, { fresh });
    if (!got) return { etag: null, doc: { format: 'opsforge-library', version: 1, kv: {}, ops: {} } };
    let doc;
    try { doc = JSON.parse(Buffer.from(got.bytes).toString('utf8')); } catch {
      // Never write over a document that cannot be read; somebody needs to look at it.
      throw new Error(`${pathname} is not valid JSON`);
    }
    return { etag: got.etag, doc };
  };

  return {
    kind: store.kind,
    async begin({ fresh = false, now = () => Date.now() } = {}) {
      let snap = await load(fresh);
      let mem = memoryKv(now, decodeKv(snap.doc.kv));
      const firm = (data) => JSON.stringify(encodeKv(data, now(), soft));
      let before = firm(mem.data);
      const log = [];
      let spent = 0;
      const record = (args) => { if (WRITES.has(String(args[0]).toUpperCase())) log.push(args); };
      return {
        kind: store.kind,
        async cmd(...args) { record(args); return mem.cmd(...args); },
        async pipe(cmds) { cmds.forEach(record); return mem.pipe(cmds); },
        spend(n) { spent += n; },
        budget() { return { used: Number(snap.doc.ops?.[monthOf(now())]) || 0 }; },
        async commit() {
          for (let attempt = 1; attempt <= 4; attempt++) {
            if (firm(mem.data) === before) return false;
            const month = monthOf(now());
            const ops = Object.fromEntries(Object.entries(snap.doc.ops || {}).filter(([m]) => m >= monthOf(now() - 62 * DAY * 1000)));
            ops[month] = (Number(ops[month]) || 0) + spent + attempt;
            const doc = { ...snap.doc, kv: encodeKv(mem.data, now()), ops };
            try {
              await store.put(pathname, Buffer.from(JSON.stringify(doc)), 'application/json', {
                ifMatch: snap.etag, create: !snap.etag, maxAge: DAY,
              });
              return true;
            } catch (err) {
              if (!(err instanceof StoreConflict) || attempt === 4) throw err;
            }
            snap = await load(true);
            mem = memoryKv(now, decodeKv(snap.doc.kv));
            before = firm(mem.data);
            for (const args of log) await mem.cmd(...args);
          }
          return false;
        },
      };
    },
  };
}

// -- the store ----------------------------------------------------------------------

const BLOB_API = 'https://vercel.com/api/blob';
const BLOB_API_VERSION = '13'; // what @vercel/blob 2.8 sends

/**
 * A private Vercel Blob store over HTTP — the four calls the library needs.
 * Nothing in a private store is reachable without a credential, so the
 * library's files are handed out by the function (`/api/file/...`) and its
 * records cannot be read by anybody who guesses an address.
 *
 * Which store is BLOB_STORE_ID, which connecting a store to the project sets —
 * and only that: a read-write token on its own names a store but not whether
 * it is private, and a public one left connected from before would look set
 * up and fail at the first share. The credential is the project's own OIDC
 * token — Vercel hands every request one in `x-vercel-oidc-token` and rotates
 * it — or, with OIDC off, a classic read-write token for that same store.
 */
export function blobStore(env) {
  const classic = /^vercel_blob_rw_([A-Za-z0-9]+)_/.exec(String(env.BLOB_READ_WRITE_TOKEN || ''));
  const storeId = String(env.BLOB_STORE_ID || '').trim().replace(/^store_/, '');
  let requestOidc = '';
  const credential = () => {
    const oidc = requestOidc || String(env.VERCEL_OIDC_TOKEN || '');
    if (storeId && oidc) return { kind: 'oidc', token: oidc };
    if (storeId && classic && classic[1].toLowerCase() === storeId.toLowerCase()) return { kind: 'token', token: env.BLOB_READ_WRITE_TOKEN };
    return null;
  };
  const bearer = () => {
    const c = credential();
    if (!c) throw new Error('No credential for the Blob store: connect the store to this project, with OIDC on.');
    return c.token;
  };
  // The API takes the id as it is written; the store's host is lower case.
  const urlOf = (pathname) => `https://${storeId.toLowerCase()}.private.blob.vercel-storage.com/${pathname.split('/').map(encodeURIComponent).join('/')}`;
  const api = (extra = {}) => ({
    authorization: `Bearer ${bearer()}`,
    'x-api-version': BLOB_API_VERSION,
    'x-vercel-blob-store-id': storeId,
    ...extra,
  });
  const failure = async (res, what) => {
    let code = '', message = '';
    try { ({ code = '', message = '' } = (await res.json())?.error || {}); } catch { /* not json */ }
    if (res.status === 412 || code === 'precondition_failed') return new StoreConflict();
    return Object.assign(new Error(`Blob store answered ${res.status} to ${what}${message ? `: ${message.slice(0, 160)}` : ''}`), { code, message });
  };
  return {
    kind: 'blob',
    storeId,
    /** Pick up this request's OIDC token. One project, one token: the latest is as good as any. */
    useRequest(request) {
      const t = request?.headers?.get?.('x-vercel-oidc-token');
      if (t) requestOidc = t;
    },
    credentialKind: () => credential()?.kind || null,
    async put(pathname, bytes, contentType, { random = false, ifMatch = null, create = false, maxAge = YEAR } = {}) {
      const res = await fetch(`${BLOB_API}/?${new URLSearchParams({ pathname })}`, {
        method: 'PUT',
        headers: api({
          'x-vercel-blob-access': 'private',
          'x-content-type': contentType,
          'x-add-random-suffix': random ? '1' : '0',
          'x-allow-overwrite': ifMatch ? '1' : '0',
          'x-cache-control-max-age': String(maxAge),
          ...(ifMatch ? { 'x-if-match': ifMatch } : {}),
        }),
        body: bytes,
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        const err = await failure(res, 'an upload');
        // Creating what somebody else has just created is the same race.
        if (create && !(err instanceof StoreConflict) && /exist/i.test(err.message)) throw new StoreConflict();
        throw err;
      }
      const out = await res.json();
      return { pathname: out.pathname, etag: out.etag || '' };
    },
    async get(pathname, { fresh = false } = {}) {
      const res = await fetch(fresh ? `${urlOf(pathname)}?cache=0` : urlOf(pathname), {
        headers: { authorization: `Bearer ${bearer()}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw await failure(res, 'a read');
      return {
        bytes: Buffer.from(await res.arrayBuffer()),
        etag: res.headers.get('etag') || '',
        contentType: res.headers.get('content-type') || 'application/octet-stream',
      };
    },
    async del(pathnames) {
      const urls = pathnames.filter(Boolean).map(urlOf);
      if (!urls.length) return;
      const res = await fetch(`${BLOB_API}/delete`, {
        method: 'POST',
        headers: api({ 'content-type': 'application/json' }),
        body: JSON.stringify({ urls }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw await failure(res, 'a delete');
    },
  };
}

/** The same store in memory, with ETags and random suffixes, and a count of what it was asked. */
export function memoryStore() {
  const blobs = new Map(); // pathname -> { bytes, contentType, etag }
  const stats = { puts: 0, freshReads: 0 };
  let n = 0;
  return {
    kind: 'memory',
    storeId: 'memory',
    stats,
    useRequest() {},
    credentialKind: () => 'memory',
    async put(pathname, bytes, contentType, { random = false, ifMatch = null } = {}) {
      stats.puts++;
      let name = pathname;
      if (random) {
        const dot = pathname.lastIndexOf('.');
        const suffix = `x${(++n).toString(36).padStart(8, '0')}`;
        name = dot > pathname.lastIndexOf('/') ? `${pathname.slice(0, dot)}-${suffix}${pathname.slice(dot)}` : `${pathname}-${suffix}`;
      }
      const cur = blobs.get(name);
      if (ifMatch ? cur?.etag !== ifMatch : cur) throw new StoreConflict();
      const etag = `"m${(++n).toString(36)}"`;
      blobs.set(name, { bytes: Buffer.from(bytes), contentType, etag });
      return { pathname: name, etag };
    },
    async get(pathname, { fresh = false } = {}) {
      if (fresh) stats.freshReads++;
      const b = blobs.get(pathname);
      return b ? { ...b, bytes: Buffer.from(b.bytes) } : null;
    },
    async del(pathnames) { for (const p of pathnames) blobs.delete(p); },
    count(prefix = '') { return [...blobs.keys()].filter((k) => k.startsWith(prefix)).length; },
  };
}

// -- files ------------------------------------------------------------------------------

/** What the file route will hand out: a prefab's own three files, and nothing else in the store. */
const FILE_PATH = /^prefabs\/[a-z0-9]{6,20}\/[A-Za-z0-9_-]{1,80}\.(json|png|webp)$/;
const FILE_TYPES = { json: 'application/json', png: 'image/png', webp: 'image/webp' };

/**
 * A prefab's files, kept in the store under a pathname with a random suffix,
 * written once and never overwritten, and served by the function at
 * /api/file/<pathname> — so a file nobody was shown cannot be guessed, and the
 * records beside them in the store are never reachable that way.
 */
export function storeFiles(store) {
  return {
    async put(pathname, bytes, contentType) {
      const r = await store.put(pathname, bytes, contentType, { random: true, maxAge: YEAR });
      return { url: `/api/file/${r.pathname}`, pathname: r.pathname };
    },
    async del(urls) {
      const paths = urls.map((u) => String(u || '').split('/api/file/')[1]).filter((p) => p && FILE_PATH.test(p));
      if (paths.length) await store.del(paths);
    },
    async read(pathname) {
      if (!FILE_PATH.test(pathname)) return null;
      const b = await store.get(pathname);
      return b && { bytes: b.bytes, contentType: FILE_TYPES[pathname.split('.').pop()] };
    },
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
 * and never stored. The answer is remembered in this instance's memory for ten
 * minutes, under a hash of the token, so a burst of reports does not ask mod.io
 * the same question twenty times — memory rather than the store, because a
 * write per question would spend the store's allowance on nothing.
 */
export function modioIdentity() {
  const seen = new Map(); // hash -> { user, until }
  return {
    async whoIs(token) {
      if (!token || token.length > 4000) return null;
      const key = createHash('sha256').update(token).digest('hex');
      const hit = seen.get(key);
      if (hit && hit.until > Date.now()) return hit.user;
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
      if (seen.size > 500) seen.clear();
      seen.set(key, { user, until: Date.now() + 600_000 });
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
  const store = env.BLOB_STORE_ID ? blobStore(env) : dev ? memoryStore() : null;
  if (!store) return null;
  const kv = docKv(store, { soft: (key) => key.startsWith('of:rl:') });
  const mail = env.RESEND_API_KEY && env.RESEND_FROM ? resendMail(env.RESEND_API_KEY, env.RESEND_FROM)
    : dev ? memoryMail() : null;
  const modio = dev && env.OPSFORGE_DEV_MODIO === '1' ? devIdentity() : modioIdentity();
  return { store, kv, files: storeFiles(store), mail, modio };
}
