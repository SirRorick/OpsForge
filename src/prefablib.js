// ---------------------------------------------------------------------------
// prefablib.js — the community prefab library's shared rules
// ---------------------------------------------------------------------------
// The library is the one part of OpsForge with a server behind it: prefabs
// people share are kept on the same Vercel deployment as the editor, and api/
// is what takes them in, lists them and lets them be reported and moderated.
// This module is everything the editor and that server have to agree on, so
// it is written once and imported by both:
//
//   - the tag presets, and what makes a tag a tag;
//   - the typo check that offers "building" to somebody typing "biulding";
//   - the search that finds "bunker" under a prefab tagged "bunkers";
//   - what a prefab file may contain, checked strictly enough that the server
//     can rewrite every submission from its values and store nothing it was
//     not expecting;
//   - the size of the pictures, so every card in the library is shot the same.
//
// No three.js, no DOM, no Node: the tests run it headless and the server runs
// it with nothing else of the editor loaded but the catalog.
// ---------------------------------------------------------------------------

export const PREFAB_FORMAT = 'opsforge.prefab';
export const PREFAB_VERSION = 1;

export const LIMITS = {
  objects: 300,        // a prefab is a piece of a map; the whole map's budget is 700
  title: 60,
  description: 400,
  tags: 12,
  tagMin: 2,
  tagMax: 24,
  text: 500,           // a Custom Text Message, as the assistant is held to
  reportNote: 300,
  position: 60,        // metres from the prefab's own middle
  scale: [0.001, 100],
};

/** Reports that hide a prefab or a tag until it is reviewed. The admin panel can change it. */
export const REPORT_THRESHOLD = 3;

export const REPORT_REASONS = [
  { id: 'inappropriate', label: 'Offensive or inappropriate' },
  { id: 'spam', label: 'Spam, junk or a duplicate' },
  { id: 'broken', label: 'Broken, empty or not what it says' },
  { id: 'stolen', label: "Someone else's work" },
  { id: 'other', label: 'Something else' },
];

// The pictures every prefab is shown with. Rendered by the editor at the
// moment of sharing, from the same camera, lights and background for every
// submission — and checked to be exactly these sizes on the way in.
export const THUMB_SIZE = 384;
export const SPIN_FRAME = 192;
export const SPIN_FRAMES = 24;

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/**
 * The tags offered before anybody has written their own. Grouped the way a
 * person would look for a piece: what it is, what it looks like, how big, and
 * what it is for. Themes are the editor's own pack names, so a prefab built
 * from Camo pieces is offered "camo" without anybody having to think of it.
 */
export const TAG_PRESETS = [
  {
    group: 'Theme',
    tags: ['default', 'blue', 'orange', 'purple', 'camo', 'mykea', 'graffiti', 'paintball',
      'wild west', 'hatchet corp', 'corrupted technology', 'boundaries', 'mixed themes'],
  },
  {
    group: 'Kind',
    tags: ['building', 'house', 'bunker', 'tower', 'fort', 'room', 'wall', 'cover', 'barricade',
      'doorway', 'window', 'corridor', 'roof', 'ceiling', 'floor', 'bridge', 'gate', 'maze',
      'sniper nest', 'spawn area', 'objective', 'furniture', 'prop', 'decoration', 'vehicle',
      'nature', 'ruins', 'landmark', 'sign', 'full map section'],
  },
  {
    group: 'Style',
    tags: ['modern', 'sci-fi', 'military', 'industrial', 'urban', 'western', 'rustic', 'futuristic',
      'fantasy', 'medieval', 'haunted', 'holiday', 'minimal', 'damaged', 'colourful'],
  },
  { group: 'Size', tags: ['small', 'medium', 'large', 'huge'] },
  {
    group: 'Mode',
    tags: ['free for all', 'team deathmatch', 'capture the flag', 'domination', 'co-op survival'],
  },
];

export const PRESET_TAGS = TAG_PRESETS.flatMap((g) => g.tags);
const PRESET_SET = new Set(PRESET_TAGS);

/** The theme tag a pack stands for, or null for a pack that is not a theme. */
export function themeTagFor(packId) {
  const map = {
    default: 'default', blue: 'blue', orange: 'orange', purple: 'purple', camo: 'camo',
    mykea: 'mykea', graffiti: 'graffiti', paintball: 'paintball', wildwest: 'wild west',
    hatchetcorp: 'hatchet corp', corrupted: 'corrupted technology', boundaries: 'boundaries',
  };
  return map[packId] || null;
}

