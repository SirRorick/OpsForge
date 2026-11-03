// ---------------------------------------------------------------------------
// The prefab library's server: every endpoint, against the adapters.
// ---------------------------------------------------------------------------
// Public:
//   GET  /api/library            every live prefab and the tag list
//   GET  /api/file/<pathname>    one of a prefab's files: its prefab, thumbnail or 360° strip
//   GET  /api/health             whether this deployment's library is wired up
//   GET  /api/whoami             the mod.io account a token belongs to, and whether it may share
//   POST /api/submit             share a prefab            (mod.io sign-in)
//   POST /api/report             report a prefab or a tag  (mod.io sign-in)
// Admin (the email-code session):
//   POST /api/admin/code         email a sign-in code to an allowlisted address
//   POST /api/admin/verify       trade the code for a session
//   POST /api/admin/logout
//   GET  /api/admin/state        the review queue, the library, tags, bans, settings
//   POST /api/admin/act          restore, hide, delete, ban, tag moderation, settings
//
// Records are one document in the private Blob store, worked on through the
// Redis-shaped commands of `docKv` (adapters.js) and written back once per
// request, only when the request succeeded and changed something. Keys, all
// under "of:":
//   p:<id>        a prefab's record, JSON
//   z:live        live prefab ids, scored by when they were shared
//   z:hidden      hidden ones — reported past the threshold, hidden by hand, or
//                 their author banned — scored by when they were hidden
//   rep:<id>      reports on a prefab: mod.io id -> { name, reason, note, at }
//   u:<uid>       a contributor: { id, name, profile, banned, ... }
//   up:<uid>      the ids of a contributor's prefabs
//   bans          banned mod.io ids
//   tags          custom tags: slug -> { label, by, byName, at, hidden }
//   tagrep:<slug> reports on a custom tag
//   set           settings: threshold
//   rl:...        rate-limit counters — carried along, never a write by themselves
//   acsent:<h>    when sign-in codes were last mailed to an admin address
//   revoked       admin sessions signed out before they ran out
// ---------------------------------------------------------------------------

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { defFor } from '../../src/catalog.js';
import {
  LIMITS, REPORT_THRESHOLD, REPORT_REASONS, THUMB_SIZE, SPIN_FRAME, SPIN_FRAMES, TAG_PRESETS,
  PRESET_TAGS, normalizeTag, isPresetTag, validatePrefab, prefabSize, cleanText, PrefabError,
} from '../../src/prefablib.js';

const K = (s) => `of:${s}`;
const lookup = (type, props) => defFor({ type, props });

const DAY = 86_400;
const SESSION_S = 7 * DAY;
const CODE_S = 20 * 60;
const CODE_TRIES = 5;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32: no I, O, 0 or 1 to misread
const SESSION_COOKIE = '__Host-opsforge_admin';
const CHALLENGE_COOKIE = '__Host-opsforge_code';
const MAX_BODY = 4_000_000;            // Vercel refuses a request over 4.5 MB
const MAX_THUMB = 400_000;
const MAX_SPIN = 2_500_000;

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const json = (status, body, headers = {}, cookies = []) => {
  const h = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(JSON.stringify(body), { status, headers: h });
};

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY) throw new HttpError(413, 'That is too large to share — try fewer objects.');
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'That is too large to share — try fewer objects.');
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'The request was not valid JSON.'); }
}

function clientIp(request) {
  const fwd = request.headers.get('x-forwarded-for');
  return (fwd ? fwd.split(',')[0] : request.headers.get('x-real-ip') || 'local').trim().slice(0, 64);
}

/**
 * Every POST must come from a page on this same site. The admin cookie is
 * SameSite=Strict already; this is the second lock, and the only one the
 * mod.io endpoints have — their credential is a header a cross-site form
 * cannot send, but a check costs nothing.
 */
function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return request.headers.get('sec-fetch-site') !== 'cross-site';
  try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
}

