// ---------------------------------------------------------------------------
// match-assets.mjs — tie every catalog entry to its mesh, texture and icon
// ---------------------------------------------------------------------------
// Usage:  npm run match-assets -- [--json] [--misses] [--pack <id>]
//
// The catalog is keyed by the map type string, which is what the game writes to
// a file. The art is keyed by whatever the artists called it, and the two only
// agree about half the time. This resolves one to the other and says how each
// match was reached, so a guess never passes as a fact.
//
//   exact       the prefab is named after the map type string
//   case        same, ignoring case (the catalog says Paintball, the art
//               says PaintBall)
//   theme       the theme prefix was rewritten before matching — the art has
//               its own vocabulary: MYKEA is Indoor, Graffiti is StreetStyle,
//               HatchetCorp is HatCo, Camo is Military in the icons
//   alias       an explicit entry in IRREGULAR below, because nothing about
//               the name is derivable
//   --          no match; reported rather than guessed at
//
// Textures are not matched by name at all. A GLB embeds its images in the BIN
// chunk with no filename attached, so each embedded PNG is hashed and looked up
// against a hash of every file in Textures/. That is an identity, not a guess.
// Only base-colour maps are embedded; the normal and ORM siblings sitting next
// to them in Textures/ are reported through the material name instead.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'reference/GameAssets');
const PREFABS = join(ASSETS, 'Prefabs');
const TEXTURES = join(ASSETS, 'Textures');
const ICONS = join(ASSETS, 'Icons');

/**
 * Theme vocabularies. The left side is how the map type string spells a theme,
 * the right side is how the prefabs do. Applied as a prefix rewrite before
 * matching, so MYKEABarrierCorner looks for IndoorBarrierCorner.
 */
const THEME_PREFIX = {
  MYKEA: 'Indoor',
  Graffiti: 'StreetStyle',
  HatchetCorp: 'HatCo',
  Paintball: 'PaintBall',
};

/**
 * Suffixes the prefabs add and the type strings do not. `Visual` marks the
 * mesh-only prefab that the map object instantiates.
 */
const SUFFIXES = ['', 'Visual', 'Arena'];

/**
 * Everything whose prefab name cannot be derived from its type string. Each was
 * confirmed against the sliced icon or the measured geometry rather than picked
 * because it looked close — see docs/FORMAT.md.
 */
const IRREGULAR = {
  // The Default electricity box, and the colour themes' barriers and crates,
  // are all named Default<Base><Colour>Visual.
  DefaultElectricityBox: 'ElectricityBoxDefaultVisual',
  BlueElectricityBox: 'ElectricityBoxBlue',
  OrangeElectricityBox: 'ElectricityBoxOrange',
  PurpleElectricityBox: 'ElectricityBoxPurple',

  // Wild West names its barriers by height and function, not by the shared
  // Full/Low/Corner vocabulary.
  WildWestBarrierFull: 'WildWestBarrierTall',
  WildWestBarrierLow: 'WildWestBarrierShort',
  WildWestBarrierCorner: 'WildWestBarrierCorner90',

  // Graffiti's barriers keep the base name first and the theme second.
  GraffitiBarrierFull: 'BarrierStreetStyle2x1',
  GraffitiBarrierLow: 'BarrierStreetStyleLow1m',
  GraffitiBarrierCorner: 'BarrierStreetStyleCorner90',
  GraffitiBarrierWindow: 'BarrierStreetStyleWindow2x1m',
  GraffitiBarrierBroken: 'BarrierStreetStyleBroken2x1m',

  // Camo calls its half-height barrier Half, and its corner 90Corner.
  CamoBarrierLow: 'CamoBarrierHalfVisual',
  CamoBarrierCorner: 'CamoBarrier90CornerVisual',
  CamoBarrierX: 'CamoBarrierUVisual',

  // Hatchet Corp's crate and pillar are modelled as barriers.
  HatchetCorpCrate: 'HatCoBarrierCrateVisual',
  HatchetCorpPillar: 'HatCoBarrierPillarVisual',
  HatchetCorpBarrierL: 'HatCoBarrierUVisual',
  HatchetCorpBarrierWindow: 'HatCoBarrierWallWindow',

  // MYKEA's furniture, settled by measuring the meshes against the icons: the
  // U barrier is a 2 m panel and not the sofa its prefab name suggests, the
  // sofa is the 1.66 m grounded couch, the cushion is the 1.0 x 0.17 x 0.5 mat
  // the crate icon draws, and the ottoman is the 0.5 m cube called a Cover.
  MYKEABarrierU: 'IndoorBarrierUVisualCouch',
  MYKEASofa: 'IndoorBarrierGroundedVisualCouch',
  MYKEACushion: 'IndoorBarrierCrateVisual',
  MYKEAOttoman: 'IndoorCover1x1',

  // Paintball's crate, and its odd barrier out.
  PaintballCrate: 'PaintBallCrateVisual',
  PaintballBarrierD: 'PaintBallBarrierUVisual',

  // Corrupted Technology. The crystals are numbered in the art and described
  // in the type strings; the pairing is settled by footprint, see below.
  CenterStationCPU: 'CentralStationCPU',
  SampleAnalysisMachine: 'SampleAnalysisMachineArena',
  CrystalCircle: 'Crystal02',
  CrystalHalfCircle: 'Crystal01',
  CrystalSmall: 'Crystal03',
  DarkCrystalCircle: 'CrystalDark02',
  DarkCrystalHalfCircle: 'CrystalDark01',
  DarkCrystalSmall: 'CrystalDark03',

  CaptureFlagSpawnTeam1: 'CaptureFlagSpawnPointTeam1',
  CaptureFlagSpawnTeam2: 'CaptureFlagSpawnPointTeam2',
};

