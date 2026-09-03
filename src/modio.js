// ---------------------------------------------------------------------------
// mod.io — the Spatial Ops map library
// ---------------------------------------------------------------------------
// Everything that talks to mod.io lives here. Reads use a read-only api_key,
// shipped in the source because mod.io api_keys cannot create, edit or delete
// anything — that is what makes browsing token-free. Writes use the author's
// own user OAuth token — not a personal access token from mod.io/me/access,
// which is bound to the account it was issued for and refuses a game it isn't
// on the team of. The OAuth token represents the person instead, the same way
// the game itself gets one when someone signs into mod.io in-headset: mod.io
// emails a 5-digit code, and exchanging it hands back the token. Kept only in
// this browser's localStorage, sent as `Authorization: Bearer` straight to
// `g-11054.modapi.io`. Nothing passes through anyone else's hands.
//
// The token is stored and sent, never logged and never written into a map
// file — `format.js` guarantees a byte-identical round trip for untouched
// objects, so nothing about mod.io may enter the serialised output. That is
// why the guid -> mod-id map lives in localStorage too, beside the token.
//
// Every failure path here degrades the way `tryLoadDiskPacks` does: the
// library is a bonus, and losing it must never stop a file opening from disk.
// ---------------------------------------------------------------------------

import { zipRead, zipLooksLikeArchive } from './zip.js';

const MODIO_GAME_ID = 11054;
const MODIO_HOST = 'https://g-11054.modapi.io/v1';
const MODIO_API_KEY = 'cab6c931ec40e3940a326c6d89217bc6'; // read-only, public by design
const MODIO_TOKEN_KEY = 'spatialops.modio.token'; // the author's own write token
const MODIO_USER_KEY = 'spatialops.modio.username'; // cached, so Export need not re-validate to redraw
const MODIO_MINE_KEY = 'spatialops.modio.mine'; // map guid -> mod id, for updates