function cookie(request, name) {
  const all = (request.headers.get('cookie') || '').split(';').map((c) => c.trim());
  const hits = all.filter((c) => c.startsWith(`${name}=`)).map((c) => c.slice(name.length + 1));
  // Two of the same name is somebody planting one; trust neither.
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Count one more of something per window, and refuse past `max`. The counter
 * is kept in the store, but only alongside a write the request was making
 * anyway — so what it counts is what got through.
 */
async function limit(kv, key, max, seconds) {
  const n = await kv.cmd('INCR', K(`rl:${key}`));
  if (n === 1) await kv.cmd('EXPIRE', K(`rl:${key}`), seconds);
  if (n > max) throw new HttpError(429, 'That is too many in a short time. Try again later.');
}

/**
 * The same, in this instance's memory only, for the requests that must not
 * cost a write to refuse: anybody may ask for an admin code. Kept per store,
 * which on a deployment is per instance and in the tests per library.
 */
const counters = new WeakMap(); // store -> Map(key -> { n, until })
function quick(d, key, max, seconds) {
  const now = Date.now();
  if (!counters.has(d.store)) counters.set(d.store, new Map());
  const recent = counters.get(d.store);
  const e = recent.get(key);
  if (!e || e.until <= now) {
    if (recent.size > 5000) recent.clear();
    recent.set(key, { n: 1, until: now + seconds * 1000 });
    return true;
  }
  return ++e.n <= max;
}

const newId = () => {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (const b of randomBytes(10)) s += alphabet[b % alphabet.length];
  return s;
};

// -- the month's allowance -------------------------------------------------------------
// The free plan's Blob store allows 2,000 uploads and writes a month, and past
// that it stops — every prefab's pictures with it — for thirty days. The
// library counts its own, and stops taking new prefabs well before, reports a
// little later, and the admin's own changes last, so the store never gets
// there. OPSFORGE_BLOB_OPS raises the allowance on a paid plan.

const SHARE_COST = 4; // three files and the record
const STOP_AT = { share: 0.75, report: 0.9, admin: 0.975 };
const STOPPED = {
  share: 'The library has taken all the new prefabs it can this month. Sharing opens again on the 1st.',
  report: 'Reports are paused until the 1st — the library has used this month’s storage allowance.',
  admin: 'This month’s storage allowance is nearly used up, so changes wait until the 1st.',
};

function allowance(env) {
  const n = Number(env.OPSFORGE_BLOB_OPS);
  return Number.isInteger(n) && n > 0 ? n : 2000;
}

/** Uploads and saves so far this month, the month's allowance, and where each kind of change stops. */
function storageUse(d) {
  const all = allowance(d.env);
  const stops = Object.fromEntries(Object.entries(STOP_AT).map(([k, f]) => [k, Math.floor(all * f)]));
  return { used: d.kv.budget().used, allowance: all, stops };
}

function afford(d, what, cost = 1) {
  const { used } = d.kv.budget();
  if (used + cost > allowance(d.env) * STOP_AT[what]) throw new HttpError(503, STOPPED[what]);
}

// -- settings -----------------------------------------------------------------------

async function threshold(kv) {
  const v = Number(await kv.cmd('HGET', K('set'), 'threshold'));
  return Number.isInteger(v) && v >= 1 && v <= 20 ? v : REPORT_THRESHOLD;
}

// -- the public listing --------------------------------------------------------------

/** What anybody may see of a record. Never the reports, never the status history. */
function publicRecord(r) {
  return {
    id: r.id, title: r.title, description: r.description, tags: r.tags,
    author: { id: r.author.id, name: r.author.name, profile: r.author.profile || null },
    created: r.created, objects: r.objects, size: r.size,
    files: r.files, frames: r.frames,
  };
}

async function records(kv, ids) {
  if (!ids.length) return [];
  const raw = await kv.cmd('MGET', ...ids.map((id) => K(`p:${id}`)));
  return raw.map((s) => (s ? JSON.parse(s) : null)).filter(Boolean);
}

async function customTags(kv) {
  const flat = await kv.cmd('HGETALL', K('tags'));
  const out = [];
  for (let i = 0; i < flat.length; i += 2) {
    try { out.push({ slug: flat[i], ...JSON.parse(flat[i + 1]) }); } catch { /* skip */ }
  }
  return out;
}

async function buildIndex(kv) {
  const live = await records(kv, await kv.cmd('ZRANGE', K('z:live'), 0, -1, 'REV'));
  const usage = {};
  for (const r of live) for (const t of r.tags) usage[t] = (usage[t] || 0) + 1;
  const all = await customTags(kv);
  const custom = all.filter((t) => !t.hidden);
  const hiddenTags = new Set(all.filter((t) => t.hidden).map((t) => t.slug));
  return {
    prefabs: live.map((r) => publicRecord({ ...r, tags: r.tags.filter((t) => !hiddenTags.has(t)) })),
    tags: {
      presets: TAG_PRESETS,
      custom: custom.map((t) => ({ tag: t.slug, count: usage[t.slug] || 0 }))
        .filter((t) => t.count > 0)
        .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : 1)),
      usage,
    },
    threshold: await threshold(kv),
    reasons: REPORT_REASONS,
    limits: LIMITS,
  };
}

async function getLibrary(d) {
  // Cached at Vercel's edge for a few seconds — a report that hides something
  // reaches everybody within a quarter of a minute — and never by a browser.
  // A browser honours stale-while-revalidate too, and showed somebody the
  // library from before the prefab they had just shared.
  return new Response(JSON.stringify(await buildIndex(d.kv)), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache',
      'vercel-cdn-cache-control': 'max-age=15, stale-while-revalidate=60',
    },
  });
}

