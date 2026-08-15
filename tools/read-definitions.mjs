// ---------------------------------------------------------------------------
// read-definitions.mjs — report what the game's own ScriptableObjects say
// ---------------------------------------------------------------------------
// Usage:  node tools/read-definitions.mjs [--all] [--json]
//
//   --all    list every definition class found, not just the Default set
//   --json   emit machine-readable JSON instead of the summary table
//
// Reads reference/GameAssets/Definitions/*.asset, the game's own
// ScriptableObjects.
//
// IMPORTANT — what this export actually contains
//
// Every one of these .asset files is a 14-line MonoBehaviour stub. They carry
// recovered `m_Name` and the `m_Script` GUID and nothing else: the serialised
// fields are absent, because the IL2CPP build carries no type tree for the
// game's own scripts. So the display name, the category, the prefab reference
// and the icon reference are *not* in this export and cannot be read out of
// it. This tool does not pretend otherwise. It reports:
//
//   read      taken verbatim from the .asset file (name, script GUID)
//   confirmed cross-checked against a reference map file the game wrote
//   matched   resolved by exact filename against Prefabs/ or Sprite/
//   --        not present in the export
//
// `verifyFields` below re-checks the stub claim on every run, so if a future
// export does carry fields the tool says so instead of quietly ignoring them.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFS = join(ROOT, 'reference/GameAssets/Definitions');
const PREFABS = join(ROOT, 'reference/GameAssets/Prefabs');
const SPRITES = join(ROOT, 'reference/GameAssets/Sprite');
const LIBRARY = join(ROOT, 'reference/Library');

// Keys every Unity MonoBehaviour stub carries. Anything outside this set is a
// real serialised field and worth shouting about.
const BASE_KEYS = new Set([
  'm_ObjectHideFlags', 'm_CorrespondingSourceObject', 'm_PrefabInstance',
  'm_PrefabAsset', 'm_GameObject', 'm_Enabled', 'm_EditorHideFlags',
  'm_Script', 'm_Name', 'm_EditorClassIdentifier',
]);

/**
 * Minimal reader for these stubs. Not a YAML parser — it pulls the two keys
 * that survived and collects the name of anything else at field indent, so an
 * export with real data is detected rather than silently truncated.
 */
function readAsset(path) {
  const text = readFileSync(path, 'utf8');
  const name = /^\s{2}m_Name:\s*(.*)$/m.exec(text)?.[1].trim() ?? '';
  const scriptGuid = /m_Script:\s*\{[^}]*guid:\s*([0-9a-f]{32})/.exec(text)?.[1] ?? '';
  const extraFields = [];
  for (const m of text.matchAll(/^ {2}([A-Za-z_][\w]*):/gm)) {
    if (!BASE_KEYS.has(m[1])) extraFields.push(m[1]);
  }
  return { name, scriptGuid, extraFields };
}

function loadDefinitions() {
  const out = [];
  for (const f of readdirSync(DEFS)) {
    if (!f.endsWith('.asset')) continue;
    out.push({ file: f, ...readAsset(join(DEFS, f)) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Re-check the "no fields survived" claim so the report can never go stale. */
function verifyFields(defs) {
  const withFields = defs.filter((d) => d.extraFields.length);
  return {
    total: defs.length,
    withFields: withFields.length,
    sample: withFields.slice(0, 5).map((d) => `${d.name}: ${d.extraFields.join(', ')}`),
  };
}

// --- ground truth -----------------------------------------------------------
// The reference map files are the only artefacts the game itself wrote, so a
// type string found in one is confirmed rather than inferred.

function referenceTypeStrings() {
  const types = new Set();
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      let text;
      try { text = readFileSync(p, 'utf8'); } catch { continue; }
      for (const m of text.matchAll(/"type"\s*:\s*"([^"]+)"/g)) types.add(m[1]);
    }
  };
  walk(LIBRARY);
  walk(join(ROOT, 'reference'));
  return types;
}

/**
 * Definition asset name -> map type string.
 *
 * The Default pack's assets are named `Default<Thing>` but the game writes the
 * bare `<Thing>` — except DefaultElectricityBox, which keeps the prefix. That
 * is not a guess: both readings are checked against the type strings the game
 * actually wrote, and anything that fails to match is reported unconfirmed.
 */
function resolveTypeString(name, truth) {
  if (truth.has(name)) return { type: name, status: 'confirmed' };
  const stripped = name.replace(/^Default/, '');
  if (truth.has(stripped)) return { type: stripped, status: 'confirmed' };
  return { type: stripped, status: 'unconfirmed' };
}

// --- asset cross-references -------------------------------------------------

const prefabNames = () =>
  new Set(readdirSync(PREFABS).filter((f) => f.endsWith('.glb')).map((f) => f.slice(0, -4)));

const spriteNames = () =>
  new Set(readdirSync(SPRITES).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)));

