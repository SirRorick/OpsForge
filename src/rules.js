// ---------------------------------------------------------------------------
// Game mode rule sets
// ---------------------------------------------------------------------------
// A map carries one rule set per mode. Each holds four dictionaries — ints,
// bools, enums and flags — and the game writes **only the settings that were
// changed**. An empty dictionary therefore does not mean "off", it means
// "every setting is at whatever the game defaults to". The editor keeps that
// property: a key appears in the exported file only once you touch it, and
// clearing a field removes the key again rather than writing a zero.
//
// What is known and what is not
//   Known: which keys each mode accepts, and each key's dictionary, because a
//   reference map was exported with every setting changed away from its
//   default so all of them would appear.
//   Not known: the defaults themselves, the slider ranges, and the full option
//   list for each enum — one export can only show the values it happens to
//   use. So numbers are entered freely and are not clamped, and enum and flag
//   options are suggestions rather than a closed list. Anything typed in is
//   written through verbatim.
//
// This module must stay free of three.js imports so the tests can run headless.
// ---------------------------------------------------------------------------

export const INT = 'int';
export const BOOL = 'bool';
export const ENUM = 'enum';
export const FLAGS = 'flags';

/** Which of the four dictionaries a kind lives in. */
export const DICT_FOR_KIND = {
  [INT]: 'intValues',
  [BOOL]: 'boolValues',
  [ENUM]: 'enumValues',
  [FLAGS]: 'flagsValues',
};

// Values observed in the reference export. Offered as suggestions in the UI;
// the field stays editable because this is certainly not the whole list.
const OPTIONS = {
  Permadeath: ['Everyone'],
  TeamPermadeath: ['Everyone'],
  LifeMode: ['Permadeath'],
  BotDifficulty: ['Hard'],
  WeaponSource: ['Spawners', 'Holsters'],
};

/**
 * Key definitions, in the order the game wrote them. `label` is what the
 * editor shows; `unit` is a hint next to the field, not a conversion.
 */
const KEYS = {
  GameDuration:               { kind: INT, label: 'Game duration', unit: 's' },
  PlayerRespawnTime:          { kind: INT, label: 'Player respawn time', unit: 's' },
  RespawnInvulnerabilityTime: { kind: INT, label: 'Respawn invulnerability', unit: 's' },
  BarrierPenaltyTime:         { kind: INT, label: 'Barrier penalty time', unit: 's' },
  ScoreObjective:             { kind: INT, label: 'Score to win' },
  FlagObjective:              { kind: INT, label: 'Flag captures to win' },
  DominationObjective:        { kind: INT, label: 'Domination score to win' },
  DamageModifier:             { kind: INT, label: 'Damage modifier', unit: '%' },
  DamageBoxDamageModifier:    { kind: INT, label: 'Damage box modifier', unit: '%' },

  SilentBotSpawning:          { kind: BOOL, label: 'Silent bot spawning' },
  FriendlyFire:               { kind: BOOL, label: 'Friendly fire' },
  ShowHelmet:                 { kind: BOOL, label: 'Show helmet' },
  HideMapOnLobby:             { kind: BOOL, label: 'Hide map in lobby' },
  RequirePlayersInSpawnZone:  { kind: BOOL, label: 'Require players in spawn zone' },
  ShowSpawnZoneArrowInLobby:  { kind: BOOL, label: 'Show spawn zone arrow in lobby' },
  ShowDistanceToObjective:    { kind: BOOL, label: 'Show distance to objective' },
  SingleWeaponPerSpawner:     { kind: BOOL, label: 'Single weapon per spawner' },
  EnableAllowedWeapons:       { kind: BOOL, label: 'Enable allowed weapons' },

  Permadeath:                 { kind: ENUM, label: 'Permadeath' },
  TeamPermadeath:             { kind: ENUM, label: 'Team permadeath' },
  LifeMode:                   { kind: ENUM, label: 'Life mode' },
  BotDifficulty:              { kind: ENUM, label: 'Bot difficulty' },

  WeaponSource:               { kind: FLAGS, label: 'Weapon sources' },
};

// Per-mode key lists, transcribed from the reference export. A key the game
// does not accept for a mode is simply absent there.
const COMMON_INTS = ['GameDuration', 'PlayerRespawnTime', 'RespawnInvulnerabilityTime', 'BarrierPenaltyTime'];
const DAMAGE_INTS = ['DamageModifier', 'DamageBoxDamageModifier'];
const COMMON_BOOLS = ['SilentBotSpawning', 'FriendlyFire', 'ShowHelmet', 'HideMapOnLobby'];
const SPAWN_BOOLS = ['RequirePlayersInSpawnZone', 'ShowSpawnZoneArrowInLobby'];
const WEAPON_BOOLS = ['SingleWeaponPerSpawner', 'EnableAllowedWeapons'];