// -- contributors ---------------------------------------------------------------------

async function contributor(d, request, { mustNotBeBanned = true } = {}) {
  const auth = request.headers.get('authorization') || '';
  const token = /^Bearer (.+)$/.exec(auth)?.[1];
  if (!token) throw new HttpError(401, 'Sign in to mod.io first.');
  let user;
  try { user = await d.modio.whoIs(token); } catch { throw new HttpError(502, 'mod.io could not be reached. Try again in a moment.'); }
  if (!user) throw new HttpError(401, 'That mod.io sign-in has expired. Sign in again.');
  const banned = await d.kv.cmd('SISMEMBER', K('bans'), user.id);
  if (banned && mustNotBeBanned) throw new HttpError(403, 'This mod.io account can no longer share to or report in the library.');
  return { ...user, banned: !!banned };
}

async function whoami(d, request) {
  const u = await contributor(d, request, { mustNotBeBanned: false });
  return json(200, { id: u.id, name: u.name, banned: u.banned });
}

// -- pictures -----------------------------------------------------------------------------

/** Width, height and type of a PNG or WebP, read from its header, or null. */
export function imageInfo(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return { type: 'image/png', ext: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      return { type: 'image/webp', ext: 'webp', w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    }
    if (chunk === 'VP8 ') {
      return { type: 'image/webp', ext: 'webp', w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { type: 'image/webp', ext: 'webp', w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) };
    }
  }
  return null;
}

function picture(dataUrl, w, h, max, what) {
  const m = /^data:image\/(png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new HttpError(400, `The ${what} is missing.`);
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > max) throw new HttpError(413, `The ${what} is too large.`);
  const info = imageInfo(buf);
  if (!info || info.w !== w || info.h !== h) throw new HttpError(400, `The ${what} is not the picture the editor makes.`);
  return { buf, info };
}

// -- sharing -----------------------------------------------------------------------------

function cleanTags(given) {
  if (!Array.isArray(given)) throw new HttpError(400, 'Tags must be a list.');
  const tags = [...new Set(given.map(normalizeTag).filter(Boolean))];
  if (!tags.length) throw new HttpError(400, 'Give it at least one tag, so people can find it.');
  if (tags.length > LIMITS.tags) throw new HttpError(400, `At most ${LIMITS.tags} tags.`);
  return tags;
}

async function submit(d, request) {
  const user = await contributor(d, request);
  await limit(d.kv, `sub:${user.id}`, 10, DAY);
  await limit(d.kv, `subip:${clientIp(request)}`, 30, DAY);
  afford(d, 'share', SHARE_COST);
  const body = await readJson(request);

  const title = cleanText(body.title, LIMITS.title);
  if (title.length < 3) throw new HttpError(400, 'Give it a title of at least three characters.');
  const description = cleanText(body.description, LIMITS.description);
  const tags = cleanTags(body.tags);

  // A custom tag somebody has had removed stays removed.
  const known = new Map((await customTags(d.kv)).map((t) => [t.slug, t]));
  for (const t of tags) {
    if (!isPresetTag(t) && known.get(t)?.hidden) {
      throw new HttpError(400, `The tag "${t}" has been removed from the library. Choose another.`);
    }
  }

  let prefab;
  try { prefab = validatePrefab(body.prefab, lookup); } catch (err) {
    if (err instanceof PrefabError) throw new HttpError(400, err.message);
    throw err;
  }
  prefab.name = title;
  const thumb = picture(body.thumb, THUMB_SIZE, THUMB_SIZE, MAX_THUMB, 'thumbnail');
  const spin = picture(body.spin, SPIN_FRAME * SPIN_FRAMES, SPIN_FRAME, MAX_SPIN, '360° preview');

  const id = newId();
  const put = (name, bytes, type) => d.files.put(`prefabs/${id}/${name}`, bytes, type);
  const [pf, th, sp] = await Promise.all([
    put('prefab.json', Buffer.from(JSON.stringify(prefab)), 'application/json'),
    put(`thumb.${thumb.info.ext}`, thumb.buf, thumb.info.type),
    put(`spin.${spin.info.ext}`, spin.buf, spin.info.type),
  ]);
  d.kv.spend(3);

  const now = d.now();
  const record = {
    id, title, description, tags,
    author: { id: user.id, name: user.name, profile: user.profile },
    created: now, objects: prefab.objects.length, size: prefabSize(prefab, lookup),
    files: { prefab: pf.url, thumb: th.url, spin: sp.url }, frames: SPIN_FRAMES,
    status: 'live', history: [{ at: now, what: 'shared' }],
  };
  const cmds = [
    ['SET', K(`p:${id}`), JSON.stringify(record)],
    ['ZADD', K('z:live'), now, id],
    ['SADD', K(`up:${user.id}`), id],
    ['SET', K(`u:${user.id}`), JSON.stringify({ id: user.id, name: user.name, profile: user.profile, last: now })],
  ];
  for (const t of tags) {
    if (!isPresetTag(t) && !known.has(t)) {
      cmds.push(['HSETNX', K('tags'), t, JSON.stringify({ label: t, by: user.id, byName: user.name, at: now, hidden: false })]);
    }
  }
  await d.kv.pipe(cmds);
  return json(201, { prefab: publicRecord(record) });
}