/**
 * Icons are not named after their type, and the mismatches are not derivable —
 * `Icon_BarrierNormal` is BarrierFull, `Icon_BarrierUWall` is BarrierU, and the
 * assets carry both the `Cilinder` misspelling and `Cylinder`. Anything not
 * listed here falls back to an exact `Icon_<type>` match, and an entry that
 * resolves to no existing sprite is reported rather than assumed.
 *
 * The two spellings are two different icon sets, not a typo to be normalised:
 * `Cilinder` belongs to the 512px photographic renders in ItemIconsAtlas, which
 * is the library set the Default pack draws from, while `Cylinder` belongs to a
 * 256px schematic set in SolidIconsAtlas that carries one variant per theme.
 * Each name below was checked by eye against the sliced PNG.
 *
 * These are slice-icons.mjs output names, so where several sprites share an
 * m_Name the asset filename is used — `Icon_BoxSolid_1` is the Default box, one
 * of five distinct sprites all called `Icon_BoxSolid`.
 */
const ICON_ALIASES = {
  BarrierFull: 'Icon_BarrierNormal',
  BarrierU: 'Icon_BarrierUWall',
  BoxSolid: 'Icon_BoxSolid_1',
  BoxSolidGrounded: 'Icon_BoxSolid_grounded',
  CylinderSolid: 'Icon_CilinderSolid',
  CylinderSolidGrounded: 'Icon_CilinderSolid_grounded',
  WallSolid: 'Icon_WallSolid_1',
  Tunnel: 'Icon_TunnelSolid',
  DestructibleCrate: 'Icon_CrateDestructable',
  DefaultElectricityBox: 'Icon_ElectricityBoxDefault',
};

function resolveIcon(type, sprites) {
  const candidates = [ICON_ALIASES[type], `Icon_${type}`].filter(Boolean);
  for (const c of candidates) if (sprites.has(c)) return { icon: c, status: 'matched' };
  return { icon: null, status: 'missing' };
}

/**
 * Prefabs are named after the map type string, so an exact hit is a real
 * reference. The Default electricity box is the one that is not: its mesh ships
 * as `ElectricityBoxDefaultVisual`, alongside per-theme `ElectricityBox<Theme>`.
 */
const PREFAB_ALIASES = {
  DefaultElectricityBox: 'ElectricityBoxDefaultVisual',
};

function resolvePrefab(type, prefabs) {
  const candidates = [type, PREFAB_ALIASES[type]].filter(Boolean);
  for (const c of candidates) if (prefabs.has(c)) return { prefab: `${c}.glb`, status: 'matched' };
  return { prefab: null, status: 'missing' };
}

// --- theme system -----------------------------------------------------------

/**
 * Theme prefixes are read off the definition roster rather than hardcoded: the
 * suffix shared by the Default set is the base type, and whatever precedes it
 * on a sibling asset is that sibling's theme.
 */
function themeReport(defs, defnClassGuid) {
  const objects = defs.filter((d) => d.scriptGuid === defnClassGuid).map((d) => d.name);
  const bases = objects.filter((n) => n.startsWith('Default')).map((n) => n.slice('Default'.length));
  // Longest base first, or `DestructibleCrate` matches the base `Crate` and
  // invents a "BlueDestructible" theme.
  const ranked = [...bases].sort((a, b) => b.length - a.length);
  const themes = new Map();
  for (const n of objects) {
    for (const b of ranked) {
      if (n.endsWith(b) && n.length > b.length) {
        const theme = n.slice(0, n.length - b.length);
        if (!themes.has(theme)) themes.set(theme, []);
        themes.get(theme).push(b);
        break;
      }
    }
  }
  const explicit = defs
    .filter((d) => d.name.startsWith('MapObjectTheme_'))
    .map((d) => d.name.slice('MapObjectTheme_'.length));
  return { themes, explicit, objects, bases };
}