/**
 * Icons, keyed by catalog key. There is no rule to derive these from: each
 * theme's icons were named by whoever drew them, so the table is explicit and
 * every entry was checked against the sliced PNG.
 *
 * The vocabularies, for orientation: the colour themes say Cube / Cilinder /
 * Wall / Tunel, Camo is Military, Graffiti is Grafitti (and Pidgeon), Hatchet
 * Corp is HatCo, Paintball is PaintBall, and MYKEA and Wild West use
 * `Image_<Theme>_*` rather than `Icon_*` at all. Tunnel is `TunelBlue` but
 * `TuneOrange` and `TunePurple`.
 */
const COLOUR_TUNNEL = { Blue: 'icon_TunelBlue', Orange: 'icon_TuneOrange', Purple: 'icon_TunePurple' };

function colourIcons(c) {
  return {
    [`${c}BarrierCorner`]: `icon_DefaultBarrierCorner${c}`,
    [`${c}BarrierFull`]: `icon_DefaultBarrierFull${c}`,
    [`${c}BarrierLow`]: `icon_DefaultBarrierLow${c}`,
    [`${c}BarrierU`]: `icon_DefaultBarrierU${c}`,
    [`${c}BarrierWindow`]: `icon_DefaultBarrierWindow${c}`,
    [`${c}Crate`]: `icon_DefaultCrate${c}`,
    [`${c}DestructibleCrate`]: `icon_DefaultCrateDestructable${c}`,
    [`${c}ElectricityBox`]: `Icon_ElectricityBox${c}`,
    [`${c}BoxSolid`]: `icon_Cube${c}`,
    [`${c}BoxSolidGrounded`]: `icon_Cube${c}_grounded`,
    [`${c}CylinderSolid`]: `icon_Cilinder${c}`,
    [`${c}CylinderSolidGrounded`]: `icon_Cilinder${c}_grounded`,
    [`${c}WallSolid`]: `icon_Wall${c}`,
    [`${c}Tunnel`]: COLOUR_TUNNEL[c],
  };
}

