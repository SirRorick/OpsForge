// ---------------------------------------------------------------------------
// Spatial Ops map file format
// ---------------------------------------------------------------------------
// Reverse engineered from a v4 map file. See docs/FORMAT.md for the full notes.
//
// The game serialises with Newtonsoft.Json, minified, and distinguishes int
// fields (written bare: 7) from float fields (always given a decimal point:
// 0.0). Floats are single precision, printed with .NET "shortest round-trip"
// formatting. Reproducing both rules exactly means an unmodified map can be
// loaded and re-exported byte for byte.
// ---------------------------------------------------------------------------

export const MAP_VERSION = 4;
export const DOTNET_MIN_DATE = '0001-01-01T00:00:00';

// -- GUIDs ------------------------------------------------------------------
// The dev pointed at System.Guid. Map files use Guid.NewGuid().ToString("N"):
// a RFC 4122 version 4 UUID rendered as 32 lowercase hex digits, no hyphens.
// The file name is `${name}_${guid}` with no extension.

export function newGuid() {
  let hex;
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    hex = crypto.randomUUID().replace(/-/g, '');
  } else {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
    hex = [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
  }
  return hex.toLowerCase();
}

export function isGuidN(s) {
  return typeof s === 'string' && /^[0-9a-f]{32}$/.test(s);
}