// -- reporting ------------------------------------------------------------------------------

async function hidePrefab(kv, record, why, now) {
  record.status = 'hidden';
  record.hiddenWhy = why;
  record.history = [...(record.history || []), { at: now, what: `hidden: ${why}` }].slice(-30);
  await kv.pipe([
    ['SET', K(`p:${record.id}`), JSON.stringify(record)],
    ['ZREM', K('z:live'), record.id],
    ['ZADD', K('z:hidden'), now, record.id],
  ]);
}

async function report(d, request) {
  const user = await contributor(d, request);
  await limit(d.kv, `rep:${user.id}`, 20, DAY);
  afford(d, 'report');
  const body = await readJson(request);
  const reason = REPORT_REASONS.some((r) => r.id === body.reason) ? body.reason : 'other';
  const note = cleanText(body.note, LIMITS.reportNote);
  const entry = JSON.stringify({ name: user.name, reason, note, at: d.now() });
  const needed = await threshold(d.kv);

  if (body.kind === 'tag') {
    const slug = normalizeTag(body.tag);
    if (!slug || isPresetTag(slug)) throw new HttpError(400, 'Only tags people wrote themselves can be reported.');
    const raw = await d.kv.cmd('HGET', K('tags'), slug);
    if (!raw) throw new HttpError(404, 'That tag is not in the library.');
    const tag = JSON.parse(raw);
    const added = await d.kv.cmd('HSETNX', K(`tagrep:${slug}`), user.id, entry);
    const count = await d.kv.cmd('HLEN', K(`tagrep:${slug}`));
    let hidden = !!tag.hidden;
    if (added && !hidden && count >= needed) {
      tag.hidden = true;
      tag.hiddenWhy = 'reports';
      await d.kv.cmd('HSET', K('tags'), slug, JSON.stringify(tag));
      hidden = true;
    }
    return json(200, { ok: true, already: !added, hidden });
  }

  const id = String(body.id || '');
  if (!/^[a-z0-9]{6,20}$/.test(id)) throw new HttpError(400, 'Which prefab?');
  const raw = await d.kv.cmd('GET', K(`p:${id}`));
  if (!raw) throw new HttpError(404, 'That prefab is no longer in the library.');
  const record = JSON.parse(raw);
  if (record.author.id === user.id) throw new HttpError(400, 'That is your own prefab — you can ask for it to be removed instead.');
  const added = await d.kv.cmd('HSETNX', K(`rep:${id}`), user.id, entry);
  const count = await d.kv.cmd('HLEN', K(`rep:${id}`));
  let hidden = record.status !== 'live';
  if (added && !hidden && count >= needed) {
    await hidePrefab(d.kv, record, 'reports', d.now());
    hidden = true;
  }
  return json(200, { ok: true, already: !added, hidden });
}

// -- the admin's sign-in ---------------------------------------------------------------------
// The same shape as every other email-code sign-in on roricktech.com, and on
// purpose not the shared Nexus one: an address, a code mailed to it, a session
// cookie. An address that is not on the list gets the same answer as one that
// is, so the list cannot be probed from outside.
//
// Neither the code nor the session is stored. Asking for a code sets a cookie
// holding the address, an expiry and a keyed hash of the code; the code itself
// goes only into the email. The session is a signed cookie too. So signing in
// costs the store one write — when the code is mailed, which is also what caps
// how many are — and wrong guesses cost it nothing. That is why the code is
// eight characters from 32 rather than six digits: there is no database
// counting wrong guesses across every instance, so the code has to be
// unguessable in twenty minutes on its own. OPSFORGE_SECRET keys every hash;
// changing it signs everybody out.