const ICONS_BY_KEY = {
  // Default — the 512px photographic set in ItemIconsAtlas.
  BarrierCorner: 'Icon_BarrierCorner', BarrierFull: 'Icon_BarrierNormal',
  BarrierLow: 'Icon_BarrierLow', BarrierU: 'Icon_BarrierUWall',
  BarrierWindow: 'Icon_BarrierWindow', Tunnel: 'Icon_TunnelSolid',
  BoxSolid: 'Icon_BoxSolid_1', BoxSolidGrounded: 'Icon_BoxSolid_grounded',
  CylinderSolid: 'Icon_CilinderSolid', CylinderSolidGrounded: 'Icon_CilinderSolid_grounded',
  WallSolid: 'Icon_WallSolid_1', Crate: 'Icon_Crate',
  DestructibleCrate: 'Icon_CrateDestructable', DefaultElectricityBox: 'Icon_ElectricityBoxDefault',

  ...colourIcons('Blue'), ...colourIcons('Orange'), ...colourIcons('Purple'),

  CamoBarrierCorner: 'icon_MilitaryBarrier90Corner', CamoBarrierFull: 'icon_MilitaryBarrierFull',
  CamoBarrierLow: 'icon_MilitaryBarrierHalf', CamoBarrierWindow: 'icon_MilitaryBarrierWindow',
  CamoBarrierX: 'icon_MilitaryBarrierU', CamoTunnel: 'icon_MilitaryTunel',
  CamoBoxSolid: 'icon_MilitaryCube', CamoBoxSolidGrounded: 'icon_MilitaryCube_grounded',
  CamoCylinderSolid: 'icon_MilitaryCilinder', CamoCylinderSolidGrounded: 'icon_MilitaryCilinder_grounded',
  CamoWallSolid: 'icon_MilitaryWall', CamoCrate: 'icon_MilitaryCrate',
  CamoCrateBig: 'icon_MilitaryCrateBig',

  MYKEABarrierCorner: 'Image_MYKEA_barrier_corner_icon', MYKEABarrierFull: 'Image_MYKEA_barrier_full_icon',
  MYKEABarrierLow: 'Image_MYKEA_barrier_low_icon', MYKEABarrierU: 'Image_MYKEA_barrier_U_icon',
  MYKEABarrierWindow: 'Image_MYKEA_barrier_window_icon', MYKEATunnel: 'Image_MYKEA_Tunel',
  MYKEABoxSolid: 'Image_MYKEA_Solid_box', MYKEABoxSolidGrounded: 'Image_MYKEA_Solid_box_grounded',
  MYKEACylinderSolid: 'Image_MYKEA_Solid_cilinder',
  MYKEACylinderSolidGrounded: 'Image_MYKEA_Solid_cilinder_grounded',
  MYKEAWallSolid: 'Image_MYKEA_Wall', MYKEASofa: 'Image_MYKEA_sofa_icon',
  MYKEAOttoman: 'Image_MYKEA_cover_icon', MYKEACushion: 'Image_MYKEA_crate_icon',

  GraffitiBarrierFull: 'icon_Grafitti_Barrier', GraffitiBarrierCorner: 'icon_Grafitti_CornerBarrier',
  GraffitiBarrierLow: 'icon_Grafitti_ShortBarrier', GraffitiBarrierWindow: 'icon_Grafitti_WindowBarrier',
  GraffitiBarrierBroken: 'icon_Grafitti_LBarrier', GraffitiTunnel: 'icon_Grafitti_Tunel',
  GraffitiBoxSolid: 'icon_Grafitti_Box_crate', GraffitiBoxSolidGrounded: 'icon_Grafitti_Box_crate_grounded',
  GraffitiCylinderSolid: 'icon_Grafitti_Cilinder_crate',
  GraffitiCylinderSolidGrounded: 'icon_Grafitti_Cilinder_crate_grounded',
  GraffitiWallSolid: 'icon_Grafitti_Wall', GraffitiBarrel: 'icon_Grafitti_Barrel',
  GraffitiCrate: 'icon_Grafitti_Crate', GraffitiPigeon: 'icon_Grafitti_Pidgeon',

  HatchetCorpBarrierCorner: 'icon_HatCoBarrierCorner',
  HatchetCorpBarrierDoorway: 'icon_HatCoBarrierDoorway',
  // Checked by eye: WallWindow is the one with an actual opening, so it is the
  // window barrier; SmallWindow is solid with only a recessed panel, so it is
  // the full one, despite what the names suggest.
  HatchetCorpBarrierFull: 'icon_HatCoBarrierSmallWindow',
  HatchetCorpBarrierL: 'icon_HatCoBarrierU',
  HatchetCorpBarrierSlope: 'icon_HatCoBarrierSlope',
  HatchetCorpBarrierWindow: 'icon_HatCoBarrierWallWindow',
  HatchetCorpPillar: 'icon_HatCoBarrierPillar', HatchetCorpTunnel: 'icon_HatCoTunel',
  HatchetCorpBoxSolid: 'icon_HatCoBoxSolid', HatchetCorpBoxSolidGrounded: 'icon_HatCoBoxSolid_grounded',
  HatchetCorpCylinderSolid: 'icon_HatCoCilinderSolid',
  HatchetCorpCylinderSolidGrounded: 'icon_HatCoCilinderSolid_grounded',
  HatchetCorpWallSolid: 'icon_HatCoWall', HatchetCorpCrate: 'icon_HatCoBarrierCrate',

  PaintballBarrierCorner: 'icon_PaintBallBarrierCorner', PaintballBarrierFull: 'icon_PaintBallBarrierFull',
  PaintballBarrierLow: 'icon_PaintBallBarrierLow', PaintballBarrierD: 'icon_PaintBallBarrierU',
  PaintballBarrierWindow: 'icon_PaintBallBarrierWindow', PaintballTunnel: 'icon_PaintBallSolidTunel',
  PaintballBoxSolid: 'icon_PaintBallSolidCrate',
  PaintballBoxSolidGrounded: 'icon_PaintBallSolidCrate_grounded',
  PaintballCylinderSolid: 'icon_PaintBallSolidCilinder',
  PaintballCylinderSolidGrounded: 'icon_PaintBallSolidCilinder_grounded',
  PaintballWallSolid: 'icon_PaintBallSolidWall', PaintballCrate: 'icon_PaintBallCrate',

  WildWestBarrierBroken: 'Image_WildWest_barrier_broken_icon',
  WildWestBarrierCorner: 'Image_WildWest_barrier_corner_icon',
  WildWestBarrierDoor: 'Image_WildWest_barrier_door_icon',
  WildWestBarrierFull: 'Image_WildWest_barrier_full_icon',
  WildWestBarrierLow: 'Image_WildWest_barrier_short_icon',
  WildWestTunnel: 'Image_WildWest_tunel', WildWestBoxSolid: 'Image_WildWest_cube',
  WildWestBoxSolidGrounded: 'Image_WildWest_cube_grounded',
  WildWestCylinderSolid: 'Image_WildWest_cilinder',
  WildWestCylinderSolidGrounded: 'Image_WildWest_cilinder_grounded',
  WildWestWallSolid: 'Image_WildWest_wall', WildWestBarrel: 'Image_WildWest_barrel_icon',
  WildWestCacti: 'Image_WildWest_barrier_cactus_icon',

  CenterStationCPU: 'Icon_Campaign_CenterStationCPU', CoffeeMachine: 'Icon_Campaign_CoffeeMachine',
  Console: 'Icon_Campaign_Console', Recuperator: 'Icon_Campaign_Recuperator',
  SampleAnalysisMachine: 'Icon_Campaign_SampleAnalysisMachine', Server: 'Icon_Campaign_Server',
  WireContainer: 'Icon_Campaign_WireContainer', Chopper: 'Icon_Campaign_Chopper',
  Tank: 'Icon_Campaign_Tank', Truck: 'Icon_Campaign_Truck',
  CrystalCircle: 'Icon_Campaign_Crystal02', CrystalHalfCircle: 'Icon_Campaign_Crystal01',
  CrystalSmall: 'Icon_Campaign_Crystal03', DarkCrystalCircle: 'Icon_Campaign_CrystalDark02',
  DarkCrystalHalfCircle: 'Icon_Campaign_CrystalDark01', DarkCrystalSmall: 'Icon_Campaign_CrystalDark03',

  DamageBox: 'Icon_DamageBox', DamageBoxTeam1: 'Icon_DamageBoxTeam1',
  DamageBoxTeam2: 'Icon_DamageBoxTeam2', ExplosiveBarrel: 'Icon_ExplosiveBarrel',
  Jumbotron: 'Icon_JumbotronSingleScreen', Minigun: 'Icon_Minigun',
  EnemySpawnPoint: 'Icon_Enemy_Spawner',
  WeaponSpawnPoint: 'icon_weapons_Shotgunspawner',

  DominationZoneA: 'Icon_FlagA', DominationZoneB: 'Icon_FlagB', DominationZoneC: 'Icon_FlagC',
  PlayerSpawnZoneTeam1: 'Icon_SpawnZoneTeam1', PlayerSpawnZoneTeam2: 'Icon_SpawnZoneTeam2',
  CaptureFlagSpawnTeam1: 'Icon_OrangeTeamFlag', CaptureFlagSpawnTeam2: 'Icon_PurpleTeamFlag',
};

