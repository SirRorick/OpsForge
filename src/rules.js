// ---------------------------------------------------------------------------
// Game mode rule sets
// ---------------------------------------------------------------------------
// A map carries a list of rule sets. Each has a free-text name, a base mode
// picked from five, and four dictionaries — ints, bools, enums and flags. The
// game writes **only the settings that were changed**. An empty dictionary
// therefore does not mean "off", it means "every setting is at whatever the
// game defaults to". The editor keeps that property: a key appears in the
// exported file only once you touch it, and clearing a field removes the key
// again rather than writing a zero.
//
// Three sources feed this file, and they are not equally strong.
//
//   1. `reference/rules/spatial-ops-rules-spec.md` — a writeup of the in-game
//      rules screen: every field, its control, its default, its range, and the
//      conditions that nest one rule under another. This is where every
//      `fallback`, `min`, `max` and option list below comes from. Nothing else
//      to hand records a single default.
//   2. The reference map exports — the only evidence of what the game actually
//      *writes*. They confirm 23 of the 46 serialised key names, which
//      dictionary each lives in, and that flags are semicolon-joined and
//      spelled out in full rather than collapsed to "All".
//   3. `reference/GameAssets/Definitions/*Rule.asset` — one asset per rule.
//      Their MonoBehaviours are stripped to their names, so they carry no
//      values, but the names and the `m_Script` guids are intact. The guid
//      groups the rules by class, which settles which dictionary each of the
//      other 23 keys belongs in, and the name gives the key itself: for all 23
//      keys a map file confirms, the key is exactly the asset name with the
//      `Rule` suffix removed.
//
// Keys carry `confirmed: true` when a reference export contains them. The rest
// are the asset-name derivation above — a strong pattern, 23 for 23, but still
// a derivation, and `confirmed` is what the UI leans on to say so.
//
// What is still unknown: the literal an enum writes for a value no export used
// (`Off`, `BlueTeam`, `Individual` …), and whether a flags field emptied to
// nothing writes `"None"` or `""`. Both are noted where they occur.
//
// This module must stay free of three.js imports so it can run outside a
// browser, and free of `packs.js` too — it is built before it (see ORDER in
// build.mjs), which is why the weapon ids below are spelled out rather than
// imported. They are the same ids `specificWeapon` uses, in the rules screen's
// order rather than the library's, so the two lists have to be kept in step by
// hand.
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

/**
 * The two pseudo-members every flags dropdown offers. Neither is ever written:
 * `All` is how the in-game control *displays* a full selection, and the one
 * export that selected two of two wrote `"Spawners;Holsters"` rather than
 * `"All"`, so a full set is always spelled out. `None` is the other end, and is
 * the one value here that is a guess — see `joinFlags`.
 */
export const FLAG_ALL = 'All';
export const FLAG_NONE = 'None';

/**
 * Weapon ids, in the order the rules screen lists them (which is not the order
 * the library lists them in). Confirmed: every one of these appears as a
 * `specificWeapon` value in a reference export.
 */
const WEAPON_IDS = [
  'Handgun', 'SMG', 'Shotgun', 'Sniper', 'Grenade',
  'Healthpack', 'RiotShield', 'RPG', 'Flashbang',
];

/** Which weapons each holster position accepts. From the spec, section 7. */
const BACK_HOLSTER = ['SMG', 'Shotgun', 'Sniper', 'RiotShield', 'RPG'];
const CHEST_HOLSTER = ['Handgun', 'Grenade', 'Healthpack', 'Flashbang'];
const WAIST_HOLSTER = ['Handgun', 'Shotgun', 'Grenade', 'Healthpack', 'Flashbang'];

/**
 * How an option reads in the editor, where the game's own id is not what the
 * rules screen calls it. Everything absent from here shows as its id.
 */
const OPTION_LABELS = {
  Handgun: 'Revolver',
  SMG: 'Tommy Gun',
  Sniper: 'Sniper Rifle',
  Healthpack: 'Health Kit',
  RiotShield: 'Riot Shield',
  BlueTeam: 'Blue Team',
  OrangeTeam: 'Orange Team',
  UnlimitedLives: 'Unlimited Lives',
};

