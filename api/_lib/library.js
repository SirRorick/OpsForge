// ---------------------------------------------------------------------------
// The prefab library's server: every endpoint, against the adapters.
// ---------------------------------------------------------------------------
// Public:
//   GET  /api/library            every live prefab and the tag list
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
// Records live in Redis and files in Blob; see adapters.js. Keys, all under
// "of:":
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
//   idx           the public listing, cached; deleted by every change
//   rl:...        rate-limit counters
//   ac:<h>, as:<h> an admin's pending code and sessions, stored as hashes
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
const SESSION_S = 30 * DAY;
const CODE_S = 20 * 60;
const CODE_TRIES = 5;
const ADMIN_COOKIE = '__Host-opsforge_admin';
const MAX_BODY = 4_000_000;            // Vercel refuses a request over 4.5 MB
const MAX_THUMB = 400_000;
const MAX_SPIN = 2_500_000;

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
});

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');

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

/** Count one more of something per window, and refuse past `max`. */
async function limit(kv, key, max, seconds) {
  const n = await kv.cmd('INCR', K(`rl:${key}`));
  if (n === 1) await kv.cmd('EXPIRE', K(`rl:${key}`), seconds);
  if (n > max) throw new HttpError(429, 'That is too many in a short time. Try again later.');
}

const newId = () => {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (const b of randomBytes(10)) s += alphabet[b % alphabet.length];
  return s;
};

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
  let text = await d.kv.cmd('GET', K('idx'));
  if (!text) {
    text = JSON.stringify(await buildIndex(d.kv));
    await d.kv.cmd('SET', K('idx'), text, 'EX', 300);
  }
  // Cached at Vercel's edge for a few seconds — a report that hides something
  // reaches everybody within a quarter of a minute — and never by a browser.
  // A browser honours stale-while-revalidate too, and showed somebody the
  // library from before the prefab they had just shared.
  return new Response(text, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache',
      'vercel-cdn-cache-control': 'max-age=15, stale-while-revalidate=60',
    },
  });
}

const changed = (kv) => kv.cmd('DEL', K('idx'));

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
  await changed(d.kv);
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
  await limit(d.kv, `rep:${user.id}`, 40, DAY);
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
      await changed(d.kv);
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
    await changed(d.kv);
    hidden = true;
  }
  return json(200, { ok: true, already: !added, hidden });
}

// -- the admin's sign-in ---------------------------------------------------------------------
// The same shape as every other email-code sign-in on roricktech.com, and on
// purpose not the shared Nexus one: an address, a six-digit code mailed to it,
// a session cookie. An address that is not on the list gets the same answer as
// one that is, and a decoy row, so the list cannot be probed from outside.
// Codes and sessions are kept only as keyed hashes.

function adminEmails(env) {
  return new Set(String(env.OPSFORGE_ADMIN_EMAILS || '').split(/[,\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean));
}

function secret(env) {
  const s = env.OPSFORGE_SECRET || (env.OPSFORGE_DEV === '1' ? 'dev-only-secret-not-for-deployment' : '');
  if (s.length < 16) throw new HttpError(503, 'The admin sign-in is not set up on this deployment.');
  return s;
}

const keyed = (env, s) => createHmac('sha256', secret(env)).update(String(s)).digest('hex');

async function adminCode(d, request) {
  if (!d.mail) throw new HttpError(503, 'The admin sign-in is not set up on this deployment.');
  const body = await readJson(request);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'That is not an email address.');
  await limit(d.kv, `acip:${clientIp(request)}`, 10, 3600);
  await limit(d.kv, `acem:${sha(email).slice(0, 32)}`, 5, 3600);
  const allowed = adminEmails(d.env).has(email);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const row = { h: allowed ? keyed(d.env, `${email}:${code}`) : null, tries: 0 };
  await d.kv.cmd('SET', K(`ac:${keyed(d.env, email)}`), JSON.stringify(row), 'EX', CODE_S);
  if (allowed) {
    await d.mail.send({
      to: email,
      subject: `OpsForge admin code: ${code}`,
      text: `Your OpsForge admin sign-in code is ${code}.\n\nIt works for 20 minutes. If you did not ask for it, ignore this email.`,
      html: `<p>Your OpsForge admin sign-in code is</p><p style="font-size:28px;letter-spacing:6px;font-family:monospace"><b>${code}</b></p><p>It works for 20 minutes. If you did not ask for it, ignore this email.</p>`,
    });
  }
  return json(200, { ok: true, message: 'If that address may sign in, a code is on its way.' });
}