/**
 * Weapon spawners: ten catalog entries, one type and one mesh, told apart by
 * props.specificWeapon. The icon is the weapon rather than the spawner.
 */
const WEAPON_ICONS = {
  All: 'icon_gears_weaponspawner', Flashbang: 'Icon_flashbang_silhouette',
  Grenade: 'Icon_granade_silhouette', Handgun: 'Icon_handgun_silhouette',
  Healthpack: 'Icon_healthpack_silhouette', RiotShield: 'Icon_shield_silhouette',
  RPG: 'Icon_rpg_silhouette', Shotgun: 'Icon_shotgun_silhouette',
  SMG: 'Icon_smg_silhouette', Sniper: 'Icon_sniper_silhouette',
};

/**
 * Pairings that are reasoned rather than read. Reported so they never pass as
 * confirmed. The crystals are the notable ones: the art numbers them 01..03 and
 * the type strings describe them, with nothing in the assets linking the two.
 * Small is settled by footprint — Crystal03 is much the smallest — and Circle
 * against HalfCircle by roundness, Crystal02 being 1.61 x 1.36 where Crystal01
 * is the flatter arc at 1.83 x 1.15.
 */
const INFERRED = new Set([
  'CrystalCircle', 'CrystalHalfCircle', 'DarkCrystalCircle', 'DarkCrystalHalfCircle',
  'GraffitiBarrierBroken', 'CamoBarrierX', 'PaintballBarrierD', 'HatchetCorpBarrierL',
]);