export function optionLabel(value) {
  return OPTION_LABELS[value] ?? value;
}

// ---------------------------------------------------------------------------
// The keys
// ---------------------------------------------------------------------------
/**
 * Every setting the rules screen offers.
 *
 * `fallback` is the game's own value for a setting nobody has touched. It is
 * **display only and is never written to a file** — the whole point of the
 * sparse dictionaries is that an untouched setting stays absent, so the editor
 * shows the fallback greyed out in the control and writes nothing. It is called
 * `fallback` rather than `default` so that no future refactor mistakes it for
 * "the value to write when none is set".
 *
 * `min` and `max` are the in-game stepper's limits. They bound what the editor
 * will *write*, and are deliberately not applied to what it reads: the
 * `Rules Examples` export carries `DominationObjective: 101` against a stated
 * ceiling of 100, and clamping on load would rewrite a file the game itself
 * produced. A loaded value outside its range is shown as such and left alone.
 *
 * `when` hides a row unless another setting has a particular value. It reads
 * *effective* values, so a child row appears under a parent still sitting at
 * its untouched default.
 */
const KEYS = {
  // --- Game ---------------------------------------------------------------
  // Seconds, one integer, entered through separate minute and second steppers.
  // 10000 minutes and 59 seconds is the largest the two steppers can express.
  GameDuration: {
    kind: INT, label: 'Game duration', confirmed: true, duration: true,
    fallback: 300, min: 10, max: 10000 * 60 + 59, unit: 's',
  },
  PlayerRespawnTime: {
    kind: INT, label: 'Player respawn time', confirmed: true,
    fallback: 3, min: 0, max: 10000, unit: 's',
  },
  RespawnInvulnerabilityTime: {
    kind: INT, label: 'Respawn invulnerability', confirmed: true,
    fallback: 3, min: 0, max: 10000, unit: 's',
  },
  // Only `Everyone` is confirmed — it is what the all-changed export wrote.
  // `Off` is the default and so never appears in a file; the literal is a
  // guess, and the only one that matters, since picking it writes it.
  Permadeath: {
    kind: ENUM, label: 'FFA permadeath', confirmed: true,
    fallback: 'Off', options: ['Off', 'Everyone'],
  },
  TeamPermadeath: {
    kind: ENUM, label: 'Team permadeath', confirmed: true,
    fallback: 'Off', options: ['Off', 'BlueTeam', 'OrangeTeam', 'Everyone'],
  },
  SilentBotSpawning: { kind: BOOL, label: 'Silent bot spawning', confirmed: true, fallback: false },
  FriendlyFire: { kind: BOOL, label: 'Friendly fire', confirmed: true, fallback: false },
  // Derived from ShowVestRule.asset, which shares SilentBotSpawningRule's
  // class. The one bool that defaults on, along with OneHandShootAllowed.
  ShowVest: { kind: BOOL, label: 'Show vest', fallback: true },
  ShowHelmet: { kind: BOOL, label: 'Show helmet', confirmed: true, fallback: false },
  HideMapOnLobby: { kind: BOOL, label: 'Hide map in lobby', confirmed: true, fallback: false },
  RequirePlayersInSpawnZone: {
    kind: BOOL, label: 'Require players in spawn zones at start', confirmed: true, fallback: false,
  },
  ShowSpawnZoneArrowInLobby: {
    kind: BOOL, label: 'Show arrow to spawn zone in lobby', confirmed: true, fallback: false,
  },
  BotDifficulty: {
    kind: ENUM, label: 'Bot difficulty', confirmed: true,
    fallback: 'Normal', options: ['Easy', 'Normal', 'Hard'],
  },
  // The rules screen calls this "Penalty Time"; the file calls it
  // BarrierPenaltyTime. Note the ceiling of 100, not the usual 10000.
  BarrierPenaltyTime: {
    kind: INT, label: 'Penalty time', confirmed: true,
    fallback: 5, min: 0, max: 100, unit: 's',
  },

  // --- Objectives ---------------------------------------------------------
  ScoreObjective: {
    kind: INT, label: 'Score objective', confirmed: true, fallback: 1500, min: 0, max: 10000,
  },
  // 101 in the reference export, against a ceiling of 100. See `min`/`max` above.
  DominationObjective: {
    kind: INT, label: 'Domination objective', confirmed: true, fallback: 100, min: 1, max: 100,
  },
  FlagObjective: {
    kind: INT, label: 'Flags objective', confirmed: true, fallback: 10, min: 1, max: 10000,
  },
  ShowDistanceToObjective: {
    kind: BOOL, label: 'Show distance to objective', confirmed: true, fallback: false,
  },
  // Only `Permadeath` is confirmed. The other three literals are guesses in the
  // same way `Off` is above.
  LifeMode: {
    kind: ENUM, label: 'Life mode', confirmed: true,
    fallback: 'Individual', options: ['Individual', 'Team', 'Permadeath', 'UnlimitedLives'],
  },
  IndividualMaxLivesSurvival: {
    kind: INT, label: 'Individual player lives', fallback: 2, min: 1, max: 20,
    when: (rs) => effectiveValue(rs, 'LifeMode') === 'Individual',
  },
  MaxLivesSurvival: {
    kind: INT, label: 'Shared team lives', fallback: 5, min: 1, max: 100,
    when: (rs) => effectiveValue(rs, 'LifeMode') === 'Team',
  },

  // --- Weapon -------------------------------------------------------------
  DamageModifier: {
    kind: INT, label: 'Damage modifier', confirmed: true, fallback: 100, min: 1, max: 10000, unit: '%',
  },
  DamageBoxDamageModifier: {
    kind: INT, label: 'Damage box modifier', confirmed: true, fallback: 100, min: 1, max: 10000, unit: '%',
  },
  // The only flags field a reference export contains, and the one that decides
  // whether the last two sections render at all. It cannot be emptied.
  WeaponSource: {
    kind: FLAGS, label: 'Weapon source', confirmed: true,
    fallback: 'Spawners', options: ['Spawners', 'Holsters'], required: true,
  },
  EnableWeaponRespawnTimePerWeaponType: {
    kind: BOOL, label: 'Weapon respawn time per type', fallback: false,
  },
  // One global field, or nine per-weapon ones — never both. Note the floors
  // differ: 1 on the global field, 0 on each per-type field.
  WeaponRespawnTime: {
    kind: INT, label: 'Weapon respawn time', fallback: 5, min: 1, max: 10000, unit: 's',
    when: (rs) => !effectiveValue(rs, 'EnableWeaponRespawnTimePerWeaponType'),
  },
  ...perWeaponRespawnKeys(),
  // Present in both states, always last of the block.
  WeaponDespawnTime: {
    kind: INT, label: 'Weapon despawn time', fallback: 5, min: 1, max: 10000, unit: 's',
  },
  OneHandShootAllowed: { kind: BOOL, label: 'One-handed firing allowed', fallback: true },

  // --- Weapon spawners ----------------------------------------------------
  SingleWeaponPerSpawner: {
    kind: BOOL, label: 'Single weapon per spawner', confirmed: true, fallback: false,
  },
  EnableAllowedWeapons: {
    kind: BOOL, label: 'Enable allowed weapons', confirmed: true, fallback: false,
  },
  AllowedWeapons: {
    kind: FLAGS, label: 'Allowed weapons', fallback: FLAG_ALL, options: WEAPON_IDS,
    when: (rs) => effectiveValue(rs, 'EnableAllowedWeapons') === true,
  },

  // --- Holsters -----------------------------------------------------------
  // Six independent dropdowns; setting one to None does nothing to the others.
  HolsterWeaponsBackLeft: { kind: FLAGS, label: 'Back left holster', fallback: FLAG_ALL, options: BACK_HOLSTER },
  HolsterWeaponsBackRight: { kind: FLAGS, label: 'Back right holster', fallback: FLAG_ALL, options: BACK_HOLSTER },
  HolsterWeaponsChestLeft: { kind: FLAGS, label: 'Chest left holster', fallback: FLAG_ALL, options: CHEST_HOLSTER },
  HolsterWeaponsChestRight: { kind: FLAGS, label: 'Chest right holster', fallback: FLAG_ALL, options: CHEST_HOLSTER },
  HolsterWeaponsWaistLeft: { kind: FLAGS, label: 'Waist left holster', fallback: FLAG_ALL, options: WAIST_HOLSTER },
  HolsterWeaponsWaistRight: { kind: FLAGS, label: 'Waist right holster', fallback: FLAG_ALL, options: WAIST_HOLSTER },
};