// --- output -----------------------------------------------------------------

function table(rows, headers) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  if (!existsSync(DEFS)) {
    console.error(`No definitions at ${DEFS}. This tool needs the (gitignored) assets.`);
    process.exit(1);
  }

  const defs = loadDefinitions();
  const fields = verifyFields(defs);
  const truth = referenceTypeStrings();
  const prefabs = prefabNames();
  const sprites = spriteNames();

  // The class that owns the map object definitions, identified by the script
  // DefaultCrate points at rather than by a hardcoded GUID.
  const defnClassGuid = defs.find((d) => d.name === 'DefaultCrate')?.scriptGuid;
  const { themes, explicit, objects, bases } = themeReport(defs, defnClassGuid);

  const defaultSet = defs
    .filter((d) => d.scriptGuid === defnClassGuid && d.name.startsWith('Default'))
    .map((d) => {
      const { type, status } = resolveTypeString(d.name, truth);
      const p = resolvePrefab(type, prefabs);
      const i = resolveIcon(type, sprites);
      return { asset: d.name, type, typeStatus: status, ...p, ...i, iconStatus: i.status };
    });

  if (args.includes('--json')) {
    console.log(JSON.stringify({ fields, defaultSet, themes: [...themes], explicit }, null, 2));
    return;
  }

  console.log('Definitions: %d assets, %d distinct script classes',
    defs.length, new Set(defs.map((d) => d.scriptGuid)).size);
  console.log();
  console.log('FIELD RECOVERY');
  console.log('  %d of %d assets carry any serialised field beyond the MonoBehaviour header.',
    fields.withFields, fields.total);
  if (!fields.withFields) {
    console.log('  Name + script GUID only (no IL2CPP type tree), so');
    console.log('  display name, category, prefab and icon fields are NOT in this export.');
  } else {
    fields.sample.forEach((s) => console.log('    ' + s));
  }
  console.log();

  console.log('DEFAULT SET  (script %s, %d map object definitions total)',
    defnClassGuid?.slice(0, 8), objects.length);
  console.log();
  console.log(table(
    defaultSet.map((d) => [
      d.asset,
      d.type + (d.typeStatus === 'confirmed' ? '' : ' (?)'),
      '--',
      '--',
      d.prefab ?? '--',
      d.icon ?? '--',
    ]),
    ['definition asset', 'map type (confirmed)', 'display', 'category', 'prefab', 'sprite'],
  ));
  console.log();
  console.log('  display / category are "--" because those fields are absent from the export.');
  console.log('  map type is cross-checked against the reference maps the game wrote;');
  console.log('  "(?)" marks one no reference map corroborates.');
  console.log();

  console.log('THEMES');
  console.log('  MapObjectTheme_* assets: %s', explicit.join(', ') || '(none)');
  console.log('  Theme prefixes on the definition roster (%d base types):', bases.length);
  console.log();
  console.log(table(
    [...themes].sort((a, b) => b[1].length - a[1].length)
      .map(([t, list]) => [t || '(bare)', list.length, list.slice(0, 6).join(' ') + (list.length > 6 ? ' ...' : '')]),
    ['theme prefix', 'types', 'sample'],
  ));

  if (args.includes('--all')) {
    console.log();
    console.log('ALL SCRIPT CLASSES');
    const byGuid = new Map();
    for (const d of defs) {
      if (!byGuid.has(d.scriptGuid)) byGuid.set(d.scriptGuid, []);
      byGuid.get(d.scriptGuid).push(d.name);
    }
    console.log(table(
      [...byGuid].sort((a, b) => b[1].length - a[1].length).slice(0, 25)
        .map(([g, names]) => [g.slice(0, 12), names.length, names.slice(0, 4).join(' ')]),
      ['script guid', 'assets', 'sample'],
    ));
  }
}

main();