// --- GLB ---------------------------------------------------------------------

const GLB_MAGIC = 0x46546c67, CHUNK_JSON = 0x4e4f534a, CHUNK_BIN = 0x004e4942;

function readGlb(path) {
  const buf = readFileSync(path);
  if (buf.length < 12 || buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error('not a GLB');
  let pos = 12, json = null, bin = null;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32LE(pos), type = buf.readUInt32LE(pos + 4);
    if (type === CHUNK_JSON) json = JSON.parse(buf.toString('utf8', pos + 8, pos + 8 + len));
    else if (type === CHUNK_BIN) bin = buf.subarray(pos + 8, pos + 8 + len);
    pos += 8 + len + ((4 - (len % 4)) % 4);
  }
  return { json, bin };
}

/** sha1 of every PNG in Textures/, so an embedded image can be named. */
function hashTextures() {
  const byHash = new Map();
  for (const f of readdirSync(TEXTURES)) {
    if (!f.endsWith('.png')) continue;
    byHash.set(createHash('sha1').update(readFileSync(join(TEXTURES, f))).digest('hex'), f);
  }
  return byHash;
}

function texturesOf(file, byHash) {
  const { json, bin } = readGlb(join(PREFABS, file));
  const out = [];
  for (const img of json.images ?? []) {
    if (img.bufferView === undefined || !bin) continue;
    const bv = json.bufferViews[img.bufferView];
    const off = bv.byteOffset ?? 0;
    const hash = createHash('sha1').update(bin.subarray(off, off + bv.byteLength)).digest('hex');
    const name = byHash.get(hash);
    if (name) out.push(name);
  }
  const materials = (json.materials ?? []).map((m) => m.name).filter(Boolean)
    // Shared engine materials, not the object's own look.
    .filter((n) => !/^MATTerminalSpawn$|^MapObjectStretcher/.test(n));
  return { textures: [...new Set(out)], materials };
}

// --- resolution --------------------------------------------------------------

/** The colour themes reskin the Default meshes: Default<Base><Colour>Visual. */
const COLOURS = ['Blue', 'Orange', 'Purple'];

function resolveModel(type, prefabs, lower) {
  if (IRREGULAR[type]) {
    const want = IRREGULAR[type];
    if (prefabs.has(want)) return { model: want, modelHow: 'alias' };
    return { model: null, modelHow: '--', note: `alias ${want} not on disk` };
  }
  for (const s of SUFFIXES) {
    if (prefabs.has(type + s)) return { model: type + s, modelHow: s ? 'exact+suffix' : 'exact' };
  }
  for (const s of SUFFIXES) {
    const hit = lower.get((type + s).toLowerCase());
    if (hit) return { model: hit, modelHow: 'case' };
  }
  for (const c of COLOURS) {
    if (!type.startsWith(c)) continue;
    const want = `Default${type.slice(c.length)}${c}Visual`;
    if (prefabs.has(want)) return { model: want, modelHow: 'colour' };
    const hit = lower.get(want.toLowerCase());
    if (hit) return { model: hit, modelHow: 'colour' };
  }
  for (const [from, to] of Object.entries(THEME_PREFIX)) {
    if (!type.startsWith(from)) continue;
    const swapped = to + type.slice(from.length);
    for (const s of SUFFIXES) {
      if (prefabs.has(swapped + s)) return { model: swapped + s, modelHow: 'theme' };
      const hit = lower.get((swapped + s).toLowerCase());
      if (hit) return { model: hit, modelHow: 'theme' };
    }
  }
  return { model: null, modelHow: '--' };
}