/**
 * The nine per-weapon respawn times, which differ only in which weapon they
 * name. Their key spelling comes from the asset names, and `Riotshield` really
 * is spelled with a small s there while the weapon id itself is `RiotShield` —
 * `WeaponRespawnTimeRiotshieldRule` against `"specificWeapon":"RiotShield"`.
 * Do not tidy that; the two are different strings in the game.
 */
function perWeaponRespawnKeys() {
  const suffix = { RiotShield: 'Riotshield' };
  const out = {};
  for (const w of WEAPON_IDS) {
    out[`WeaponRespawnTime${suffix[w] ?? w}`] = {
      kind: INT, label: `${optionLabel(w)} respawn time`, fallback: 5, min: 0, max: 10000, unit: 's',
      when: (rs) => effectiveValue(rs, 'EnableWeaponRespawnTimePerWeaponType') === true,
    };
  }
  return out;
}

/** Every per-weapon respawn key, in screen order. */
const PER_WEAPON_RESPAWN = Object.keys(perWeaponRespawnKeys());

// ---------------------------------------------------------------------------
// Sections and modes
// ---------------------------------------------------------------------------
// The rules screen renders five sections top to bottom, the last two only when
// Weapon Source asks for them.

export const SECTIONS = [
  { id: 'game', name: 'Game' },
  { id: 'objectives', name: 'Objectives' },
  { id: 'weapon', name: 'Weapon' },
  {
    id: 'spawners', name: 'Weapon spawners',
    when: (rs) => flagsOf(rs, 'WeaponSource').includes('Spawners'),
  },
  {
    id: 'holsters', name: 'Holsters',
    when: (rs) => flagsOf(rs, 'WeaponSource').includes('Holsters'),
  },
];