/** Map name -> safe file name component. The game shows `name`, the file uses it too. */
export function mapFileName(name, guid) {
  const safe = String(name || 'Map').replace(/[\\/:*?"<>|]/g, '').trim() || 'Map';
  return `${safe}_${guid}`;
}

// -- .NET style float formatting -------------------------------------------

/**
 * Format a float the way the game does.
 *
 * Verified against every float in the sample map: it is .NET Framework / Mono
 * "R" formatting for Single, i.e. 7 significant digits with trailing zeros
 * trimmed, falling back to 9 significant digits when 7 does not round-trip.
 * (Modern shortest-round-trip formatting gives 8 digits for some values and
 * does not reproduce the file.) Newtonsoft always leaves a decimal point on,
 * so integral values are written as "1.0".
 */
export function f32(value) {
  const v = Math.fround(value);
  if (!Number.isFinite(v)) return '0.0';
  if (v === 0) return '0.0'; // also normalises -0
  let out = gDigits(v, 7);
  if (Math.fround(parseFloat(out)) !== v) out = gDigits(v, 9);
  if (!/[.eE]/.test(out)) out += '.0';
  return out;
}

/**
 * .NET "G{p}" for a positive/negative finite double, trailing zeros trimmed.
 *
 * The rule is .NET's own, quoted: fixed-point notation is used when the
 * exponent is **greater than -5 and less than the precision**, and scientific
 * notation otherwise. This used to expand everything down to 1e-7 on the
 * grounds that map data never got that small, and then a map full of custom
 * messages did: a sign turned by a hair off the vertical carries a Z rotation
 * of about 1e-7, and the game writes `-1.65042636E-07` where the old code wrote
 * `-0.000000165042636`. Which is not a rounding difference — it is a different
 * shape of number, and it broke the byte-for-byte round trip.
 *
 * Scientific form is .NET's too: `E`, an explicit sign, and the exponent padded
 * to at least two digits.
 *
 * The exponent is read back off `toExponential` rather than computed with
 * `Math.log10`, because rounding to `p` digits can carry into it — 9.9999e-5 at
 * seven digits is 1.000000e-4, and it is the rounded value that decides which
 * notation .NET uses.
 */
function gDigits(v, p) {
  const [mantissa, e] = v.toExponential(p - 1).split('e');
  const exp = Number(e);
  if (exp > -5 && exp < p) return trimZeros(expand(v, p, exp));
  const sign = exp < 0 ? '-' : '+';
  return `${trimZeros(mantissa)}E${sign}${String(Math.abs(exp)).padStart(2, '0')}`;
}

function trimZeros(s) {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

function expand(v, p, exp) {
  const decimals = Math.min(100, Math.max(0, p - 1 - exp));
  return v.toFixed(decimals);
}

const J = JSON.stringify; // for strings only

function vec3(v) {
  return `{"x":${f32(v.x)},"y":${f32(v.y)},"z":${f32(v.z)}}`;
}
function vec3i(v) {
  return `{"x":${Math.round(v.x)},"y":${Math.round(v.y)},"z":${Math.round(v.z)}}`;
}
function vec2(v) {
  return `{"x":${f32(v.x)},"y":${f32(v.y)}}`;
}
function vec2i(v) {
  return `{"x":${Math.round(v.x)},"y":${Math.round(v.y)}}`;
}

/** Plain JSON for the free-form rule-set value dictionaries. */
function dict(o) {
  const keys = Object.keys(o || {});
  if (!keys.length) return '{}';
  return `{${keys.map((k) => `${J(k)}:${JSON.stringify(o[k])}`).join(',')}}`;
}

// -- map object subtypes ----------------------------------------------------
// Most objects are a bare `MapObject`, but four subtypes carry extra fields,
// and the game writes them between "$type" and "type". Key order has to match
// or an untouched map stops re-exporting byte for byte, so the extras are kept
// in a `props` object and written in the order below.

export const BASE_OBJECT_KEYS = ['$type', 'type', 'position', 'rotation', 'scale'];

export const OBJECT_PROP_KEYS = {
  WeaponSpawnPoint: ['specificWeapon'],
  DamageBox: ['style'],
  EnemySpawnPoint: ['enemyTypes', 'behaviour'],
  // The one subtype whose extras are not all strings: `content` is the text on
  // the sign, `showInGame` a real JSON boolean. Both are written before "type",
  // in this order, exactly as the game writes them.
  CustomMessage: ['content', 'showInGame'],
};

/**
 * Extra keys for a `$type`, in file order. A subtype we have never seen falls
 * back to whatever the object itself carries, so a future game update adds
 * fields without this module needing to know about them.
 */
export function propKeysFor($type, props) {
  return OBJECT_PROP_KEYS[$type] || Object.keys(props || {});
}

// -- Serialise --------------------------------------------------------------

export function serializeMap(map) {
  const parts = [];
  parts.push(`"guid":${J(map.guid)}`);
  parts.push(`"version":${map.version ?? MAP_VERSION}`);
  parts.push(`"name":${J(map.name)}`);
  parts.push(`"author":${J(map.author ?? '')}`);
  parts.push(`"source":${J(map.source ?? 'Player')}`);
  parts.push(`"createdTime":${J(map.createdTime)}`);
  parts.push(`"editedTime":${J(map.editedTime)}`);
  parts.push(`"playedTime":${J(map.playedTime ?? DOTNET_MIN_DATE)}`);
  parts.push(`"mapBoundsSize":${vec3i(map.mapBoundsSize)}`);

  const rs = (map.ruleSets || []).map(
    (r) =>
      `{"name":${J(r.name)},"type":${J(r.type)},"intValues":${dict(r.intValues)},` +
      `"boolValues":${dict(r.boolValues)},"enumValues":${dict(r.enumValues)},` +
      `"flagsValues":${dict(r.flagsValues)}}`
  );
  parts.push(`"ruleSets":[${rs.join(',')}]`);

  const an = (map.anchors || []).map(
    (a) =>
      `{"$type":${J(a.$type ?? 'MetaGroupSpatialAnchor')},"guid":${J(a.guid)},` +
      `"groupGuid":${J(a.groupGuid)},"positionOffset":${vec3(a.positionOffset)},` +
      `"rotationOffset":${vec3(a.rotationOffset)}}`
  );
  parts.push(`"anchors":[${an.join(',')}]`);

  const mo = (map.mapObjects || []).map((o) => {
    if (o.raw && !o.dirty) return o.raw; // untouched -> byte-identical passthrough
    const $type = o.$type ?? 'MapObject';
    const extras = propKeysFor($type, o.props)
      .filter((k) => o.props?.[k] !== undefined)
      .map((k) => `${J(k)}:${JSON.stringify(o.props[k])},`)
      .join('');
    return (
      `{"$type":${J($type)},${extras}"type":${J(o.type)},` +
      `"position":${vec3(o.position)},"rotation":${vec3(o.rotation)},` +
      `"scale":${vec3(o.scale)}}`
    );
  });
  parts.push(`"mapObjects":[${mo.join(',')}]`);

  const nc = map.navCloud;
  parts.push(
    `"navCloud":{"position":${vec3(nc.position)},"rotation":${vec3(nc.rotation)},` +
      `"size":${vec2(nc.size)},"divisions":${vec2i(nc.divisions)},` +
      `"encodedPoints":${J(nc.encodedPoints)}}`
  );

  parts.push(`"hasArUcoAnchor":${map.hasArUcoAnchor ? 'true' : 'false'}`);
  return `{${parts.join(',')}}`;
}

// -- Parse ------------------------------------------------------------------

/**
 * Parse a map file. Keeps the original minified text of every map object so
 * anything the user never touches is written back exactly as it came in.
 */
export function parseMap(text) {
  const data = JSON.parse(text);
  if (typeof data !== 'object' || !data || !Array.isArray(data.mapObjects)) {
    throw new Error('Not a Spatial Ops map file: no mapObjects array.');
  }

  const rawObjects = extractRawMapObjects(text);
  const mapObjects = data.mapObjects.map((o, i) => {
    // Anything that is not one of the five base keys belongs to a subtype.
    // Collecting them generically means a field we have never seen still
    // survives a round trip instead of being silently dropped on edit.
    const props = {};
    for (const k of Object.keys(o)) {
      if (!BASE_OBJECT_KEYS.includes(k)) props[k] = o[k];
    }
    return {
      $type: o.$type || 'MapObject',
      type: o.type,
      props,
      position: { ...o.position },
      rotation: { ...o.rotation },
      scale: { ...o.scale },
      raw: rawObjects[i] || null,
      dirty: false,
    };
  });

  return {
    guid: isGuidN(data.guid) ? data.guid : newGuid(),
    version: data.version ?? MAP_VERSION,
    name: data.name ?? 'Untitled',
    author: data.author ?? '',
    source: data.source ?? 'Player',
    createdTime: data.createdTime ?? nowStamp(),
    editedTime: data.editedTime ?? nowStamp(),
    playedTime: data.playedTime ?? DOTNET_MIN_DATE,
    mapBoundsSize: { ...data.mapBoundsSize },
    ruleSets: (data.ruleSets || []).map(normalizeRuleSet),
    anchors: data.anchors || [],
    mapObjects,
    navCloud: data.navCloud
      ? {
          position: { ...data.navCloud.position },
          rotation: { ...data.navCloud.rotation },
          size: { ...data.navCloud.size },
          divisions: { ...data.navCloud.divisions },
          encodedPoints: data.navCloud.encodedPoints,
        }
      : defaultNavCloudStub(),
    hasArUcoAnchor: !!data.hasArUcoAnchor,
    unknownVersion: data.version !== MAP_VERSION ? data.version : null,
  };
}

/**
 * Give a rule set its four value dictionaries whether or not the file had
 * them, so the editor can write into one without checking first. An empty
 * dictionary means "every setting is at the game's default": the game only
 * serialises values that were changed away from it.
 */
function normalizeRuleSet(r) {
  return {
    name: r.name ?? '',
    type: r.type ?? 'FreeForAll',
    intValues: { ...(r.intValues || {}) },
    boolValues: { ...(r.boolValues || {}) },
    enumValues: { ...(r.enumValues || {}) },
    flagsValues: { ...(r.flagsValues || {}) },
  };
}

/** Pull the exact source text of each element of the "mapObjects" array. */
function extractRawMapObjects(text) {
  const key = '"mapObjects":';
  const at = text.indexOf(key);
  if (at < 0) return [];
  let i = text.indexOf('[', at);
  if (i < 0) return [];
  const out = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (i = i + 1; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) out.push(text.slice(start, i + 1));
    } else if (c === ']' && depth === 0) break;
  }
  return out;
}

export function nowStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

// -- navCloud ---------------------------------------------------------------
// The nav cloud is the player's physical play space, not a mesh derived from
// map geometry: one byte per grid point (0 = outside, 1 = inside), gzipped and
// base64'd. The sample is a 5 m radius circle on a 141x141 grid at 0.25 m
// spacing (35 m across) centred on the world origin.

export const NAV_SPACING = 0.25;

export async function decodeNavCloud(encoded) {
  const bin = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodeNavCloud(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  let s = '';
  for (let i = 0; i < out.length; i++) s += String.fromCharCode(out[i]);
  return btoa(s);
}

/** Grid index -> world metres, for a grid of `divisions` points centred on origin. */
export function navIndexToWorld(i, divisions) {
  return (i - (divisions - 1) / 2) * NAV_SPACING;
}

/** Build a play-space mask. shape: 'circle' | 'rect'. */
export function buildNavMask({ shape = 'circle', radius = 5, width = 7, depth = 7, divisions = 141 }) {
  const bytes = new Uint8Array(divisions * divisions);
  for (let r = 0; r < divisions; r++) {
    const z = navIndexToWorld(r, divisions);
    for (let c = 0; c < divisions; c++) {
      const x = navIndexToWorld(c, divisions);
      const inside =
        shape === 'circle'
          ? x * x + z * z <= radius * radius + 1e-6
          : Math.abs(x) <= width / 2 + 1e-6 && Math.abs(z) <= depth / 2 + 1e-6;
      if (inside) bytes[r * divisions + c] = 1;
    }
  }
  return bytes;
}

function defaultNavCloudStub() {
  return {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    size: { x: 35, y: 35 },
    divisions: { x: 141, y: 141 },
    encodedPoints: '',
  };
}

export async function defaultNavCloud(radius = 5) {
  const stub = defaultNavCloudStub();
  stub.encodedPoints = await encodeNavCloud(buildNavMask({ shape: 'circle', radius }));
  return stub;
}

/**
 * A nav cloud of the right shape with nothing walkable in it.
 *
 * The grid is still 141 x 141 at 0.25 m, because those numbers describe the play
 * space the headset was set up in rather than anything about the map, and every
 * export the game has written carries them. Only the mask is empty — which is
 * what a blank map should start as, so the first thing painted is the author's
 * and not a five metre circle they have to clear first.
 *
 * Encoded properly rather than left as an empty string: an empty gzip payload is
 * what the game would write for a grid nobody has walked, and a bare "" is a
 * shape the format has only ever been *seen* to tolerate, not to use.
 */
export async function emptyNavCloud() {
  const stub = defaultNavCloudStub();
  const { x, y } = stub.divisions;
  stub.encodedPoints = await encodeNavCloud(new Uint8Array(x * y));
  return stub;
}

// -- New map ----------------------------------------------------------------

/**
 * A blank map.
 *
 * No rule sets. The game's own new map carries five — one per mode, every
 * setting at its default — and `defaultRuleSets` in rules.js still builds
 * exactly that, because reproducing what the game writes is the standard the
 * format code is held to. But four of the five are for modes an empty map
 * cannot play, and a page of settings for a match nobody can start is not a
 * useful place to begin.
 * A mode is added here once its objectives are on the map. An empty `ruleSets`
 * array is legal in the format either way.
 *
 * No bot grid either — see `emptyNavCloud`. The grid is a thing you paint where
 * the bots may walk, and starting it as a five metre circle meant every map
 * began by rubbing one out.
 */
export async function newMap({ name = 'New Map', author = '' } = {}) {
  const ts = nowStamp();
  return {
    guid: newGuid(),
    version: MAP_VERSION,
    name,
    author,
    source: 'Player',
    createdTime: ts,
    editedTime: ts,
    playedTime: DOTNET_MIN_DATE,
    mapBoundsSize: { x: 7, y: 3, z: 7 },
    ruleSets: [],
    anchors: [],
    mapObjects: [],
    navCloud: await emptyNavCloud(),
    hasArUcoAnchor: false,
  };
}