/**
 * A tag as it is stored: lower case, letters, digits, spaces, hyphens,
 * ampersands and apostrophes, one space at a time, 2 to 24 characters. Or ''
 * for something that is not a tag at all.
 */
export function normalizeTag(raw) {
  const t = String(raw ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[_./]+/g, ' ')
    .replace(/[^a-z0-9 &'-]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LIMITS.tagMax)
    .trim();
  return t.length >= LIMITS.tagMin ? t : '';
}

export const isPresetTag = (tag) => PRESET_SET.has(tag);

/**
 * Edit distance with transpositions (optimal string alignment): "biulding" is
 * one step from "building", not two. Bounded — once every cell in a row is
 * past `max` the answer is "too far" and the rest is not worth computing.
 */
export function editDistance(a, b, max = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = a.length, m = b.length;
  let prev2 = null;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[m];
}

/** How far a word may be from another and still be the same word mistyped. */
export function typoAllowance(word) {
  // Four letters is too short to guess at: "port" is a word, not a typo of "fort".
  return word.length <= 4 ? 0 : word.length <= 6 ? 1 : word.length <= 10 ? 2 : 3;
}

/** "buildings" -> "building", "boxes" -> "box". Crude, and only ever used to compare. */
function stem(word) {
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.length > 4 && /(s|x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * The tag somebody probably meant, when the one they typed is new and close to
 * one that already exists — or null when it is new and nothing like anything.
 * A plural of an existing tag counts as close; so does a typo within
 * `typoAllowance`. Ties go to the more used tag, then the preset.
 */
export function suggestTag(typed, known, usage = {}) {
  const tag = normalizeTag(typed);
  if (!tag) return null;
  const pool = [...new Set([...PRESET_TAGS, ...known])];
  if (pool.includes(tag)) return null;
  const allow = typoAllowance(tag);
  let best = null, bestScore = Infinity;
  for (const k of pool) {
    let d;
    if (stem(k) === stem(tag)) d = 0.5;
    else d = editDistance(tag, k, allow);
    if (d > allow) continue;
    const score = d - Math.min(0.4, (usage[k] || 0) / 100) - (isPresetTag(k) ? 0.05 : 0);
    if (score < bestScore) { best = k; bestScore = score; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * A handful of words people use for the same thing. Small on purpose: a search
 * for "house" should find the buildings, not every prefab with a door.
 */
const SYNONYMS = {
  house: ['building', 'home'],
  home: ['house', 'building'],
  building: ['house', 'structure'],
  barrier: ['cover', 'barricade', 'wall'],
  barricade: ['cover', 'barrier'],
  cover: ['barricade', 'barrier'],
  fortress: ['fort', 'bunker'],
  fort: ['fortress', 'bunker'],
  bunker: ['fort'],
  door: ['doorway', 'gate'],
  doorway: ['door'],
  car: ['vehicle'],
  truck: ['vehicle'],
  tank: ['vehicle'],
  tree: ['nature'],
  plant: ['nature'],
  scifi: ['sci-fi'],
  'sci fi': ['sci-fi'],
  spawn: ['spawn area'],
  sniper: ['sniper nest'],
  ruin: ['ruins', 'damaged'],
  western: ['wild west'],
  'wild west': ['western'],
};

function words(text) {
  return String(text ?? '').toLowerCase().normalize('NFKC').split(/[^a-z0-9-]+/).filter(Boolean);
}

/**
 * How well one search word matches one field's words: exact, a plural or
 * prefix of it, or a typo of it, best first. 0 for no match.
 */
function wordScore(q, fieldWords) {
  let best = 0;
  const qs = stem(q);
  for (const w of fieldWords) {
    if (w === q) return 1;
    if (stem(w) === qs) best = Math.max(best, 0.9);
    else if (q.length >= 3 && w.startsWith(q)) best = Math.max(best, 0.75);
    else {
      const allow = typoAllowance(q);
      if (allow && editDistance(q, w, allow) <= allow) best = Math.max(best, 0.6);
    }
  }
  return best;
}

/**
 * Rank `prefabs` for `query`, best first. Every word of the query has to match
 * something — a tag, the title, the author, the description — or its synonym;
 * a tag outranks a title and a title outranks the description. An empty
 * query returns everything, newest first.
 */
export function searchPrefabs(prefabs, query) {
  const raw = String(query ?? '').toLowerCase().trim();
  if (!raw) return [...prefabs].sort((a, b) => (b.created || 0) - (a.created || 0));
  const terms = words(raw);
  // A multi-word tag typed whole ("wild west") is a phrase, not two words.
  const phraseTags = new Set(PRESET_TAGS.filter((t) => t.includes(' ') && raw.includes(t)));
  const out = [];
  for (const p of prefabs) {
    const tags = (p.tags || []).map(String);
    const tagWords = tags.flatMap(words);
    const titleWords = words(p.title);
    const descWords = words(p.description);
    const authorWords = words(p.author?.name);
    let total = 0, ok = true;
    for (const phrase of phraseTags) if (tags.includes(phrase)) total += 12;
    for (const t of terms) {
      if ([...phraseTags].some((ph) => ph.split(' ').includes(t) && tags.includes(ph))) continue;
      const alts = [t, ...(SYNONYMS[t] || [])];
      let best = 0;
      for (const a of alts) {
        const weight = a === t ? 1 : 0.7;
        const aw = words(a);
        const one = (fw) => aw.reduce((n, x) => Math.min(n, wordScore(x, fw)), 1);
        best = Math.max(best,
          weight * 10 * one(tagWords),
          weight * 7 * one(titleWords),
          weight * 3 * one(authorWords),
          weight * 2 * one(descWords));
      }
      if (best <= 0) { ok = false; break; }
      total += best;
    }
    if (ok) out.push({ p, total });
  }
  out.sort((a, b) => b.total - a.total || (b.p.created || 0) - (a.p.created || 0));
  return out.map((r) => r.p);
}

/**
 * For a search that found nothing: the query with each mistyped word put
 * right — "zzzz bunkr" offers "zzzz bunker" — or null when nothing in it
 * looks like a typo of a tag. The whole query is tried first, as a tag can be
 * two words.
 */
export function didYouMean(query, known) {
  const q = normalizeTag(query);
  if (!q) return null;
  const whole = suggestTag(q, known);
  if (whole) return whole;
  const vocab = new Set([...PRESET_TAGS, ...known].flatMap((t) => t.split(' ')));
  let changed = false;
  const fixed = q.split(' ').map((w) => {
    if (vocab.has(w)) return w;
    const s = suggestTag(w, [...vocab]);
    if (s && !s.includes(' ')) { changed = true; return s; }
    return w;
  });
  return changed ? fixed.join(' ') : null;
}

// ---------------------------------------------------------------------------
// What a prefab may contain
// ---------------------------------------------------------------------------

export class PrefabError extends Error {}
const bad = (msg) => { throw new PrefabError(msg); };

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function vecOf(v, n, what) {
  if (!Array.isArray(v) || v.length !== n || !v.every(finite)) bad(`${what} must be ${n} numbers.`);
  return v.map((x) => (Object.is(x, -0) ? 0 : x));
}

/** Text a person typed, with control characters out and its length held. */
export function cleanText(v, max) {
  return String(v ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

/**
 * A prefab rebuilt from its values, or a PrefabError saying why not.
 *
 * `lookup(type, props)` is the catalog's `defFor`; anything it does not know,
 * or knows as the editor's own (the scale figure), is refused rather than kept
 * as a marker — a library entry is for placing in a map the game will load.
 * Every field the editor writes is re-made here and nothing else survives, so
 * what the server stores is exactly what this function returned.
 */
export function validatePrefab(doc, lookup) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) bad('That is not a prefab.');
  if (doc.format !== PREFAB_FORMAT) bad('That is not an OpsForge prefab.');
  if (!Number.isInteger(doc.version) || doc.version < 1 || doc.version > PREFAB_VERSION) {
    bad('That prefab was written by a version of OpsForge this one does not know.');
  }
  const list = doc.objects;
  if (!Array.isArray(list) || !list.length) bad('That prefab has nothing in it.');
  if (list.length > LIMITS.objects) bad(`A library prefab holds at most ${LIMITS.objects} objects; this one has ${list.length}.`);
  const objects = list.map((o, i) => {
    const at = `Object ${i + 1}`;
    if (!o || typeof o !== 'object') bad(`${at} is not an object.`);
    if (typeof o.type !== 'string' || !/^[A-Za-z0-9_]{1,80}$/.test(o.type)) bad(`${at} has no type.`);
    const given = o.props && typeof o.props === 'object' && !Array.isArray(o.props) ? o.props : {};
    const def = lookup(o.type, given);
    if (!def || def.unknown) bad(`${at} is "${o.type}", which is not a piece the game has.`);
    if (def.editorOnly) bad(`${at} is the editor's own ${def.label} and cannot be shared.`);
    // Props: only the keys the entry itself carries, each a short string or a
    // boolean, exactly as the editor writes them.
    const props = {};
    for (const key of Object.keys(def.props || {})) {
      if (!Object.prototype.hasOwnProperty.call(given, key)) continue;
      const v = given[key];
      if (typeof v === 'boolean') props[key] = v;
      else if (typeof v === 'string') props[key] = cleanText(v, LIMITS.text);
    }
    const p = vecOf(o.p, 3, `${at}'s position`);
    if (p.some((x) => Math.abs(x) > LIMITS.position)) bad(`${at} is more than ${LIMITS.position} m from the middle of the prefab.`);
    const q = vecOf(o.q, 4, `${at}'s rotation`);
    const len = Math.hypot(...q);
    if (len < 1e-6) bad(`${at}'s rotation is empty.`);
    const s = vecOf(o.s, 3, `${at}'s scale`);
    const [lo, hi] = LIMITS.scale;
    if (s.some((x) => Math.abs(x) < lo || Math.abs(x) > hi)) bad(`${at}'s scale is outside ${lo}–${hi}.`);
    return {
      type: def.type,
      $type: def.objectType || 'MapObject',
      props,
      p,
      q: q.map((x) => x / len),
      s,
    };
  });
  return {
    format: PREFAB_FORMAT,
    version: PREFAB_VERSION,
    name: cleanText(doc.name, LIMITS.title) || 'Prefab',
    objects,
  };
}

/** Rotate `v` by the quaternion `q` ([x, y, z, w]). */
function rotateByQuat(q, v) {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

/**
 * The prefab's size in metres, width by height by depth, from the catalog's
 * sizes — the same box the assistant reasons with. Shown on every card, so
 * "will this fit" is answered before anything is placed.
 */
export function prefabSize(doc, lookup) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const o of doc.objects) {
    const def = lookup(o.type, o.props || {});
    if (!def) continue;
    const [w, h, d] = def.size;
    const [ax, az] = def.anchor || [0.5, 0.5];
    const y0 = def.pivot === 'center' ? -h / 2 : 0;
    for (const cx of [-ax * w, (1 - ax) * w]) {
      for (const cy of [y0, y0 + h]) {
        for (const cz of [-az * d, (1 - az) * d]) {
          const r = rotateByQuat(o.q, [cx * o.s[0], cy * o.s[1], cz * o.s[2]]);
          for (let i = 0; i < 3; i++) {
            lo[i] = Math.min(lo[i], r[i] + o.p[i]);
            hi[i] = Math.max(hi[i], r[i] + o.p[i]);
          }
        }
      }
    }
  }
  if (!Number.isFinite(lo[0])) return [0, 0, 0];
  return hi.map((v, i) => Math.round((v - lo[i]) * 100) / 100);
}

/** Theme tags for the packs a prefab is built from, to offer ticked. */
export function suggestedThemeTags(doc, lookup) {
  const themes = new Set();
  for (const o of doc.objects) {
    const t = themeTagFor(lookup(o.type, o.props || {})?.pack);
    if (t) themes.add(t);
  }
  // Three or more themes is a mix, and saying so is more use to somebody
  // searching than three theme tags each of which is a third true.
  const real = [...themes].filter((t) => t !== 'boundaries');
  if (real.length <= 2) return [...themes];
  return themes.has('boundaries') ? ['mixed themes', 'boundaries'] : ['mixed themes'];
}

/** A size tag from the prefab's footprint, to offer ticked. */
export function suggestedSizeTag([w, h, d]) {
  const span = Math.max(w, d, h);
  return span < 1.5 ? 'small' : span < 4 ? 'medium' : span < 10 ? 'large' : 'huge';
}

// ---------------------------------------------------------------------------
// The notice
// ---------------------------------------------------------------------------

/** Shown the first time somebody opens the library, and kept a link away afterwards. */
export const UGC_NOTICE = [
  'Everything in the prefab library is made and shared by other people in the community. '
    + 'It is not made, reviewed or endorsed by OpsForge or by the makers of Spatial Ops.',
  'Prefabs are shared as they were submitted. They may be broken, may not suit your map or '
    + 'your room, and may occasionally be offensive before anybody has reported them. Look a '
    + 'prefab over before you use it, and check the finished map in a headset before anybody plays it.',
  'If you find something that should not be here, report it. Prefabs reported by several '
    + 'people are hidden until they have been reviewed.',
  'By sharing a prefab you confirm it is your own work, or that you have the right to share '
    + 'it, and that anybody may use it in their own maps. Anything shared can be hidden or '
    + 'removed, and accounts that break these rules can be barred from sharing.',
];