async function adminVerify(d, request) {
  const body = await readJson(request);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
  const code = String(body.code || '').replace(/\D/g, '');
  const key = K(`ac:${keyed(d.env, email)}`);
  const raw = await d.kv.cmd('GET', key);
  const fail = () => new HttpError(401, 'That code is wrong or has expired.');
  if (!raw || code.length !== 6) throw fail();
  const row = JSON.parse(raw);
  row.tries++;
  if (row.tries > CODE_TRIES) { await d.kv.cmd('DEL', key); throw fail(); }
  await d.kv.cmd('SET', key, JSON.stringify(row), 'EX', CODE_S);
  const want = Buffer.from(row.h || keyed(d.env, `decoy:${randomBytes(8).toString('hex')}`), 'hex');
  const got = Buffer.from(keyed(d.env, `${email}:${code}`), 'hex');
  if (!row.h || !timingSafeEqual(want, got) || !adminEmails(d.env).has(email)) throw fail();
  await d.kv.cmd('DEL', key);
  const token = randomBytes(32).toString('base64url');
  await d.kv.cmd('SET', K(`as:${keyed(d.env, token)}`), JSON.stringify({ email, at: d.now() }), 'EX', SESSION_S);
  return json(200, { ok: true, email }, {
    'set-cookie': `${ADMIN_COOKIE}=${token}; Path=/; Max-Age=${SESSION_S}; HttpOnly; Secure; SameSite=Strict`,
  });
}

async function adminSession(d, request) {
  const token = cookie(request, ADMIN_COOKIE);
  if (!token || token.length > 100) return null;
  const raw = await d.kv.cmd('GET', K(`as:${keyed(d.env, token)}`));
  if (!raw) return null;
  const s = JSON.parse(raw);
  // Taking an address off the list ends its sessions at once.
  return adminEmails(d.env).has(s.email) ? { ...s, token } : null;
}

async function requireAdmin(d, request) {
  const s = await adminSession(d, request);
  if (!s) throw new HttpError(401, 'Sign in first.');
  return s;
}

async function adminLogout(d, request) {
  const s = await adminSession(d, request);
  if (s) await d.kv.cmd('DEL', K(`as:${keyed(d.env, s.token)}`));
  return json(200, { ok: true }, { 'set-cookie': `${ADMIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
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
  await changed(kv);
  return json(200, { ok: true, ...result });
}

// -- health ---------------------------------------------------------------------------------------
// Whether this deployment's library is wired up, for whoever deployed it to
// check from outside — without anybody having to copy a credential anywhere
// to find out. Redis is the request itself; Blob is a two-byte file written and
// deleted; mail and the admin list are only whether they are configured. The
// answer is kept ten minutes, so this cannot be used to make the store work.

async function health(d) {
  const cached = await d.kv.cmd('GET', K('health'));
  if (cached) return json(200, { ...JSON.parse(cached), cached: true });
  const out = {
    library: true,
    redis: true,
    blob: false,
    mail: !!d.mail,
    admins: adminEmails(d.env).size,
    secret: String(d.env.OPSFORGE_SECRET || '').length >= 16,
    at: new Date(d.now()).toISOString(),
  };
  try {
    const probe = await d.files.put('health/probe.txt', Buffer.from('ok'), 'text/plain');
    await d.files.del([probe.url]);
    out.blob = true;
  } catch (err) {
    out.blobError = String(err.message).slice(0, 160);
  }
  await d.kv.cmd('SET', K('health'), JSON.stringify(out), 'EX', 600);
  return json(200, out);
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
 * One request in, one response out. `deps` is the adapters plus `env` and a
 * clock, so a test can hand in memory and a fixed time.
 */
export async function handle(request, deps) {
  const url = new URL(request.url);
  const route = (url.searchParams.get('route') || url.pathname.replace(/^\/api\/?/, '')).replace(/\/+$/, '');
  const fn = ROUTES[`${request.method} ${route}`];
  // The dev server's in-memory files. A deployment keeps its files in Blob and
  // never comes through here.
  if (request.method === 'GET' && route.startsWith('file/') && deps?.files?.read) {
    const f = deps.files.read(route.slice(5));
    return f
      ? new Response(f.bytes, { headers: { 'content-type': f.contentType, 'cache-control': 'no-store' } })
      : json(404, { error: 'No such file.' });
  }
  try {
    if (!fn) throw new HttpError(404, 'No such endpoint.');
    if (!deps) throw new HttpError(503, 'The prefab library is not set up on this copy of OpsForge.');
    if (request.method === 'POST' && !sameOrigin(request)) throw new HttpError(403, 'Requests must come from the editor itself.');
    return await fn({ now: () => Date.now(), ...deps }, request);
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message });
    console.error(err);
    return json(500, { error: 'Something went wrong on the server.' });
  }
}

export { PRESET_TAGS };