function adminEmails(env) {
  return new Set(String(env.OPSFORGE_ADMIN_EMAILS || '').split(/[,\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean));
}

function secret(env) {
  const s = env.OPSFORGE_SECRET || (env.OPSFORGE_DEV === '1' ? 'dev-only-secret-not-for-deployment' : '');
  if (s.length < 16) throw new HttpError(503, 'The admin sign-in is not set up on this deployment.');
  return s;
}

const keyed = (env, s) => createHmac('sha256', secret(env)).update(String(s)).digest('hex');
const pack = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const unpack = (s) => { try { return JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8')); } catch { return null; } };
const sameMac = (a, b) => /^[0-9a-f]{64}$/.test(a) && /^[0-9a-f]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const setCookie = (name, value, seconds) => `${name}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Strict`;

function newCode() {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  return s;
}
const cleanCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
const showCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;

async function adminCode(d, request) {
  if (!d.mail) throw new HttpError(503, 'The admin sign-in is not set up on this deployment.');
  const body = await readJson(request);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'That is not an email address.');
  const tooMany = () => new HttpError(429, 'That is too many codes in a short time. Try again later.');
  if (!quick(d, `acip:${clientIp(request)}`, 10, 3600) || !quick(d, `acem:${sha(email)}`, 3, 3600)) throw tooMany();
  const allowed = adminEmails(d.env).has(email);
  const payload = pack({ e: email, x: d.now() + CODE_S * 1000, n: randomBytes(12).toString('base64url') });
  let mac;
  if (allowed) {
    // Three an hour and eight a day per address, across every instance.
    const key = K(`acsent:${keyed(d.env, email).slice(0, 32)}`);
    const sent = JSON.parse((await d.kv.cmd('GET', key)) || '[]').filter((t) => t > d.now() - DAY * 1000);
    if (sent.length >= 8 || sent.filter((t) => t > d.now() - 3_600_000).length >= 3) throw tooMany();
    await d.kv.cmd('SET', key, JSON.stringify([...sent, d.now()]), 'EX', DAY);
    const code = newCode();
    mac = keyed(d.env, `code:${payload}:${code}`);
    await d.mail.send({
      to: email,
      subject: `OpsForge admin code: ${showCode(code)}`,
      text: `Your OpsForge admin sign-in code is ${showCode(code)}.\n\nIt works for 20 minutes, in the browser you asked for it from. If you did not ask for it, ignore this email.`,
      html: `<p>Your OpsForge admin sign-in code is</p><p style="font-size:28px;letter-spacing:4px;font-family:monospace"><b>${showCode(code)}</b></p><p>It works for 20 minutes, in the browser you asked for it from. If you did not ask for it, ignore this email.</p>`,
    });
  } else {
    // A cookie that looks the same and can never be redeemed, after about as long.
    mac = randomBytes(32).toString('hex');
    await sleep(300 + randomInt(0, 600));
  }
  return json(200, { ok: true, message: 'If that address may sign in, a code is on its way.' }, {},
    [setCookie(CHALLENGE_COOKIE, `${payload}.${mac}`, CODE_S)]);
}

async function adminVerify(d, request) {
  const body = await readJson(request);
  const code = cleanCode(body.code);
  const fail = () => new HttpError(401, 'That code is wrong or has expired.');
  const [payload = '', mac = ''] = String(cookie(request, CHALLENGE_COOKIE) || '').split('.');
  const c = unpack(payload);
  if (!c || typeof c.e !== 'string' || !(c.x > d.now()) || code.length !== 8) throw fail();
  if (body.email !== undefined && String(body.email).trim().toLowerCase() !== c.e) throw fail();
  // A handful of guesses per code in this instance, on top of 32^8 codes.
  if (!quick(d, `acv:${c.n}`, CODE_TRIES, CODE_S)) throw fail();
  if (!sameMac(keyed(d.env, `code:${payload}:${code}`), mac) || !adminEmails(d.env).has(c.e)) throw fail();
  const session = pack({ e: c.e, x: d.now() + SESSION_S * 1000, n: randomBytes(12).toString('base64url') });
  return json(200, { ok: true, email: c.e }, {}, [
    setCookie(SESSION_COOKIE, `${session}.${keyed(d.env, `session:${session}`)}`, SESSION_S),
    setCookie(CHALLENGE_COOKIE, '', 0),
  ]);
}

async function adminSession(d, request) {
  const raw = cookie(request, SESSION_COOKIE);
  if (!raw || raw.length > 600) return null;
  const [payload = '', mac = ''] = raw.split('.');
  const s = unpack(payload);
  if (!s || typeof s.e !== 'string' || !(s.x > d.now())) return null;
  if (!sameMac(keyed(d.env, `session:${payload}`), mac)) return null;
  if (await d.kv.cmd('HGET', K('revoked'), String(s.n))) return null;
  // Taking an address off the list ends its sessions at once.
  return adminEmails(d.env).has(s.e) ? { email: s.e, n: String(s.n), x: s.x } : null;
}

async function requireAdmin(d, request) {
  const s = await adminSession(d, request);
  if (!s) throw new HttpError(401, 'Sign in first.');
  return s;
}

async function adminLogout(d, request) {
  const s = await adminSession(d, request);
  if (s) {
    // The cookie goes from this browser; the list stops a copy of it working anywhere else.
    const flat = await d.kv.cmd('HGETALL', K('revoked'));
    const stale = [];
    for (let i = 0; i < flat.length; i += 2) if (Number(flat[i + 1]) <= d.now()) stale.push(flat[i]);
    if (stale.length) await d.kv.cmd('HDEL', K('revoked'), ...stale);
    await d.kv.cmd('HSET', K('revoked'), s.n, s.x);
  }
  return json(200, { ok: true }, {}, [setCookie(SESSION_COOKIE, '', 0)]);
}

// -- the admin's view -------------------------------------------------------------------------

function parseReports(flat) {
  const out = [];
  for (let i = 0; i < (flat || []).length; i += 2) {
    try { out.push({ uid: flat[i], ...JSON.parse(flat[i + 1]) }); } catch { /* skip */ }
  }
  return out.sort((a, b) => b.at - a.at);
}

/** The reports on many keys in one round trip. */
async function reportsOnAll(kv, keys) {
  const flats = await kv.pipe(keys.map((k) => ['HGETALL', k]));
  return flats.map(parseReports);
}

async function adminState(d, request) {
  const me = await requireAdmin(d, request);
  const kv = d.kv;
  const hidden = await records(kv, await kv.cmd('ZRANGE', K('z:hidden'), 0, -1, 'REV'));
  const live = await records(kv, await kv.cmd('ZRANGE', K('z:live'), 0, -1, 'REV'));
  const tags = await customTags(kv);
  const [hiddenReps, liveReps, tagReps] = await Promise.all([
    reportsOnAll(kv, hidden.map((r) => K(`rep:${r.id}`))),
    reportsOnAll(kv, live.map((r) => K(`rep:${r.id}`))),
    reportsOnAll(kv, tags.map((t) => K(`tagrep:${t.slug}`))),
  ]);
  const usage = {};
  for (const r of [...live, ...hidden]) for (const t of r.tags) usage[t] = (usage[t] || 0) + 1;
  const bans = await kv.cmd('SMEMBERS', K('bans'));
  const userRaw = bans.length ? await kv.cmd('MGET', ...bans.map((uid) => K(`u:${uid}`))) : [];
  return json(200, {
    me: { email: me.email },
    threshold: await threshold(kv),
    storage: storageUse(d),
    hidden: hidden.map((r, i) => ({ ...r, reports: hiddenReps[i] })),
    live: live.map((r, i) => ({ ...r, reports: liveReps[i] })),
    tags: tags.map((t, i) => ({ ...t, uses: usage[t.slug] || 0, reports: tagReps[i] })),
    bans: bans.map((uid, i) => (userRaw[i] ? JSON.parse(userRaw[i]) : { id: uid, name: `mod.io user ${uid}` })),
  });
}

async function loadRecord(kv, id) {
  if (!/^[a-z0-9]{6,20}$/.test(String(id || ''))) throw new HttpError(400, 'Which prefab?');
  const raw = await kv.cmd('GET', K(`p:${id}`));
  if (!raw) throw new HttpError(404, 'That prefab is gone.');
  return JSON.parse(raw);
}

async function deletePrefab(d, record) {
  try { await d.files.del(Object.values(record.files || {})); } catch (err) {
    // The record goes regardless: a file left behind is storage, a record left
    // behind pointing at nothing is a broken card in everybody's library.
    console.warn(`prefab ${record.id}: files not deleted (${err.message})`);
  }
  await d.kv.pipe([
    ['DEL', K(`p:${record.id}`)],
    ['DEL', K(`rep:${record.id}`)],
    ['ZREM', K('z:live'), record.id],
    ['ZREM', K('z:hidden'), record.id],
    ['SREM', K(`up:${record.author.id}`), record.id],
  ]);
}

/** Replace one tag with another (or with nothing) in every prefab carrying it. */
async function retag(d, from, to) {
  const ids = [
    ...await d.kv.cmd('ZRANGE', K('z:live'), 0, -1),
    ...await d.kv.cmd('ZRANGE', K('z:hidden'), 0, -1),
  ];
  const all = await records(d.kv, ids);
  const cmds = [];
  for (const r of all) {
    if (!r.tags.includes(from)) continue;
    r.tags = [...new Set(r.tags.map((t) => (t === from ? to : t)).filter(Boolean))];
    cmds.push(['SET', K(`p:${r.id}`), JSON.stringify(r)]);
  }
  if (cmds.length) await d.kv.pipe(cmds);
  return cmds.length;
}

async function adminAct(d, request) {
  await requireAdmin(d, request);
  afford(d, 'admin');
  const body = await readJson(request);
  const kv = d.kv;
  const now = d.now();
  let result = {};
  switch (body.action) {
    case 'restore': {
      const r = await loadRecord(kv, body.id);
      r.status = 'live';
      delete r.hiddenWhy;
      r.history = [...(r.history || []), { at: now, what: 'restored' }].slice(-30);
      await kv.pipe([
        ['SET', K(`p:${r.id}`), JSON.stringify(r)],
        ['DEL', K(`rep:${r.id}`)],
        ['ZREM', K('z:hidden'), r.id],
        ['ZADD', K('z:live'), r.created, r.id],
      ]);
      break;
    }
    case 'hide': {
      const r = await loadRecord(kv, body.id);
      if (r.status === 'live') await hidePrefab(kv, r, 'by the admin', now);
      break;
    }
    case 'dismiss': {
      // The reports were wrong: clear them and leave it where it is.
      const r = await loadRecord(kv, body.id);
      await kv.cmd('DEL', K(`rep:${r.id}`));
      break;
    }
    case 'edit': {
      const r = await loadRecord(kv, body.id);
      if (body.title !== undefined) {
        const t = cleanText(body.title, LIMITS.title);
        if (t.length < 3) throw new HttpError(400, 'A title of at least three characters.');
        r.title = t;
      }
      if (body.description !== undefined) r.description = cleanText(body.description, LIMITS.description);
      if (body.tags !== undefined) r.tags = cleanTags(body.tags);
      r.history = [...(r.history || []), { at: now, what: 'edited by the admin' }].slice(-30);
      await kv.cmd('SET', K(`p:${r.id}`), JSON.stringify(r));
      break;
    }
    case 'delete': {
      await deletePrefab(d, await loadRecord(kv, body.id));
      break;
    }
    case 'ban': {
      const uid = String(body.uid || '');
      if (!/^\d{1,12}$/.test(uid)) throw new HttpError(400, 'Which mod.io account?');
      const raw = await kv.cmd('GET', K(`u:${uid}`));
      const user = raw ? JSON.parse(raw) : { id: uid, name: `mod.io user ${uid}` };
      user.banned = true;
      user.bannedAt = now;
      user.banReason = cleanText(body.reason, 200);
      await kv.pipe([['SADD', K('bans'), uid], ['SET', K(`u:${uid}`), JSON.stringify(user)]]);
      // Everything they shared leaves the library with them, into the review
      // queue rather than the bin: deleting is a second, deliberate step.
      const mine = await records(kv, await kv.cmd('SMEMBERS', K(`up:${uid}`)));
      for (const r of mine) if (r.status === 'live') await hidePrefab(kv, r, 'author banned', now);
      if (body.deleteAll) for (const r of mine) await deletePrefab(d, r);
      result = { prefabs: mine.length };
      break;
    }
    case 'unban': {
      const uid = String(body.uid || '');
      await kv.cmd('SREM', K('bans'), uid);
      const raw = await kv.cmd('GET', K(`u:${uid}`));
      if (raw) {
        const user = JSON.parse(raw);
        user.banned = false;
        await kv.cmd('SET', K(`u:${uid}`), JSON.stringify(user));
      }
      break;
    }
    case 'tag-hide':
    case 'tag-restore': {
      const slug = normalizeTag(body.tag);
      const raw = slug && await kv.cmd('HGET', K('tags'), slug);
      if (!raw) throw new HttpError(404, 'No such custom tag.');
      const tag = JSON.parse(raw);
      tag.hidden = body.action === 'tag-hide';
      if (tag.hidden) tag.hiddenWhy = 'by the admin';
      else { delete tag.hiddenWhy; await kv.cmd('DEL', K(`tagrep:${slug}`)); }
      await kv.cmd('HSET', K('tags'), slug, JSON.stringify(tag));
      break;
    }
    case 'tag-delete': {
      const slug = normalizeTag(body.tag);
      if (!slug || isPresetTag(slug)) throw new HttpError(400, 'Preset tags are part of the editor.');
      result = { prefabs: await retag(d, slug, null) };
      await kv.pipe([['HDEL', K('tags'), slug], ['DEL', K(`tagrep:${slug}`)]]);
      break;
    }
    case 'tag-rename': {
      // Rename, or merge into an existing tag: "buliding" -> "building".
      const from = normalizeTag(body.tag);
      const to = normalizeTag(body.to);
      if (!from || !to || from === to) throw new HttpError(400, 'Rename it to what?');
      if (isPresetTag(from)) throw new HttpError(400, 'Preset tags are part of the editor.');
      result = { prefabs: await retag(d, from, to) };
      const raw = await kv.cmd('HGET', K('tags'), from);
      const cmds = [['HDEL', K('tags'), from], ['DEL', K(`tagrep:${from}`)]];
      if (!isPresetTag(to) && raw) {
        const t = JSON.parse(raw);
        cmds.push(['HSETNX', K('tags'), to, JSON.stringify({ ...t, label: to, hidden: false })]);
      }
      await kv.pipe(cmds);
      break;
    }
    case 'threshold': {
      const v = Number(body.value);
      if (!Number.isInteger(v) || v < 1 || v > 20) throw new HttpError(400, 'Between 1 and 20 reports.');
      await kv.cmd('HSET', K('set'), 'threshold', v);
      break;
    }
    default:
      throw new HttpError(400, 'Unknown action.');
  }
  return json(200, { ok: true, ...result });
}

// -- health ---------------------------------------------------------------------------------------
// Whether this deployment's library is wired up, for whoever deployed it to
// check from outside — without anybody having to copy a credential anywhere
// to find out. It reads the records and writes nothing, so asking costs the
// store nothing; mail and the admin list are only whether they are configured.

function wiring(d) {
  return {
    store: d.store?.kind || null,
    credential: d.store?.credentialKind?.() || null,
    mail: !!d.mail,
    admins: adminEmails(d.env).size,
    secret: String(d.env.OPSFORGE_SECRET || '').length >= 16,
  };
}

async function health(d) {
  return json(200, {
    library: true,
    ...wiring(d),
    prefabs: await d.kv.cmd('ZCARD', K('z:live')),
    hidden: await d.kv.cmd('ZCARD', K('z:hidden')),
    storage: storageUse(d),
    at: new Date(d.now()).toISOString(),
  });
}

// -- routing --------------------------------------------------------------------------------------

const ROUTES = {
  'GET library': getLibrary,
  'GET health': health,
  'GET whoami': whoami,
  'POST submit': submit,
  'POST report': report,
  'POST admin/code': adminCode,
  'POST admin/verify': adminVerify,
  'POST admin/logout': adminLogout,
  'GET admin/state': adminState,
  'POST admin/act': adminAct,
};

/**
 * One of a prefab's files. They never change — every one has a fresh random
 * name — so the browser and Vercel's edge keep them a day, and the function
 * runs about once per file per edge. Deleting a prefab takes its card out of
 * the library at once; anybody already holding a file's address can still
 * fetch it until the day is out.
 */
async function serveFile(deps, pathname) {
  const f = await deps.files.read(pathname);
  if (!f) return json(404, { error: 'No such file.' });
  const keep = deps.store?.kind === 'memory' ? { 'cache-control': 'no-store' }
    : { 'cache-control': 'public, max-age=86400', 'vercel-cdn-cache-control': 'max-age=86400' };
  return new Response(f.bytes, {
    headers: { 'content-type': f.contentType, 'x-content-type-options': 'nosniff', ...keep },
  });
}

/**
 * One request in, one response out. `deps` is the adapters plus `env` and a
 * clock, so a test can hand in memory and a fixed time; `env` alone is enough
 * for /api/health to say what is missing on a deployment with no store yet. A request reads the
 * records once and, if it succeeded and changed something, writes them back
 * once; a POST reads them straight from storage rather than through the cache,
 * because it is about to write over them.
 */
export async function handle(request, deps, env = deps?.env) {
  const url = new URL(request.url);
  const route = (url.searchParams.get('route') || url.pathname.replace(/^\/api\/?/, '')).replace(/\/+$/, '');
  try {
    if (!deps && route === 'health' && request.method === 'GET' && env) {
      return json(503, {
        library: false,
        ...wiring({ env, mail: !!(env.RESEND_API_KEY && env.RESEND_FROM) }),
        error: 'No private Blob store is connected to this project (BLOB_STORE_ID is not set).',
      });
    }
    if (!deps && (ROUTES[`${request.method} ${route}`] || route.startsWith('file/'))) {
      throw new HttpError(503, 'The prefab library is not set up on this copy of OpsForge.');
    }
    deps?.store?.useRequest?.(request);
    if (request.method === 'GET' && route.startsWith('file/')) return await serveFile(deps, route.slice(5));
    const fn = ROUTES[`${request.method} ${route}`];
    if (!fn) throw new HttpError(404, 'No such endpoint.');
    if (request.method === 'POST' && !sameOrigin(request)) throw new HttpError(403, 'Requests must come from the editor itself.');
    const d = { now: () => Date.now(), ...deps };
    const fresh = request.method === 'POST' || route === 'admin/state' || url.searchParams.has('fresh');
    try {
      d.kv = await deps.kv.begin({ fresh, now: d.now });
    } catch (err) {
      console.error(err);
      if (route === 'health') return json(503, { library: false, ...wiring(d), error: String(err.message).slice(0, 200) });
      throw new HttpError(503, 'The prefab library could not reach its storage. Try again in a moment.');
    }
    const res = await fn(d, request);
    if (res.status < 400) {
      try { await d.kv.commit(); } catch (err) {
        console.error(err);
        throw new HttpError(503, 'The library is busy — try that again in a moment.');
      }
    }
    return res;
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message });
    console.error(err);
    return json(500, { error: 'Something went wrong on the server.' });
  }
}

export { PRESET_TAGS };