export const MODES = [
  {
    type: 'FreeForAll',
    name: 'Free For All',
    keys: [
      ...COMMON_INTS, 'ScoreObjective', ...DAMAGE_INTS,
      ...COMMON_BOOLS, ...WEAPON_BOOLS,
      'Permadeath', 'BotDifficulty', 'WeaponSource',
    ],
  },
  {
    type: 'Survival',
    name: 'Co-op Survival',
    keys: [
      ...COMMON_INTS, ...DAMAGE_INTS,
      ...COMMON_BOOLS, ...WEAPON_BOOLS,
      'BotDifficulty', 'LifeMode', 'WeaponSource',
    ],
  },
  {
    type: 'TeamDeathMatch',
    name: 'Team Deathmatch',
    keys: [
      ...COMMON_INTS, 'ScoreObjective', ...DAMAGE_INTS,
      ...COMMON_BOOLS, ...SPAWN_BOOLS, ...WEAPON_BOOLS,
      'TeamPermadeath', 'BotDifficulty', 'WeaponSource',
    ],
  },
  {
    type: 'CaptureTheFlag',
    name: 'Capture The Flag',
    keys: [
      ...COMMON_INTS, 'FlagObjective', ...DAMAGE_INTS,
      ...COMMON_BOOLS, ...SPAWN_BOOLS, 'ShowDistanceToObjective', ...WEAPON_BOOLS,
      'TeamPermadeath', 'BotDifficulty', 'WeaponSource',
    ],
  },
  {
    type: 'Domination',
    name: 'Domination',
    keys: [
      ...COMMON_INTS, 'DominationObjective', ...DAMAGE_INTS,
      ...COMMON_BOOLS, ...SPAWN_BOOLS, 'ShowDistanceToObjective', ...WEAPON_BOOLS,
      'TeamPermadeath', 'BotDifficulty', 'WeaponSource',
    ],
  },
];

export function modeByType(type) {
  return MODES.find((m) => m.type === type) || null;
}

/** Everything the editor needs to draw one field. */
export function fieldsFor(type) {
  const mode = modeByType(type);
  if (!mode) return [];
  return mode.keys.map((key) => ({
    key,
    ...KEYS[key],
    dict: DICT_FOR_KIND[KEYS[key].kind],
    options: OPTIONS[key] || null,
  }));
}

/** The rule set list a brand new map starts with: five modes, all default. */
export function defaultRuleSets() {
  return MODES.map((m) => ({
    name: m.name,
    type: m.type,
    intValues: {},
    boolValues: {},
    enumValues: {},
    flagsValues: {},
  }));
}

/**
 * Keys present in a rule set that this module does not know about — a setting
 * added by a game update, or a mode we have no reference for. The editor lists
 * them read-only rather than dropping them, so a round trip stays lossless.
 */
export function unknownKeys(ruleSet) {
  const known = new Set(modeByType(ruleSet.type)?.keys || []);
  const out = [];
  for (const [kind, dict] of Object.entries(DICT_FOR_KIND)) {
    for (const key of Object.keys(ruleSet[dict] || {})) {
      if (!known.has(key)) out.push({ key, kind, dict, value: ruleSet[dict][key] });
    }
  }
  return out;
}

/**
 * Set or clear one setting. `undefined` (an emptied field) deletes the key so
 * the game falls back to its own default, which is the whole reason the
 * dictionaries are sparse.
 */
export function setValue(ruleSet, key, kind, value) {
  const dict = DICT_FOR_KIND[kind];
  if (!dict) throw new Error(`Unknown rule value kind: ${kind}`);
  if (value === undefined || value === null || value === '') delete ruleSet[dict][key];
  else ruleSet[dict][key] = value;
  return ruleSet;
}

/** Flags are a semicolon-joined set, as in "Spawners;Holsters". */
export function parseFlags(value) {
  return String(value || '').split(';').map((s) => s.trim()).filter(Boolean);
}

export function joinFlags(list) {
  return [...new Set(list.filter(Boolean))].join(';');
}

/** How many settings a rule set overrides, for the panel's summary line. */
export function overrideCount(ruleSet) {
  return Object.values(DICT_FOR_KIND).reduce(
    (n, dict) => n + Object.keys(ruleSet[dict] || {}).length,
    0
  );
}