function resolveIcon(def, icons) {
  const key = def.key || def.type;
  const weapon = def.props?.specificWeapon;
  if (weapon) {
    const want = WEAPON_ICONS[weapon];
    if (want && icons.has(want)) return { icon: want, iconHow: 'weapon' };
    return { icon: null, iconHow: '--' };
  }
  const want = ICONS_BY_KEY[key] ?? ICONS_BY_KEY[def.type];
  if (want && icons.has(want)) {
    return { icon: want, iconHow: INFERRED.has(key) ? 'inferred' : 'table' };
  }
  if (want) return { icon: null, iconHow: '--', iconNote: `${want} not sliced` };
  for (const c of [`Icon_${def.type}`, `icon_${def.type}`]) {
    if (icons.has(c)) return { icon: c, iconHow: 'exact' };
  }
  return { icon: null, iconHow: '--' };
}

// --- main --------------------------------------------------------------------

export async function matchAll() {
  const { BUILTIN_PACKS } = await import(pathToFileURL(join(ROOT, 'src/packs.js')).href);
  const prefabs = new Set(readdirSync(PREFABS).filter((f) => f.endsWith('.glb')).map((f) => f.slice(0, -4)));
  const lower = new Map([...prefabs].map((n) => [n.toLowerCase(), n]));
  const icons = new Set(existsSync(ICONS) ? readdirSync(ICONS).map((f) => f.slice(0, -4)) : []);
  const byHash = hashTextures();

  const rows = [];
  for (const pack of BUILTIN_PACKS) {
    for (const def of pack.objects) {
      const key = def.key || def.type;
      const m = resolveModel(def.type, prefabs, lower);
      const i = resolveIcon(def, icons);
      let textures = [], materials = [];
      if (m.model) {
        try { ({ textures, materials } = texturesOf(`${m.model}.glb`, byHash)); }
        catch { /* reported as empty */ }
      }
      rows.push({ pack: pack.id, key, type: def.type, ...m, ...i, textures, materials });
    }
  }
  return rows;
}

function main() {
  const args = process.argv.slice(2);
  if (!existsSync(PREFABS)) {
    console.error(`No prefabs at ${PREFABS}. This tool needs the (gitignored) game assets.`);
    process.exit(1);
  }
  matchAll().then((rows) => {
    const only = args.includes('--pack') ? args[args.indexOf('--pack') + 1] : null;
    let list = only ? rows.filter((r) => r.pack === only) : rows;
    if (args.includes('--misses')) list = list.filter((r) => !r.model || !r.icon || !r.textures.length);
    if (args.includes('--json')) { console.log(JSON.stringify(list, null, 2)); return; }

    const cells = list.map((r) => [
      r.pack, r.key, r.model ?? '--', r.modelHow, r.icon ?? '--', r.iconHow,
      r.textures.join(' ') || '--',
    ]);
    const headers = ['pack', 'catalog key', 'prefab', 'via', 'icon', 'via', 'textures'];
    const w = headers.map((h, i) => Math.max(h.length, ...cells.map((c) => String(c[i]).length)));
    const line = (c) => c.map((v, i) => String(v).padEnd(w[i])).join('  ').trimEnd();
    console.log(line(headers));
    console.log(w.map((n) => '-'.repeat(n)).join('  '));
    for (const c of cells) console.log(line(c));

    const noModel = rows.filter((r) => !r.model).length;
    const noIcon = rows.filter((r) => !r.icon).length;
    const noTex = rows.filter((r) => r.model && !r.textures.length).length;
    console.log();
    console.log(`${rows.length} entries: ${rows.length - noModel} with a prefab, ` +
      `${rows.length - noIcon} with an icon, ${rows.length - noTex - noModel} with textures.`);
    if (noModel || noIcon) console.log(`unmatched: ${noModel} prefab, ${noIcon} icon — run with --misses`);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