// Three sections are the same in all five modes.
const WEAPON_KEYS = [
  'DamageModifier', 'DamageBoxDamageModifier', 'WeaponSource',
  'EnableWeaponRespawnTimePerWeaponType', 'WeaponRespawnTime', ...PER_WEAPON_RESPAWN,
  'WeaponDespawnTime', 'OneHandShootAllowed',
];
const SPAWNER_KEYS = ['SingleWeaponPerSpawner', 'EnableAllowedWeapons', 'AllowedWeapons'];
const HOLSTER_KEYS = [
  'HolsterWeaponsBackLeft', 'HolsterWeaponsBackRight',
  'HolsterWeaponsChestLeft', 'HolsterWeaponsChestRight',
  'HolsterWeaponsWaistLeft', 'HolsterWeaponsWaistRight',
];

// The Game section differs only in its permadeath row and the two spawn-zone
// toggles, so it is assembled rather than written out five times.
const gameKeys = ({ permadeath = null, spawnZones = false } = {}) => [
  'GameDuration', 'PlayerRespawnTime', 'RespawnInvulnerabilityTime',
  ...(permadeath ? [permadeath] : []),
  'SilentBotSpawning', 'FriendlyFire', 'ShowVest', 'ShowHelmet', 'HideMapOnLobby',
  ...(spawnZones ? ['RequirePlayersInSpawnZone', 'ShowSpawnZoneArrowInLobby'] : []),
  'BotDifficulty', 'BarrierPenaltyTime',
];

