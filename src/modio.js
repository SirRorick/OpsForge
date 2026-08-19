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

/** Every call: `api_key` when there is no token, `Bearer` when there is. */
async function modioRequest(path, { method = 'GET', token, params, body } = {}) {
  const url = new URL(MODIO_HOST + path);
  if (!token) url.searchParams.set('api_key', MODIO_API_KEY);
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null) url.searchParams.set(k, v);
  }
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
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

export async function modioAddMod({ name, summary, logo, visible = true, tags } = {}) {
  const token = modioToken();
  if (!token) throw new Error('Sign in to mod.io before publishing.');
  const form = new FormData();
  form.set('name', name);
  if (summary) form.set('summary', summary);
  form.set('logo', logo, 'logo.jpg');
  form.set('visible', visible ? '1' : '0');
  for (const tag of tags || []) form.append('tags[]', tag);
  return modioRequest(`/games/${MODIO_GAME_ID}/mods`, { method: 'POST', token, body: form });
}

export async function modioEditMod(id, { name, summary, logo } = {}) {
  const token = modioToken();
  if (!token) throw new Error('Sign in to mod.io before editing.');
  const form = new FormData();
  if (name != null) form.set('name', name);
  if (summary != null) form.set('summary', summary);
  if (logo) form.set('logo', logo, 'logo.jpg');
  return modioRequest(`/games/${MODIO_GAME_ID}/mods/${id}`, { method: 'POST', token, body: form });
}

export async function modioAddModfile(id, { zip, version, changelog, active = true } = {}) {
  const token = modioToken();
  if (!token) throw new Error('Sign in to mod.io before publishing.');
  const form = new FormData();
  form.set('filedata', zip, 'map.zip');
  if (version) form.set('version', version);
  if (changelog) form.set('changelog', changelog);
  form.set('active', active ? '1' : '0');
  return modioRequest(`/games/${MODIO_GAME_ID}/mods/${id}/files`, { method: 'POST', token, body: form });
}