/** localStorage, or null where there is none — same guard as `checkpointStore`. */
function modioStore() {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    const probe = '__spatialops_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

export function modioToken() {
  try { return modioStore()?.getItem(MODIO_TOKEN_KEY) || null; } catch { return null; }
}

export function modioCachedUsername() {
  try { return modioStore()?.getItem(MODIO_USER_KEY) || null; } catch { return null; }
}

/** `username` is whatever `GET /me` returned when the token was validated — kept
 *  alongside it so Export can show who is signed in without a request on every open. */
export function modioSaveToken(token, username) {
  try {
    modioStore()?.setItem(MODIO_TOKEN_KEY, token);
    if (username) modioStore()?.setItem(MODIO_USER_KEY, username);
  } catch { /* fine */ }
}

export function modioForgetToken() {
  try {
    modioStore()?.removeItem(MODIO_TOKEN_KEY);
    modioStore()?.removeItem(MODIO_USER_KEY);
  } catch { /* fine */ }
}

export function modioMineMap() {
  try {
    const raw = modioStore()?.getItem(MODIO_MINE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function modioRecordMine(guid, modId) {
  try {
    const map = modioMineMap();
    map[guid] = modId;
    modioStore()?.setItem(MODIO_MINE_KEY, JSON.stringify(map));
  } catch { /* fine */ }
}

async function modioError(res) {
  let message = `mod.io request failed (${res.status})`;
  let errors = null;
  try {
    const body = await res.json();
    if (body?.error?.message) message = body.error.message;
    errors = body?.error?.errors || null;
  } catch { /* body wasn't JSON */ }
  const err = new Error(message);
  err.status = res.status;
  err.errors = errors;
  return err;
}

/**
 * Every call: `api_key` when there is no token, `Bearer` when there is. A
 * `URLSearchParams` body needs its `Content-Type` set by hand — left to
 * `fetch`, it appends `;charset=UTF-8`, and mod.io's tag endpoints reject
 * that suffix with the same strict `application/x-www-form-urlencoded` check
 * `modioFormRequest` already works around for the oauth endpoints.
 */
async function modioRequest(path, { method = 'GET', token, params, body } = {}) {
  const url = new URL(MODIO_HOST + path);
  if (!token) url.searchParams.set('api_key', MODIO_API_KEY);
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null) url.searchParams.set(k, v);
  }
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (body instanceof URLSearchParams) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const res = await fetch(url, { method, headers, body });
  if (!res.ok) throw await modioError(res);
  return res.status === 204 ? null : res.json();
}

export async function modioSearch(query, offset = 0) {
  return modioRequest(`/games/${MODIO_GAME_ID}/mods`, {
    // `ImageObject` is the "Map Objects - Images" tag — standalone images
    // uploaded as map objects, not maps, and out of place in a map library.
    params: { _q: query || undefined, _sort: '-popular', _limit: 20, _offset: offset, 'tags-not-in': 'ImageObject' },
  });
}

/**
 * One mod by its id.
 *
 * For a link that names a map: `?map=1234` in the editor's own address is a
 * mod id and nothing else, so opening it is a single read of the one mod rather
 * than a search that might not find it. Token-free like every other read here,
 * so a shared link works for somebody who has never signed in.
 */
export async function modioFetchMod(id) {
  return modioRequest(`/games/${MODIO_GAME_ID}/mods/${encodeURIComponent(id)}`);
}

/**
 * Every mod in the library whose map carries this guid.
 *
 * A map's guid is its identity to the *game*, not to mod.io: the file a headset
 * writes is named for the map's name and its guid, so two library entries
 * carrying one guid are two entries the headset cannot keep apart — download
 * both and the second lands on top of the first. mod.io has no idea any of that
 * is happening, and will happily host as many as are submitted.
 *
 * The guid is in `metadata_blob`, which is a string as far as mod.io is
 * concerned, so this asks the only question a string can be asked: does it
 * contain this. A guid is 32 hex characters and nothing else in the blob looks
 * remotely like one, so the match is exact in practice — checked against the
 * live library, where a real guid returns its own entries and an unused one
 * returns nothing.
 *
 * Token-free, like every other read here, because the question matters whether
 * or not anybody is signed in: a map downloaded from the library and published
 * back under a new name collides exactly as badly as a map published twice by
 * its own author, and the person doing it may never have signed in at all.
 *
 * Blob-less mods cannot answer and are not found — about a third of the library,
 * mostly maps published by tools that never wrote one. So a hit is proof of a
 * clash and a miss is not proof of no clash, which is why nothing downstream
 * treats this as permission rather than as a warning.
 */
export async function modioFindByGuid(guid) {
  if (!/^[0-9a-f]{32}$/i.test(guid || '')) return [];
  const body = await modioRequest(`/games/${MODIO_GAME_ID}/mods`, {
    params: { 'metadata_blob-lk': `*${guid}*`, _limit: 20 },
  });
  return body.data || [];
}

/** A downloaded mod's file, unzipped if it is one — `{name, text}`. A mod
 *  uploaded as a bare map file still opens, since the PK magic is checked
 *  before unzipping rather than assumed. */
export async function modioFetchMapText(mod) {
  const url = mod?.modfile?.download?.binary_url;
  if (!url) throw new Error('This map has no file to download.');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const buf = await res.arrayBuffer();
  if (zipLooksLikeArchive(buf)) {
    const [entry] = await zipRead(buf);
    if (!entry) throw new Error('The archive has nothing in it.');
    return { name: entry.name, text: new TextDecoder().decode(entry.bytes) };
  }
  return { name: mod.name, text: new TextDecoder().decode(buf) };
}

/** `GET /me` is the cheapest way to prove a token is real, and hands back the username. */
export async function modioValidateToken(token) {
  if (!token) throw new Error('No token given.');
  return modioRequest('/me', { token });
}

/**
 * A personal access token (mod.io/me/access) is bound to the resource it was
 * issued for — a *user's own account*, not a game — so `POST
 * /games/11054/mods` answers "does not grant access to this resource" no
 * matter which of the three scope switches are ticked, and a game-scoped
 * token isn't offered at all unless the account is on the Spatial Ops team.
 * That instrument is the wrong one for a third-party tool.
 *
 * A user OAuth token is the right one: it represents the person rather than
 * one resource, so it can submit to any game that accepts community
 * submissions — the same token the game itself gets when someone signs into
 * mod.io in-headset. mod.io hands it out over email: request a code, the
 * author reads it out of their inbox, exchange it for the token.
 */
/**
 * The two oauth endpoints reject query-string parameters outright — a plain
 * `415 Missing Content-Type header` — where every other endpoint here accepts
 * them. They want a real `application/x-www-form-urlencoded` body instead.
 */
async function modioFormRequest(path, fields) {
  const body = new URLSearchParams({ api_key: MODIO_API_KEY, ...fields });
  const res = await fetch(MODIO_HOST + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw await modioError(res);
  return res.status === 204 ? null : res.json();
}

export async function modioRequestEmailCode(email) {
  await modioFormRequest('/oauth/emailrequest', { email });
}

/** The 5-digit code from the email, exchanged for the user's own access token. */
export async function modioExchangeEmailCode(code) {
  const body = await modioFormRequest('/oauth/emailexchange', { security_code: code });
  return body.access_token;
}

export async function modioMyMods() {
  const token = modioToken();
  if (!token) return [];
  const body = await modioRequest('/me/mods', { token, params: { game_id: MODIO_GAME_ID } });
  return body.data;
}

/**
 * `metadataBlob` is the small JSON header the game itself submits beside every
 * map — guid, edited time, and the bounds in metres. The library carries one
 * on every map the game uploaded and on nothing else, so a map published
 * without it is marked as not-from-the-game whatever its file says.
 */
export async function modioAddMod({ name, summary, logo, visible = true, tags, metadataBlob } = {}) {
  const token = modioToken();
  if (!token) throw new Error('Sign in to mod.io before publishing.');
  const form = new FormData();
  form.set('name', name);
  if (summary) form.set('summary', summary);
  form.set('logo', logo, 'logo.jpg');
  form.set('visible', visible ? '1' : '0');
  if (metadataBlob) form.set('metadata_blob', metadataBlob);
  for (const tag of tags || []) form.append('tags[]', tag);
  return modioRequest(`/games/${MODIO_GAME_ID}/mods`, { method: 'POST', token, body: form });
}

export async function modioEditMod(id, { name, summary, logo, metadataBlob } = {}) {
  const token = modioToken();
  if (!token) throw new Error('Sign in to mod.io before editing.');
  const form = new FormData();
  if (name != null) form.set('name', name);
  if (summary != null) form.set('summary', summary);
  if (logo) form.set('logo', logo, 'logo.jpg');
  if (metadataBlob) form.set('metadata_blob', metadataBlob);
  return modioRequest(`/games/${MODIO_GAME_ID}/mods/${id}`, { method: 'POST', token, body: form });
}

/**
 * Tags live on their own endpoints — Edit Mod ignores a `tags[]` field, so
 * changing them on an update means adding and removing them by hand. Adding
 * one the mod already carries is harmless, which leaves only the stale ones
 * needing a delete. Both endpoints want a form body rather than query
 * parameters, the delete included.
 */
async function modioTagRequest(id, method, tags) {
  const token = modioToken();
  if (!token) throw new Error('Sign in to mod.io before editing.');
  if (!tags?.length) return;
  const body = new URLSearchParams();
  for (const tag of tags) body.append('tags[]', tag);
  await modioRequest(`/games/${MODIO_GAME_ID}/mods/${id}/tags`, { method, token, body });
}

export const modioAddTags = (id, tags) => modioTagRequest(id, 'POST', tags);
export const modioDeleteTags = (id, tags) => modioTagRequest(id, 'DELETE', tags);

export async function modioAddModfile(id, { zip, version, changelog, active = true } = {}) {
  const token = modioToken();
  if (!token) throw new Error('Sign in to mod.io before publishing.');
  const form = new FormData();
  // `upload.zip` is what the game names its own submissions, and mod.io keeps
  // the name it was given — `upload-xxxx.zip` beside `map-xxxx.zip` is the one
  // difference a person browsing the library would notice.
  form.set('filedata', zip, 'upload.zip');
  if (version) form.set('version', version);
  if (changelog) form.set('changelog', changelog);
  form.set('active', active ? '1' : '0');
  return modioRequest(`/games/${MODIO_GAME_ID}/mods/${id}/files`, { method: 'POST', token, body: form });
}