/**
 * A mode may carry `fallbacks`, overriding the value in KEYS for that mode
 * alone. Nothing uses it today, but the game keeps a second duration rule for
 * Survival — `GameSurvivalDurationRule.asset` is a separate instance of
 * `GameDurationRule`'s class — and the all-changed export wrote 240 there
 * against 360 everywhere else while nudging every other number by exactly one
 * step. Both point at Survival defaulting to 3m rather than 5m. The spec says
 * 5m for every mode and the spec is what this file follows, so if the rules
 * screen ever confirms it, `fallbacks: { GameDuration: 180 }` on Survival is
 * the whole change. Same display-only rule as a KEYS entry: never written.
 */
export const MODES = [
  {
    type: 'FreeForAll',
    name: 'Free For All',
    sections: {
      game: gameKeys({ permadeath: 'Permadeath' }),
      objectives: ['ScoreObjective'],
      weapon: WEAPON_KEYS, spawners: SPAWNER_KEYS, holsters: HOLSTER_KEYS,
    },
  },
  {
    type: 'Survival',
    name: 'Co-op Survival',
    sections: {
      game: gameKeys(),
      objectives: ['LifeMode', 'IndividualMaxLivesSurvival', 'MaxLivesSurvival'],
      weapon: WEAPON_KEYS, spawners: SPAWNER_KEYS, holsters: HOLSTER_KEYS,
    },
  },
  {
    type: 'TeamDeathMatch',
    name: 'Team Deathmatch',
    sections: {
      game: gameKeys({ permadeath: 'TeamPermadeath', spawnZones: true }),
      objectives: ['ScoreObjective'],
      weapon: WEAPON_KEYS, spawners: SPAWNER_KEYS, holsters: HOLSTER_KEYS,
    },
  },
  {
    type: 'CaptureTheFlag',
    name: 'Capture The Flag',
    sections: {
      game: gameKeys({ permadeath: 'TeamPermadeath', spawnZones: true }),
      objectives: ['FlagObjective', 'ShowDistanceToObjective'],
      weapon: WEAPON_KEYS, spawners: SPAWNER_KEYS, holsters: HOLSTER_KEYS,
    },
  },
  {
    type: 'Domination',
    name: 'Domination',
    sections: {
      game: gameKeys({ permadeath: 'TeamPermadeath', spawnZones: true }),
      objectives: ['DominationObjective', 'ShowDistanceToObjective'],
      weapon: WEAPON_KEYS, spawners: SPAWNER_KEYS, holsters: HOLSTER_KEYS,
    },
  },
];

export function modeByType(type) {
  return MODES.find((m) => m.type === type) || null;
}

/** The keys a mode accepts, in screen order. */
export function keysFor(type) {
  const mode = modeByType(type);
  if (!mode) return [];
  return SECTIONS.flatMap((s) => mode.sections[s.id] || []);
}

/** Everything the editor needs to draw one field, in screen order. */
export function fieldsFor(type) {
  const mode = modeByType(type);
  if (!mode) return [];
  return SECTIONS.flatMap((s) =>
    (mode.sections[s.id] || []).map((key) => describeField(mode, key, s.id))
  );
}

function describeField(mode, key, section) {
  const field = { key, section, ...KEYS[key], dict: DICT_FOR_KIND[KEYS[key].kind] };
  field.confirmed = KEYS[key].confirmed === true;
  // A mode's own fallback beats the shared one, and only where it has one.
  if (mode.fallbacks && key in mode.fallbacks) field.fallback = mode.fallbacks[key];
  return field;
}

/**
 * The mode's sections with their fields, for one particular rule set: sections
 * and rows whose `when` says they do not apply are marked rather than dropped.
 *
 * Dropping them would lose data. A per-weapon respawn time the user set before
 * turning the parent toggle back off is still in the file and still exported,
 * so hiding the row would leave a value in the map with nothing in the editor
 * that could see or clear it. `active: false` lets the panel show those rows
 * dimmed and say they are not in effect, and skip the rest entirely.
 */
export function layoutFor(ruleSet) {
  const mode = modeByType(ruleSet.type);
  if (!mode) return [];
  return SECTIONS.map((s) => {
    const active = s.when ? !!s.when(ruleSet) : true;
    const fields = (mode.sections[s.id] || []).map((key) => {
      const f = describeField(mode, key, s.id);
      f.active = active && (f.when ? !!f.when(ruleSet) : true);
      f.set = ruleSet[f.dict]?.[key] !== undefined;
      return f;
    });
    return { id: s.id, name: s.name, active, fields };
  }).filter((s) => s.active || s.fields.some((f) => f.set));
}

// ---------------------------------------------------------------------------
// Reading values
// ---------------------------------------------------------------------------

/**
 * What this rule set will actually play at for one setting: the value it has
 * set, or the game's own default if it has none. This is what conditions read,
 * so a child row shows up under a parent still sitting at its default.
 */
export function effectiveValue(ruleSet, key) {
  const f = KEYS[key];
  if (!f) return undefined;
  const v = ruleSet?.[DICT_FOR_KIND[f.kind]]?.[key];
  return v === undefined ? f.fallback : v;
}

/** The effective value of a flags key, expanded to a plain list of members. */
export function flagsOf(ruleSet, key) {
  return parseFlags(effectiveValue(ruleSet, key), KEYS[key]?.options);
}

/** How a fallback reads in the editor, for the tag beside each control. */
export function describeFallback(field) {
  if (field.fallback === undefined) return null;
  if (field.kind === BOOL) return field.fallback ? 'on' : 'off';
  if (field.kind === FLAGS) {
    if (field.fallback === FLAG_ALL) return 'all';
    const list = parseFlags(field.fallback, field.options);
    return list.map(optionLabel).join(' + ') || 'none';
  }
  if (field.duration) return formatDuration(field.fallback);
  return `${field.fallback}${field.unit ?? ''}`;
}

/** Whether a value sits outside the stepper's range. Never enforced on load. */
export function outOfRange(field, value) {
  if (field.kind !== INT || typeof value !== 'number') return false;
  return value < field.min || value > field.max;
}

// ---------------------------------------------------------------------------
// Game duration
// ---------------------------------------------------------------------------
// One integer of seconds in the file, two steppers on the screen. The seconds
// stepper stops at 59 and does not roll over into minutes, so 90 seconds is
// entered as 1m 30s, and the ten-second floor applies to the total rather than
// to either field.

export const DURATION_LIMITS = { maxMinutes: 10000, maxSeconds: 59, minTotal: 10 };

export function splitDuration(total) {
  const t = Math.max(0, Math.round(total || 0));
  return { minutes: Math.floor(t / 60), seconds: t % 60 };
}

export function joinDuration(minutes, seconds) {
  const m = clampNumber(minutes, 0, DURATION_LIMITS.maxMinutes);
  const s = clampNumber(seconds, 0, DURATION_LIMITS.maxSeconds);
  return Math.max(DURATION_LIMITS.minTotal, m * 60 + s);
}

export function formatDuration(total) {
  const { minutes, seconds } = splitDuration(total);
  return `${minutes}m ${seconds}s`;
}

// ---------------------------------------------------------------------------
// Writing values
// ---------------------------------------------------------------------------

/**
 * The five modes, all default, exactly as the game writes them from an
 * untouched rules screen.
 *
 * This is evidence about the format, not the editor's starting point: a map
 * made here starts with no rule sets and gains one per mode as its objectives
 * are placed. See `newMap` in format.js.
 */
export function defaultRuleSets() {
  return MODES.map((m) => emptyRuleSet(m.type, m.name));
}

function emptyRuleSet(type, name) {
  return { name, type, intValues: {}, boolValues: {}, enumValues: {}, flagsValues: {} };
}

/**
 * A new rule set for a mode. Names need not be unique — the game's own list
 * allows two Domination sets that differ only by name — but starting two of
 * them identically named is unhelpful, so a repeat gets a number.
 *
 * There is no id field: the map file has none, and adding one would put a key
 * in the export that the game never wrote. A rule set is identified by its
 * position in the list, which is why order is preserved on save.
 */
export function newRuleSet(type, existing = []) {
  const mode = modeByType(type);
  return emptyRuleSet(type, uniqueName(mode ? mode.name : type, existing));
}

export function duplicateRuleSet(ruleSet, existing = []) {
  return {
    name: uniqueName(ruleSet.name, existing),
    type: ruleSet.type,
    intValues: { ...ruleSet.intValues },
    boolValues: { ...ruleSet.boolValues },
    enumValues: { ...ruleSet.enumValues },
    flagsValues: { ...ruleSet.flagsValues },
  };
}

/**
 * A free name near the one asked for. A trailing number is treated as the
 * counter it usually is, so duplicating "Domination 2" gives "Domination 3"
 * rather than "Domination 2 2".
 */
function uniqueName(base, existing) {
  const taken = new Set(existing.map((r) => r.name));
  if (!taken.has(base)) return base;
  const stem = base.replace(/\s+\d+$/, '');
  for (let n = 2; ; n++) if (!taken.has(`${stem} ${n}`)) return `${stem} ${n}`;
}

/** Back to every setting at the game's default, which is four empty dictionaries. */
export function resetRuleSet(ruleSet) {
  for (const dict of Object.values(DICT_FOR_KIND)) ruleSet[dict] = {};
  return ruleSet;
}

/**
 * Swap a rule set's base mode. Settings both modes share keep their values;
 * settings only the old mode had are dropped, since the new mode would neither
 * show nor use them.
 *
 * Keys neither mode declares are left alone rather than dropped — those are a
 * future game update's, not ours to throw away.
 */
export function changeBaseMode(ruleSet, type) {
  const before = new Set(keysFor(ruleSet.type));
  const after = new Set(keysFor(type));
  for (const dict of Object.values(DICT_FOR_KIND)) {
    for (const key of Object.keys(ruleSet[dict] || {})) {
      if (before.has(key) && !after.has(key)) delete ruleSet[dict][key];
    }
  }
  ruleSet.type = type;
  return ruleSet;
}

/**
 * Keys present in a rule set that this module does not know about — a setting
 * added by a game update, or a mode we have no reference for. The editor lists
 * them read-only rather than dropping them, so a round trip stays lossless.
 */
export function unknownKeys(ruleSet) {
  const known = new Set(keysFor(ruleSet.type));
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

/** Round and clamp a typed number to the stepper's range before writing it. */
export function clampInt(field, value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return undefined;
  return clampNumber(n, field.min ?? -Infinity, field.max ?? Infinity);
}

function clampNumber(n, lo, hi) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return lo === -Infinity ? 0 : lo;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Flags are a semicolon-joined set, as in "Spawners;Holsters". `options` is
 * optional and only matters for expanding the display-only `All`.
 */
export function parseFlags(value, options = null) {
  const parts = String(value ?? '').split(';').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 1 && parts[0] === FLAG_NONE) return [];
  if (parts.length === 1 && parts[0] === FLAG_ALL) return options ? [...options] : [];
  return parts;
}

/**
 * The inverse. A full selection is spelled out rather than collapsed to `All`,
 * because that is what the game itself wrote for two of two: `Spawners;Holsters`.
 *
 * The empty selection is the one guess here. `None` is an option the rules
 * screen offers on the holsters and on Allowed Weapons, so it must serialise as
 * something; `"None"` is what a set of member names joined this way would write
 * for a zero value, and it is what this returns. If a holster set to None turns
 * out not to load in game, an empty string is the other candidate and this is
 * the one line to change.
 */
export function joinFlags(list, field = null) {
  let chosen = [...new Set(list.filter(Boolean))];
  if (field?.options) {
    const order = field.options;
    chosen = order.filter((o) => chosen.includes(o)).concat(chosen.filter((c) => !order.includes(c)));
  }
  if (chosen.length) return chosen.join(';');
  return field && !field.required ? FLAG_NONE : '';
}

/** How many settings a rule set overrides, for the panel's summary line. */
export function overrideCount(ruleSet) {
  return Object.values(DICT_FOR_KIND).reduce(
    (n, dict) => n + Object.keys(ruleSet[dict] || {}).length,
    0
  );
}

// ---------------------------------------------------------------------------
// Which modes a map can actually play
// ---------------------------------------------------------------------------
// A mode needs its objectives on the map before the game will let it be picked.
// The editor checks the same thing, but only warns: a map mid-build is allowed
// to hold a rule set whose objectives have not been placed yet, and deleting
// the set out from under the user because they moved a flag would be worse than
// saying so.

// The labels name the teams by colour, matching the library. `Team1` and
// `Team2` are what the file says and never change; blue and orange are what the
// game shows and what anyone building a map is actually looking at.
export const MODE_REQUIREMENTS = {
  FreeForAll: [],
  Survival: [{ label: 'an enemy spawner', types: ['EnemySpawnPoint'] }],
  TeamDeathMatch: [
    { label: 'a blue team spawn zone', types: ['PlayerSpawnZoneTeam1'] },
    { label: 'an orange team spawn zone', types: ['PlayerSpawnZoneTeam2'] },
  ],
  CaptureTheFlag: [
    { label: 'a blue team spawn zone', types: ['PlayerSpawnZoneTeam1'] },
    { label: 'an orange team spawn zone', types: ['PlayerSpawnZoneTeam2'] },
    { label: 'a blue team flag', types: ['CaptureFlagSpawnTeam1'] },
    { label: 'an orange team flag', types: ['CaptureFlagSpawnTeam2'] },
  ],
  Domination: [
    { label: 'a blue team spawn zone', types: ['PlayerSpawnZoneTeam1'] },
    { label: 'an orange team spawn zone', types: ['PlayerSpawnZoneTeam2'] },
    { label: 'a capture zone', types: ['DominationZoneA', 'DominationZoneB', 'DominationZoneC'] },
  ],
};

/**
 * What a mode still needs before the game would offer it. `present` is any set
 * of the object types on the map.
 */
export function missingRequirements(type, present) {
  const need = MODE_REQUIREMENTS[type];
  if (!need) return [];
  const have = present instanceof Set ? present : new Set(present || []);
  return need.filter((r) => !r.types.some((t) => have.has(t))).map((r) => r.label);
}

// ---------------------------------------------------------------------------
// The tags the library sorts a map by
// ---------------------------------------------------------------------------
// mod.io's "Map files" tag group is the game's mode list under another name,
// and the in-headset browser lists a map under the modes it is tagged for. A
// map published without them is in none of those lists — uploaded, visible on
// the website, and unreachable from a headset, which is exactly what an
// untagged upload looks like from the couch. The strings are mod.io's own and
// have to match character for character, or the submission is rejected whole.
//
// What the game tags is what it would let someone *pick*: a mode the map holds
// a rule set for, whose objectives are actually placed. Free For All needs
// neither — any map plays that way — and Survival, going by every tagged map
// in the library, rides on the rule set alone without its enemy spawner.
export const MODE_TAGS = {
  FreeForAll: 'Free For All',
  Survival: 'Survival',
  TeamDeathMatch: 'Team Death Match',
  CaptureTheFlag: 'Capture The Flag',
  Domination: 'Domination',
};

/** The mode tags a map earns. `present` is any set of its object types. */
export function modeTagsFor(ruleSets, present) {
  const types = new Set((ruleSets || []).map((r) => r.type));
  return Object.entries(MODE_TAGS)
    .filter(([type]) => type === 'FreeForAll' || types.has(type))
    .filter(([type]) => type === 'Survival' || !missingRequirements(type, present).length)
    .map(([, tag]) => tag);
}
