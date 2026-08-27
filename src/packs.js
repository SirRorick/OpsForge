// ---------------------------------------------------------------------------
// Built-in object packs
// ---------------------------------------------------------------------------
// Transcribed from map files exported out of the in-game editor, one file per
// group, so the library here matches the library there: Virtual Objects with a
// theme per pack, then Gameplay Objects and Mode Objectives.
//
// Fields
//   type          the "type" string written to the map file. This is the contract.
//   key           unique catalog id; equals `type` unless several library
//                 entries share one type and differ only by `props`
//   objectType    the "$type" discriminator, when it is not a plain MapObject
//   props         extra fields the subtype writes (specificWeapon, style, ...)
//   label         what the library shows
//   category      grouping inside the pack
//   shape         placeholder generator id (see placeholders.js)
//   size          [w, h, d] in metres of the base mesh at scale 1, 1, 1
//   pivot         'base' -> origin on the floor, 'center' -> origin in the middle
//   anchor        [x, z] fraction saying where the origin sits inside the
//                 footprint; [0.5, 0.5] (the default) means centred. The corner
//                 barriers are the reason it exists: their origin is in the
//                 corner where the two arms meet, 44 cm from the middle of the
//                 box, and scene.js only ever corrects a loaded prefab's Y — so
//                 without this the placeholder sits half a metre from where the
//                 game draws the same object. Measured, like `size`, by
//                 npm run trace-prefabs.
//   rotationAxes  'y' yaw only, 'xyz' free
//   shapeYaw      degrees this mesh is turned from the way the rest of its
//                 shape family is modelled. Only Graffiti's Big Crate carries
//                 one: it is Camo's Crate Big lying the other way round, so it
//                 is placed a quarter turn over and a swap between the two
//                 carries the difference, leaving the crate lying as it lay
//   floor         the piece is expected to rest on the ground
//   groundOnly    the piece may not leave the ground, and the editor holds it
//                 there. Only the enemy spawner, and it is not a tidiness rule:
//                 the game spawns its bots on the floor under the pad wherever
//                 the pad is put, so a spawner on a rooftop delivers enemies
//                 into whatever stands beneath it
//   color         placeholder tint. Normally set once on the **pack** and used
//                 by everything in it, which is what makes a theme read as a
//                 theme when the real art is absent. An entry may override it,
//                 and Gameplay Objects and Mode Objectives do: a red explosive
//                 barrel and a team-blue spawn zone carry meaning a pack colour
//                 would throw away. See registerPack in catalog.js.
//   defaultScale  scale a freshly placed object gets, read off the reference
//                 files: the player left every scale alone except the solid
//                 box, cylinder and wall, which are sized as you place them
//   icon          sliced sprite name, without extension; see tools/slice-icons.mjs
//   model         prefab basename in reference/GameAssets/Prefabs, without .glb
//   texture       base-colour map in reference/GameAssets/Textures
//   fixedParts    regex naming prefab nodes that keep their own size when the
//                 object is resized — a spawn zone's machine rides the corner
//                 of the area it stands on rather than stretching with it
//   keepParts     regex naming the only prefab nodes worth drawing; everything
//                 else in the file is dropped. The boundaries are the reason it
//                 exists: each ships the invisible visual the game draws *and*
//                 a wood-textured one for a spectator outside the room, and
//                 merging the two paints every invisible wall with wood grain
//   edges         draw the object's own silhouette as lines over the top. For
//                 something at a tenth opacity, the fill alone is not enough to
//                 say where the faces are
//   text          { prop, inset } — paint the object's `prop` across its front
//                 face as text, `inset` metres in from each edge. Same idea as
//                 `screen` and the same cause: the prefab is a Unity canvas and
//                 the prefab carries no mesh at all
//   area          { parts, height, opacity } — regex naming the prefab nodes
//                 that draw the *volume* an objective covers rather than any
//                 solid part of it, flattened to `height` metres on the floor
//                 and drawn at `opacity` so you can see what stands inside
//   figure        draw a model of what the object produces on top of it;
//                 "enemy" reads the ENEMIES table above
//   weapon        hang the weapon the spawner offers over it, at WEAPON_HOVER
//                 metres, from the WEAPON_MODELS table above. The `figure` of
//                 the weapon spawners, kept separate because what it reads is
//                 `specificWeapon` rather than `enemyTypes` and because the
//                 longest weapon wins rather than the first
//   field         the object is a volume the game fills with a crackling
//                 electric field rather than anything solid. Drawn as a
//                 near-transparent shell with arcs running over it — see
//                 fieldMaterial in scene.js
//   screen        { image, inset } — paint `image` across the front face,
//                 `inset` metres in from every edge, for a prefab whose display
//                 the game draws as a UI canvas and the prefab therefore
//                 leaves empty. `image` is staged by tools/stage-assets.mjs
//   cutout        the prefab's texture is mostly transparent and the export
//                 forgot to say so — a ground ring drawn on one flat quad
//   badge         short text floated above the object in the viewport
//   tintModel     multiply the prefab's own texture by `color`, for art that
//                 ships colourless and is tinted per team by a Unity shader
//   opacity       < 1 draws the object translucent, for volumes you need to
//                 see through — the damage boxes mark a region, not a solid
//   uncertain     `size` is an estimate, not a confirmed mesh dimension
//   hidden        loads and exports normally but is not offered in the library
//   facing        'x' or 'z' — the object reads differently along that local
//                 axis and is its own reflection across the other one, whatever
//                 its silhouette says. For the pieces whose front is painted on
//                 rather than built in: a jumbotron is a symmetric frame with a
//                 screen on one face, a message pane is a symmetric card with
//                 text on one face, and a weapon spawner is a symmetric crate
//                 with a gun lying across it. Mirroring asks the geometry which
//                 way round a piece is (see isMirrorSymmetric in scene.js), and
//                 the geometry answers "either way" for all three
//   team          which side the piece belongs to: 'Blue', 'Orange', or
//                 'Neutral' for the one that belongs to nobody
//   teamFamily    id shared by the entries that are the same piece in different
//                 team colours. Mirroring an arena's blue half into its orange
//                 half needs to swap the spawn zone with everything else, and a
//                 team is not a theme — the themed packs are a different axis
//                 entirely and hold none of these pieces
//
// `model`, `texture` and `icon` are resolved by tools/match-assets.mjs and are
// pointers into the gitignored game assets, so the editor still runs
// without them:
// nothing loads them yet and the procedural placeholder stands in. They are not
// derivable from the type string — the catalog is keyed by what the game writes
// and the art by whatever the artists called it, and the two agree about half
// the time. MYKEA is Indoor, Graffiti is StreetStyle, Hatchet Corp is HatCo,
// Camo is Military in the icons. Textures are not name-matched at all: a GLB
// embeds its images with no filename, so each is hashed and looked up against
// Textures/, which is an identity rather than a guess.
//
// Note these sit outside `props`. `props` is the set of extra fields the game
// itself writes for a subtype, and anything added to it lands in exported map
// files.
//
// Base mesh sizes marked `uncertain` are estimates. Map files only store scale
// multipliers, so real mesh dimensions cannot be recovered from them. The
// primitives are the exception: the same scales recur across all eleven themed
// packs at heights that put them exactly on the floor, which pins those meshes
// to one metre units.
//
// The Default pack no longer estimates anything: its sizes are measured off
// reference/GameAssets/Prefabs/*.glb by tools/measure-prefabs.mjs, quoted to
// the millimetre. Two rules govern which number lands here, because the mesh
// and the unit the game scales are not always the same thing.
//
// Where an object rests on the floor with a `center` pivot, the game's own
// placements settle it: every such object in the reference maps sits at
// y = scale.y / 2, so the unit being multiplied is exactly 1 m. Those keep 1,
// even though the meshes measure a little off it — the solid wall's frame
// stands proud at 1.069 x 1.019, and the cylinder's bevelled caps bring it in
// to 0.993. Only the wall's thickness, which no placement constrains, is the
// measured 0.125 rather than the 0.1 previously guessed.
//
// Everything else takes its measured bounding box, since a `base` pivot puts
// the object on the floor regardless of its height. The barriers turn out to
// be 2 m tall rather than the 1.4 m estimated here, and the crates 0.5 m
// rather than 0.6 m.
// ---------------------------------------------------------------------------

export const PACK_SCHEMA_VERSION = 2;

/** Top-level library sections, in the order the game shows them. */
export const PACK_GROUPS = [
  { id: 'virtual', name: 'Virtual Objects' },
  { id: 'gameplay', name: 'Gameplay Objects' },
  { id: 'objectives', name: 'Mode Objectives' },
];

// ---------------------------------------------------------------------------
// Weapon spawners
// ---------------------------------------------------------------------------
// One spawner, not ten. A WeaponSpawnPoint carries a `specificWeapon` prop
// saying what it may produce, and the game picks at random from what is listed
// — the `SingleWeaponPerSpawner` rule exists precisely because a spawner can
// hold more than one.
//
// **The multi-weapon encoding is inferred, not confirmed.** Every weapon
// spawner in every reference export names exactly one weapon, so nothing the
// game wrote shows two. It is inferred from the enemy spawner below, which is
// the nearest thing the format has: the same "set of things this spawner may
// produce" idea, on the same kind of object, and there it is confirmed to be a
// bare comma. The rule sets' own multi-valued strings use a semicolon
// (`"WeaponSource":"Spawners;Holsters"`) but those are a different serialiser
// with a different separator, which is exactly why one cannot settle the other.
// If a map with two weapons turns out not to load in game, LIST_SEPARATOR is
// the one line to change. Anything the editor did not touch is written back
// from its original bytes, so this can only affect spawners the user edits.

/** Selectable weapons, in the order the library shows them. */
export const WEAPONS = [
  'Handgun', 'SMG', 'Shotgun', 'Sniper', 'RPG',
  'Grenade', 'Flashbang', 'RiotShield', 'Healthpack',
];

/**
 * Sliced sprite per weapon. Not derivable: the assets spell the grenade
 * "granade" and calls the riot shield a shield.
 */
export const WEAPON_ICONS = {
  Handgun: 'Icon_handgun_silhouette',
  SMG: 'Icon_smg_silhouette',
  Shotgun: 'Icon_shotgun_silhouette',
  Sniper: 'Icon_sniper_silhouette',
  RPG: 'Icon_rpg_silhouette',
  Grenade: 'Icon_granade_silhouette',
  Flashbang: 'Icon_flashbang_silhouette',
  RiotShield: 'Icon_shield_silhouette',
  Healthpack: 'Icon_healthpack_silhouette',
};

/**
 * The weapon itself, hanging over the spawner, and how far it reaches.
 *
 * A weapon spawner is a crate less than half a metre across, and what actually
 * has to fit is the gun above it — an RPG is a metre long and lies *across* the
 * crate's long side, so a spawner set flush against a wall spawns a launcher
 * with its tube through the wall. Nothing about the crate says so, which is why
 * the gun is drawn.
 *
 * `model` is the weapon's own prefab, and `_weaponPart` in scene.js takes the
 * `Visuals` branch out of it — the weapon as a player picks it up, textures and
 * all.
 *
 * **Not the `<Weapon>Preview` prefab, which is the obvious candidate and the
 * wrong one.** That is the very thing the game floats over a spawner, so it was
 * used first; but every mesh in it wears a material called `MATWeaponSpawn`,
 * and that material is empty — no texture, no colour, not even a base colour
 * factor, because all it ever was is the Unity shader that dissolves a weapon
 * into being, and shaders do not survive an export. The guns came out white.
 *
 * The full prefab carries both: the textured weapon under `Visuals`, and that
 * same untextured copy under a `VFX…/SpawnModel` beside it. They occupy the
 * same space to the millimetre for six of the nine and within three centimetres
 * for the rest, so taking the textured one changes what the gun looks like and
 * not where it is.
 *
 * `reach` is the mesh's own extent along Z in metres, measured off the prefab,
 * and it is what picks which weapon to draw when a spawner offers several: the
 * longest one is the one whose clearance is in question.
 *
 * The names happen to match `WEAPONS` one for one — unlike the icons, which
 * spell the grenade "granade" — but they are written out rather than derived,
 * because a game update is free to rename a prefab without renaming a weapon.
 */
export const WEAPON_MODELS = {
  Handgun: { model: 'Handgun', reach: 0.245 },
  SMG: { model: 'SMG', reach: 0.796 },
  Shotgun: { model: 'Shotgun', reach: 0.506 },
  Sniper: { model: 'Sniper', reach: 0.967 },
  RPG: { model: 'RPG', reach: 1.058 },
  Grenade: { model: 'Grenade', reach: 0.116 },
  Flashbang: { model: 'Flashbang', reach: 0.138 },
  RiotShield: { model: 'RiotShield', reach: 0.215 },
  Healthpack: { model: 'Healthpack', reach: 0.122 },
};

/**
 * How high above its own base the spawner holds a weapon, in metres.
 *
 * The `Preview` node inside `WeaponSpawnPoint.glb` sits at exactly this height,
 * and so does the node called `WeaponSpawnPoint` beside it — the anchor the
 * real weapon is spawned on. Neither is rotated, which is the other half of the
 * story: the crate's own `Visual` is turned a quarter turn about Y and the
 * weapon is not, so the gun lies across the crate rather than along it.
 */
export const WEAPON_HOVER = 1.127;

/** The game's own shorthand for "any of them", and what it writes for it. */
export const WEAPON_ANY = 'All';

/**
 * What joins the several things one spawner may produce. Confirmed for
 * `enemyTypes` by a reference export listing twelve of them; see below.
 */
export const LIST_SEPARATOR = ',';

/**
 * `specificWeapon` -> the weapons it offers. Unrecognised names are kept rather
 * than dropped, so a weapon added by a future game update survives an edit to
 * the same spawner.
 */
export function parseWeapons(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw === WEAPON_ANY) return [...WEAPONS];
  return raw.split(LIST_SEPARATOR).map((s) => s.trim()).filter(Boolean);
}

/**
 * The inverse. Everything selected collapses back to `All` rather than being
 * spelled out, because that is what the game itself writes for a spawner with
 * no restriction, and it is the only multi-weapon value known to load.
 */
export function formatWeapons(list) {
  const chosen = [...new Set(list.filter(Boolean))];
  if (!chosen.length) return WEAPON_ANY;
  const coversAll = WEAPONS.every((w) => chosen.includes(w)) && chosen.length === WEAPONS.length;
  return coversAll ? WEAPON_ANY : chosen.join(LIST_SEPARATOR);
}

/**
 * Which of the weapons a spawner offers to draw over it.
 *
 * The one that reaches furthest, not the first in the list, and the difference
 * matters: a spawner left at `All` can produce an RPG, and drawing the handgun
 * that heads the list would say a spawner clears a wall it does not. The
 * enemy spawners pick the first of their list instead, because a bot is a bot
 * — nothing about which one spawns changes where it fits.
 *
 * Names this build has never heard of are skipped rather than guessed at, so a
 * weapon added by a game update draws nothing instead of the wrong thing.
 */
export function longestWeapon(list) {
  let best = null;
  for (const w of list) {
    const entry = WEAPON_MODELS[w];
    if (entry && (!best || entry.reach > WEAPON_MODELS[best].reach)) best = w;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Enemy spawners
// ---------------------------------------------------------------------------
// Same shape as the weapon spawners: one library entry, and what it may produce
// is edited after placing. `behaviour` picks how the spawned enemies act and
// `enemyTypes` which of them may appear.
//
// The three behaviours are confirmed — the reference maps use Default,
// Aggresive and Stationary, and the misspelling is the game's, not a typo to
// fix.
//
// The ids and their order are the game's own, read off
// reference/Library/Enemies_*, which holds two spawners: one with every type
// but the handgun, and one with the handgun alone. That export settles three
// things the prefab could only hint at.
//
// **The separator is a bare comma**, not the semicolon the rule sets use for
// their flags. Twelve types come back as
// `"SMG,Shotgun,Sniper,HandgunShield,Drone,Helicopter,RPG,CorruptedSMG,..."`
// with no spaces.
//
// **The wire names are not the prefab's node names.** The in-VR toggles are
// `BotToggle_SMGCorrupted` and `BotToggle_Chopper`; the file says
// `CorruptedSMG` and `Helicopter`. The prefab's `MapEditorUI` children turn out
// to be the ones that match the file, so where the two disagree the file wins.
//
// **The order is the game's**, and it is neither of the prefab's two orderings.
// It matters because a spawner the user edits has to come back out looking like
// one the game wrote, and this is the order that does it.
//
// The one thing still inferred is where `Handgun` sits, since the export that
// lists eleven others is precisely the one with the handgun taken out. It goes
// after `Sniper` because the Corrupted block — which is complete — runs SMG,
// Shotgun, Sniper, Handgun, RPG, and the plain block is that same run with
// HandgunShield, Drone and Helicopter inserted before RPG. Putting Handgun
// immediately before RPG instead would fit the evidence equally well; nothing
// in the file distinguishes them, because the only set that would show the
// difference is one holding Handgun *and* several others. Every set the two
// orderings disagree about still round-trips, it just may not be byte-identical
// to what the game would have written.
//
// ENEMIES is the one table to edit if a game update adds a type. Each row is
// `id` — what goes in the file, and the only part the format depends on — plus:
//
//   label  what the chips and the inspector show, since `CorruptedHandgun` is
//          the file's spelling rather than anything a person would write
//   icon   sliced sprite for the inspector chip and the viewport badge
//   model  prefab in reference/GameAssets/Prefabs, a figure of the enemy that
//          stands on the spawner pad
//
// All three are looked up by name and all three fall back cleanly, so a row
// with an `id` and nothing else still loads, exports and edits correctly — it
// just draws as a plain chip and leaves the pad bare.
//
// The models are confirmed: every id below has a prefab holding a
// textured figure of exactly that enemy. The icons are matched by name and are
// the weakest part — the `filled_Icon_*_silhouette` family is the only one that
// covers drones and the Corrupted variants, which is what makes it the enemy
// set rather than the weapon set, but nothing states that outright. The
// helicopter has no silhouette at all and borrows the campaign icon.

export const ENEMY_BEHAVIOURS = ['Default', 'Aggresive', 'Stationary'];

export const ENEMIES = [
  { id: 'SMG', label: 'SMG', icon: 'filled_Icon_smg_silhouette', model: 'SMGBotSpawner' },
  { id: 'Shotgun', label: 'Shotgun', icon: 'filled_Icon_shotgun_silhouette', model: 'ShotgunBotSpawner' },
  { id: 'Sniper', label: 'Sniper', icon: 'filled_Icon_sniper_silhouette', model: 'SniperBotSpawner' },
  { id: 'Handgun', label: 'Handgun', icon: 'filled_Icon_handgun_silhouette', model: 'HandgunBotSpawner' },
  { id: 'HandgunShield', label: 'Shield', icon: 'filled_Icon_shield_silhouette', model: 'ShieldBotSpawner' },
  { id: 'Drone', label: 'Drone', icon: 'filled_Icon_drone_silhouette', model: 'DroneBotSpawner' },
  { id: 'Helicopter', label: 'Helicopter', icon: 'Icon_Campaign_Chopper', model: 'ChopperBotSpawner' },
  { id: 'RPG', label: 'RPG', icon: 'filled_Icon_rpg_silhouette', model: 'RPGBotSpawner' },
  { id: 'CorruptedSMG', label: 'SMG Corrupted', icon: 'filled_Icon_smg_corrupted_silhouette', model: 'SMGCorruptedBotSpawner' },
  { id: 'CorruptedShotgun', label: 'Shotgun Corrupted', icon: 'filled_Icon_shotgun_corrupted_silhouette', model: 'ShotgunCorruptedBotSpawner' },
  { id: 'CorruptedSniper', label: 'Sniper Corrupted', icon: 'filled_Icon_sniper_corrupted_silhouette', model: 'SniperCorruptedBotSpawner' },
  { id: 'CorruptedHandgun', label: 'Handgun Corrupted', icon: 'filled_Icon_handgun_corrupted_silhouette', model: 'HandgunCorruptedBotSpawner' },
  { id: 'CorruptedRPG', label: 'RPG Corrupted', icon: 'filled_Icon_rpg_corrupted_silhouette', model: 'RPGCorruptedBotSpawner' },
];

export const ENEMY_TYPES = ENEMIES.map((e) => e.id);

export const ENEMY_LABELS = Object.fromEntries(ENEMIES.map((e) => [e.id, e.label ?? e.id]));

export const ENEMY_ICONS = Object.fromEntries(ENEMIES.map((e) => [e.id, e.icon]));

/** Prefab standing on the pad for each enemy, for the viewport figure. */
export const ENEMY_MODELS = Object.fromEntries(ENEMIES.map((e) => [e.id, e.model]));

export const ENEMY_ANY = 'All';

export function parseEnemyTypes(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw === ENEMY_ANY) return [...ENEMY_TYPES];
  return raw.split(LIST_SEPARATOR).map((s) => s.trim()).filter(Boolean);
}

/**
 * The inverse, in the game's own order rather than the order they were ticked.
 * A spawner the user edits should come back out looking like one the game
 * wrote, and the order in `ENEMIES` is the order the reference export uses. A
 * name this build has never heard of keeps its place at the end rather than
 * being dropped, so a type added by a game update survives an unrelated edit.
 */
export function formatEnemyTypes(list) {
  const chosen = [...new Set(list.filter(Boolean))];
  if (!chosen.length) return ENEMY_ANY;
  const coversAll = ENEMY_TYPES.every((t) => chosen.includes(t))
    && chosen.length === ENEMY_TYPES.length;
  if (coversAll) return ENEMY_ANY;
  const rank = (t) => (ENEMY_TYPES.indexOf(t) + 1 || ENEMY_TYPES.length + 1);
  return chosen
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
    .map(({ t }) => t)
    .join(LIST_SEPARATOR);
}

// ---------------------------------------------------------------------------
// Player spawn zones
// ---------------------------------------------------------------------------
// The zone's whole visual is `Visual/SpawnZone`: a 1 m cube named SpawnZoneArea
// with four flat quads under it. In the prefab that cube is centred on the
// origin, running y = -0.5 to 0.5, which is why measure-prefabs calls the pivot
// `offset` rather than `base` and why the measured height is half a metre more
// than the machine is tall.
//
// Drawn as it ships, the zone is an opaque box you cannot see into and cannot
// place anything inside, and seating that box on the floor lifts the corner
// beacons and the machine half a metre into the air with it. Both problems are
// the same problem: the cube is a *volume marker*, not a solid, and the game
// tints and fades it in a shader the glTF export could not carry.
//
// So it is flattened to a 10 cm slab resting on the floor and drawn at a
// quarter opacity. That puts the rest of the prefab back where the artists put
// it — everything else in it already sits at y = 0 — and leaves the zone
// readable from above without hiding what is standing in it. The size above is
// the measured height less the half metre the cube used to add.
//
// Height is a display choice, not a fact about the map: the game's own
// stretcher offers PosX, NegX, PosZ and NegZ handles only, and every zone in
// the reference exports is scaled y = 1 exactly, so nothing is being hidden.
const SPAWN_ZONE_AREA = {
  parts: "SpawnZone/(SpawnZoneArea|Floor)",
  height: 0.1,
  opacity: 0.25,
};

// ---------------------------------------------------------------------------
// Boundaries
// ---------------------------------------------------------------------------
// Invisible walls. The game treats one exactly as it treats the solid primitive
// of the same shape — you can throw a grenade against it and hide behind it —
// and simply does not draw it, which is what makes them the AR half of the
// library: a boundary over the real coffee table is cover, and a boundary along
// the real sofa is a wall, without a virtual object standing in the room.
//
// **The five types are confirmed from a map the game wrote.** They are the bare
// `Box`, `BoxGrounded`, `Cylinder`, `CylinderGrounded` and `Wall` — the solid
// primitives' names with `Solid` taken out — and the prefabs say the same thing
// three ways. `Box.glb`'s visible mesh wears a material called
// `ProximityWarning_AlphaZero_PVP`; `Cylinder.glb`'s is named
// `InvisibleCylinder`; and the library icons are the `*Transparent` set, drawn
// as a glass box with a standard lamp inside it. There is no `WallGrounded`,
// which is the same gap the solid wall has, and no themed variant of any of
// them — a boundary has no colour to theme.
//
// Geometry, pivots and default scales are the solid primitives' exactly, and
// the reference map corroborates all three: its `Wall` sits at y = 1.25 with
// scale.y = 2.5, its `CylinderGrounded` at y = 1 with scale (0.5, 2, 0.5), its
// `BoxGrounded` at y = 0.5 with scale.y = 1. A centre pivot puts those on the
// floor only if the unit mesh is one metre, which is the same reasoning that
// pinned the solids.
//
// `keepParts` is here rather than anywhere else because these prefabs carry two
// visuals: the invisible one the game normally draws, and a `RemoteVisual` —
// wood-textured, from the Wild West theme — for the spectator who is not in the
// room and would otherwise see nothing at all. Merging both would paint every
// boundary in the editor with wood grain, so only the invisible one is kept. It
// carries no texture and no colour, which is why `texture` is null and why the
// pack's tint lands on it without `tintModel`: `displayMaterial` gives the
// catalog colour to any material that brings neither.
//
// The Grounded pair stays `hidden` for the same reason the solids' does — the
// grid here does the snapping the VR editor needs a separate object for — so a
// map that already uses them loads, displays and re-exports unchanged.
const BOUNDARY_VISUAL = "(^|/)(Visual|InvisibleCylinder)$";

const BOUNDARY = {
  category: "Boundaries", pivot: "center", size: [1, 1, 1], floor: false,
  opacity: 0.1, edges: true, texture: null, keepParts: BOUNDARY_VISUAL,
};

const BOUNDARIES = [
  { ...BOUNDARY, type: "Box", label: "Boundary Box", shape: "boxBoundary",
    rotationAxes: "xyz", defaultScale: [1, 1, 1],
    icon: "Icon_BoxSolidTransparent", model: "Box" },
  { ...BOUNDARY, type: "BoxGrounded", label: "Boundary Box (Grounded)", shape: "boxBoundary",
    rotationAxes: "y", floor: true, defaultScale: [1, 1, 1], hidden: true,
    icon: "Icon_BoxGroundedSolidTransparent", model: "BoxGrounded" },
  { ...BOUNDARY, type: "Cylinder", label: "Boundary Cylinder", shape: "cylinderBoundary",
    rotationAxes: "xyz", defaultScale: [0.5, 2, 0.5],
    icon: "Icon_CylinderTransparent", model: "Cylinder" },
  { ...BOUNDARY, type: "CylinderGrounded", label: "Boundary Cylinder (Grounded)",
    shape: "cylinderBoundary", rotationAxes: "y", floor: true, defaultScale: [0.5, 2, 0.5],
    hidden: true, icon: "Icon_CylinderTransparentGrounded", model: "CylinderGrounded" },
  // The wall's thickness is the one number a placement cannot pin down, and it
  // measures the same 0.125 the solid wall does.
  { ...BOUNDARY, type: "Wall", label: "Boundary Wall", shape: "wallBoundary",
    size: [1, 1, 0.125], rotationAxes: "y", floor: true, defaultScale: [2, 2.5, 1],
    icon: "Icon_WallSolidTransparent", model: "Wall" },
];

/** The pack id, for the viewport's Hide switch. */
export const BOUNDARY_PACK = 'boundaries';

/** Every type it owns, for the tests and for anything counting them. */
export const BOUNDARY_TYPES = BOUNDARIES.map((o) => o.type);

export const BUILTIN_PACKS = [
  {
    id: "default", name: "Default", group: "virtual", schema: PACK_SCHEMA_VERSION,
    color: "#6E7A48",
    objects: [
    { type: "BarrierCorner", label: "Barrier Corner", category: "Objects",
      shape: "barrierCorner", size: [1.14, 2, 1.143], pivot: "base", anchor: [0.888, 0.888],
      rotationAxes: "y", floor: true, defaultScale: [1, 1, 1], icon: "Icon_BarrierCorner",
      model: "BarrierCorner", texture: "BarrierMat_Diffuse_0.png" },
    { type: "BarrierFull", label: "Barrier Full", category: "Objects", shape: "barrierFull",
      size: [1.028, 2, 0.258], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], icon: "Icon_BarrierNormal", model: "BarrierFull",
      texture: "BarrierMat_Diffuse_0.png" },
    { type: "BarrierLow", label: "Barrier Low", category: "Objects", shape: "barrierLow",
      size: [1.012, 1.206, 0.258], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], icon: "Icon_BarrierLow", model: "BarrierLow",
      texture: "BarrierMat_Diffuse_0.png" },
    { type: "BarrierU", label: "Barrier U", category: "Objects", shape: "barrierU",
      size: [1.028, 2, 0.258], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], icon: "Icon_BarrierUWall", model: "BarrierU",
      texture: "BarrierMat_Diffuse.png" },
    { type: "BarrierWindow", label: "Barrier Window", category: "Objects",
      shape: "barrierWindow", size: [1.028, 2, 0.258], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], icon: "Icon_BarrierWindow", model: "BarrierWindow",
      texture: "BarrierMat_Diffuse.png" },
    { type: "Tunnel", label: "Tunnel", category: "Objects", shape: "tunnel", size: [1, 1, 1],
      pivot: "center", rotationAxes: "y", floor: true, defaultScale: [1, 2, 1],
      icon: "Icon_TunnelSolid", model: "Tunnel", texture: "DefaultGreenMetal_Diffuse.png" },
    { type: "Crate", label: "Crate", category: "Objects", shape: "crate", size: [0.5, 0.5, 0.5],
      pivot: "base", rotationAxes: "y", floor: true, defaultScale: [1, 1, 1],
      icon: "Icon_Crate", model: "Crate", texture: "Crate_Diffuse.png" },
    { type: "DestructibleCrate", label: "Destructible Crate", category: "Objects",
      shape: "crateDestructible", size: [0.5, 0.5, 0.5], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], icon: "Icon_CrateDestructable",
      model: "DestructibleCrate", texture: "WoodenCrateBreakable_Diffuse.png" },
    { type: "DefaultElectricityBox", label: "Electricity Box", category: "Objects",
      shape: "electricityBox", size: [0.545, 0.714, 0.44], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], icon: "Icon_ElectricityBoxDefault",
      model: "ElectricityBoxDefaultVisual", texture: "ElectricityBoxGreen_Diffuse.png" },
    { type: "BoxSolid", label: "Solid Box", category: "Shapes", shape: "box",
      size: [1, 1, 1], pivot: "center", rotationAxes: "xyz", floor: false,
      defaultScale: [1, 1, 1], icon: "Icon_BoxSolid_1", model: "BoxSolid",
      texture: "DefaultGreenMetal_Diffuse.png" },
    { type: "BoxSolidGrounded", label: "Solid Box (Grounded)", category: "Shapes",
      shape: "box", size: [1, 1, 1], pivot: "center", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], hidden: true, icon: "Icon_BoxSolid_grounded",
      model: "BoxSolidGrounded", texture: "DefaultGreenMetal_Diffuse.png" },
    { type: "CylinderSolid", label: "Solid Cylinder", category: "Shapes", shape: "cylinder",
      size: [1, 1, 1], pivot: "center", rotationAxes: "xyz", floor: false,
      defaultScale: [0.5, 2, 0.5], icon: "Icon_CilinderSolid", model: "CylinderSolid",
      texture: "DefaultGreenMetal_Diffuse.png" },
    { type: "CylinderSolidGrounded", label: "Solid Cylinder (Grounded)", category: "Shapes",
      shape: "cylinder", size: [1, 1, 1], pivot: "center", rotationAxes: "y", floor: true,
      defaultScale: [0.5, 2, 0.5], hidden: true, icon: "Icon_CilinderSolid_grounded",
      model: "CylinderSolidGrounded", texture: "DefaultGreenMetal_Diffuse.png" },
    { type: "WallSolid", label: "Solid Wall", category: "Shapes", shape: "wall",
      size: [1, 1, 0.125], pivot: "center", rotationAxes: "y", floor: true,
      defaultScale: [2, 2.5, 1], icon: "Icon_WallSolid_1", model: "WallSolid",
      texture: "DefaultGreenMetal_Diffuse.png" },
    ],
  },
  {
    id: "blue", name: "Blue", group: "virtual", schema: PACK_SCHEMA_VERSION,
    color: "#3E7BB8",
    objects: [
    { type: "BlueBarrierCorner", label: "Barrier Corner", category: "Objects",
      shape: "barrierCorner", size: [1.14, 2, 1.143], pivot: "base", anchor: [0.888, 0.888],
      rotationAxes: "y", floor: true, defaultScale: [1, 1, 1],
      model: "DefaultBarrierCornerBlueVisual", texture: "BarrierBlue_Diffuse.png",
      icon: "icon_DefaultBarrierCornerBlue" },
    { type: "BlueBarrierFull", label: "Barrier Full", category: "Objects",
      shape: "barrierFull", size: [1.028, 2, 0.258], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "DefaultBarrierFullBlueVisual",
      texture: "BarrierBlue_Diffuse.png", icon: "icon_DefaultBarrierFullBlue" },
    { type: "BlueBarrierLow", label: "Barrier Low", category: "Objects", shape: "barrierLow",
      size: [1.012, 1.206, 0.258], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], model: "DefaultBarrierLowBlueVisual",
      texture: "BarrierBlue_Diffuse.png", icon: "icon_DefaultBarrierLowBlue" },
    { type: "BlueBarrierU", label: "Barrier U", category: "Objects", shape: "barrierU",
      size: [1.028, 2, 0.258], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], model: "DefaultBarrierUBlueVisual",
      texture: "BarrierWindowBlue_Diffuse.png", icon: "icon_DefaultBarrierUBlue" },
    { type: "BlueBarrierWindow", label: "Barrier Window", category: "Objects",
      shape: "barrierWindow", size: [1.028, 2, 0.258], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "DefaultBarrierWindowBlueVisual",
      texture: "BarrierWindowBlue_Diffuse.png", icon: "icon_DefaultBarrierWindowBlue" },
    { type: "BlueTunnel", label: "Tunnel", category: "Objects", shape: "tunnel",
      size: [1, 1, 1], pivot: "center", rotationAxes: "y", floor: true, defaultScale: [1, 2, 1],
      model: "BlueTunnel", texture: "DefaultBlueMetal_Diffuse.png", icon: "icon_TunelBlue" },
    { type: "BlueCrate", label: "Crate", category: "Objects", shape: "crate",
      size: [0.5, 0.5, 0.5], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], model: "DefaultCrateBlueVisual", texture: "BoxBlue_Diffuse.png",
      icon: "icon_DefaultCrateBlue" },
    { type: "BlueDestructibleCrate", label: "Destructible Crate", category: "Objects",
      shape: "crateDestructible", size: [0.5, 0.5, 0.5], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "BlueDestructibleCrate",
      texture: "WoodenCrateBreakableBlue.png", icon: "icon_DefaultCrateDestructableBlue" },
    { type: "BlueElectricityBox", label: "Electricity Box", category: "Objects",
      shape: "electricityBox", size: [0.545, 0.714, 0.44], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "ElectricityBoxBlue",
      texture: "ElectricityBoxBlue_Diffuse.png", icon: "Icon_ElectricityBoxBlue" },
    { type: "BlueBoxSolid", label: "Solid Box", category: "Shapes", shape: "box",
      size: [1, 1, 1], pivot: "center", rotationAxes: "xyz", floor: false,
      defaultScale: [1, 1, 1], model: "BlueBoxSolid", texture: "DefaultBlueMetal_Diffuse.png",
      icon: "icon_CubeBlue" },
    { type: "BlueBoxSolidGrounded", label: "Solid Box (Grounded)", category: "Shapes",
      shape: "box", size: [1, 1, 1], pivot: "center", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], hidden: true, model: "BlueBoxSolidGrounded",
      texture: "DefaultBlueMetal_Diffuse.png", icon: "icon_CubeBlue_grounded" },
    { type: "BlueCylinderSolid", label: "Solid Cylinder", category: "Shapes",
      shape: "cylinder", size: [1, 1, 1], pivot: "center", rotationAxes: "xyz", floor: false,
      defaultScale: [0.5, 2, 0.5], model: "BlueCylinderSolid",
      texture: "DefaultBlueMetal_Diffuse.png", icon: "icon_CilinderBlue" },
    { type: "BlueCylinderSolidGrounded", label: "Solid Cylinder (Grounded)",
      category: "Shapes", shape: "cylinder", size: [1, 1, 1], pivot: "center",
      rotationAxes: "y", floor: true, defaultScale: [0.5, 2, 0.5], hidden: true,
      model: "BlueCylinderSolidGrounded", texture: "DefaultBlueMetal_Diffuse.png",
      icon: "icon_CilinderBlue_grounded" },
    { type: "BlueWallSolid", label: "Solid Wall", category: "Shapes", shape: "wall",
      size: [1, 1, 0.125], pivot: "center", rotationAxes: "y", floor: true,
      defaultScale: [2, 2.5, 1], model: "BlueWallSolid",
      texture: "DefaultBlueMetal_Diffuse.png", icon: "icon_WallBlue" },
    ],
  },
  {
    id: "orange", name: "Orange", group: "virtual", schema: PACK_SCHEMA_VERSION,
    color: "#D5822F",
    objects: [
    { type: "OrangeBarrierCorner", label: "Barrier Corner", category: "Objects",
      shape: "barrierCorner", size: [1.14, 2, 1.143], pivot: "base", anchor: [0.888, 0.888],
      rotationAxes: "y", floor: true, defaultScale: [1, 1, 1],
      model: "DefaultBarrierCornerOrangeVisual", texture: "BarrierOrange_Diffuse.png",
      icon: "icon_DefaultBarrierCornerOrange" },
    { type: "OrangeBarrierFull", label: "Barrier Full", category: "Objects",
      shape: "barrierFull", size: [1.028, 2, 0.258], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "DefaultBarrierFullOrangeVisual",
      texture: "BarrierOrange_Diffuse.png", icon: "icon_DefaultBarrierFullOrange" },
    { type: "OrangeBarrierLow", label: "Barrier Low", category: "Objects", shape: "barrierLow",
      size: [1.012, 1.206, 0.258], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], model: "DefaultBarrierLowOrangeVisual",
      texture: "BarrierOrange_Diffuse.png", icon: "icon_DefaultBarrierLowOrange" },
    { type: "OrangeBarrierU", label: "Barrier U", category: "Objects", shape: "barrierU",
      size: [1.028, 2, 0.258], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], model: "DefaultBarrierUOrangeVisual",
      texture: "BarrierWindowOrange_Diffuse.png", icon: "icon_DefaultBarrierUOrange" },
    { type: "OrangeBarrierWindow", label: "Barrier Window", category: "Objects",
      shape: "barrierWindow", size: [1.028, 2, 0.258], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "DefaultBarrierWindowOrangeVisual",
      texture: "BarrierWindowOrange_Diffuse.png", icon: "icon_DefaultBarrierWindowOrange" },
    { type: "OrangeTunnel", label: "Tunnel", category: "Objects", shape: "tunnel",
      size: [1, 1, 1], pivot: "center", rotationAxes: "y", floor: true, defaultScale: [1, 2, 1],
      model: "OrangeTunnel", texture: "DefaultOrangeMetal_Diffuse.png",
      icon: "icon_TuneOrange" },
    { type: "OrangeCrate", label: "Crate", category: "Objects", shape: "crate",
      size: [0.5, 0.5, 0.5], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], model: "DefaultCrateOrangeVisual",
      texture: "BoxOrange_Diffuse.png", icon: "icon_DefaultCrateOrange" },
    { type: "OrangeDestructibleCrate", label: "Destructible Crate", category: "Objects",
      shape: "crateDestructible", size: [0.5, 0.5, 0.5], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "OrangeDestructibleCrate",
      texture: "WoodenCrateBreakableOrange.png", icon: "icon_DefaultCrateDestructableOrange" },
    { type: "OrangeElectricityBox", label: "Electricity Box", category: "Objects",
      shape: "electricityBox", size: [0.545, 0.714, 0.44], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "ElectricityBoxOrange",
      texture: "ElectricityBoxOrange.png", icon: "Icon_ElectricityBoxOrange" },
    { type: "OrangeBoxSolid", label: "Solid Box", category: "Shapes", shape: "box",
      size: [1, 1, 1], pivot: "center", rotationAxes: "xyz", floor: false,
      defaultScale: [1, 1, 1], model: "OrangeBoxSolid",
      texture: "DefaultOrangeMetal_Diffuse.png", icon: "icon_CubeOrange" },
    { type: "OrangeBoxSolidGrounded", label: "Solid Box (Grounded)", category: "Shapes",
      shape: "box", size: [1, 1, 1], pivot: "center", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], hidden: true, model: "OrangeBoxSolidGrounded",
      texture: "DefaultOrangeMetal_Diffuse.png", icon: "icon_CubeOrange_grounded" },
    { type: "OrangeCylinderSolid", label: "Solid Cylinder", category: "Shapes",
      shape: "cylinder", size: [1, 1, 1], pivot: "center", rotationAxes: "xyz", floor: false,
      defaultScale: [0.5, 2, 0.5], model: "OrangeCylinderSolid",
      texture: "DefaultOrangeMetal_Diffuse.png", icon: "icon_CilinderOrange" },
    { type: "OrangeCylinderSolidGrounded", label: "Solid Cylinder (Grounded)",
      category: "Shapes", shape: "cylinder", size: [1, 1, 1], pivot: "center",
      rotationAxes: "y", floor: true, defaultScale: [0.5, 2, 0.5], hidden: true,
      model: "OrangeCylinderSolidGrounded", texture: "DefaultOrangeMetal_Diffuse.png",
      icon: "icon_CilinderOrange_grounded" },
    { type: "OrangeWallSolid", label: "Solid Wall", category: "Shapes", shape: "wall",
      size: [1, 1, 0.125], pivot: "center", rotationAxes: "y", floor: true,
      defaultScale: [2, 2.5, 1], model: "OrangeWallSolid",
      texture: "DefaultOrangeMetal_Diffuse.png", icon: "icon_WallOrange" },
    ],
  },
  {
    id: "purple", name: "Purple", group: "virtual", schema: PACK_SCHEMA_VERSION,
    color: "#7C5CB0",
    objects: [
    { type: "PurpleBarrierCorner", label: "Barrier Corner", category: "Objects",
      shape: "barrierCorner", size: [1.14, 2, 1.143], pivot: "base", anchor: [0.888, 0.888],
      rotationAxes: "y", floor: true, defaultScale: [1, 1, 1],
      model: "DefaultBarrierCornerPurpleVisual", texture: "BarrierPurple_Diffuse.png",
      icon: "icon_DefaultBarrierCornerPurple" },
    { type: "PurpleBarrierFull", label: "Barrier Full", category: "Objects",
      shape: "barrierFull", size: [1.028, 2, 0.258], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "DefaultBarrierFullPurpleVisual",
      texture: "BarrierPurple_Diffuse.png", icon: "icon_DefaultBarrierFullPurple" },
    { type: "PurpleBarrierLow", label: "Barrier Low", category: "Objects", shape: "barrierLow",
      size: [1.012, 1.206, 0.258], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], model: "DefaultBarrierLowPurpleVisual",
      texture: "BarrierPurple_Diffuse.png", icon: "icon_DefaultBarrierLowPurple" },
    { type: "PurpleBarrierU", label: "Barrier U", category: "Objects", shape: "barrierU",
      size: [1.028, 2, 0.258], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], model: "DefaultBarrierUPurpleVisual",
      texture: "BarrierWindowPurple_Diffuse.png", icon: "icon_DefaultBarrierUPurple" },
    { type: "PurpleBarrierWindow", label: "Barrier Window", category: "Objects",
      shape: "barrierWindow", size: [1.028, 2, 0.258], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "DefaultBarrierWindowPurpleVisual",
      texture: "BarrierWindowPurple_Diffuse.png", icon: "icon_DefaultBarrierWindowPurple" },
    { type: "PurpleTunnel", label: "Tunnel", category: "Objects", shape: "tunnel",
      size: [1, 1, 1], pivot: "center", rotationAxes: "y", floor: true, defaultScale: [1, 2, 1],
      model: "PurpleTunnel", texture: "DefaultPurpleMetal_Diffuse.png",
      icon: "icon_TunePurple" },
    { type: "PurpleCrate", label: "Crate", category: "Objects", shape: "crate",
      size: [0.5, 0.5, 0.5], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], model: "DefaultCratePurpleVisual",
      texture: "BoxPurple_Diffuse.png", icon: "icon_DefaultCratePurple" },
    { type: "PurpleDestructibleCrate", label: "Destructible Crate", category: "Objects",
      shape: "crateDestructible", size: [0.5, 0.5, 0.5], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "PurpleDestructibleCrate",
      texture: "WoodenCrateBreakablePurple.png", icon: "icon_DefaultCrateDestructablePurple" },
    { type: "PurpleElectricityBox", label: "Electricity Box", category: "Objects",
      shape: "electricityBox", size: [0.545, 0.714, 0.44], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "ElectricityBoxPurple",
      texture: "ElectricityBoxPurple_Diffuse.png", icon: "Icon_ElectricityBoxPurple" },
    { type: "PurpleBoxSolid", label: "Solid Box", category: "Shapes", shape: "box",
      size: [1, 1, 1], pivot: "center", rotationAxes: "xyz", floor: false,
      defaultScale: [1, 1, 1], model: "PurpleBoxSolid",
      texture: "DefaultPurpleMetal_Diffuse.png", icon: "icon_CubePurple" },
    { type: "PurpleBoxSolidGrounded", label: "Solid Box (Grounded)", category: "Shapes",
      shape: "box", size: [1, 1, 1], pivot: "center", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], hidden: true, model: "PurpleBoxSolidGrounded",
      texture: "DefaultPurpleMetal_Diffuse.png", icon: "icon_CubePurple_grounded" },
    { type: "PurpleCylinderSolid", label: "Solid Cylinder", category: "Shapes",
      shape: "cylinder", size: [1, 1, 1], pivot: "center", rotationAxes: "xyz", floor: false,
      defaultScale: [0.5, 2, 0.5], model: "PurpleCylinderSolid",
      texture: "DefaultPurpleMetal_Diffuse.png", icon: "icon_CilinderPurple" },
    { type: "PurpleCylinderSolidGrounded", label: "Solid Cylinder (Grounded)",
      category: "Shapes", shape: "cylinder", size: [1, 1, 1], pivot: "center",
      rotationAxes: "y", floor: true, defaultScale: [0.5, 2, 0.5], hidden: true,
      model: "PurpleCylinderSolidGrounded", texture: "DefaultPurpleMetal_Diffuse.png",
      icon: "icon_CilinderPurple_grounded" },
    { type: "PurpleWallSolid", label: "Solid Wall", category: "Shapes", shape: "wall",
      size: [1, 1, 0.125], pivot: "center", rotationAxes: "y", floor: true,
      defaultScale: [2, 2.5, 1], model: "PurpleWallSolid",
      texture: "DefaultPurpleMetal_Diffuse.png", icon: "icon_WallPurple" },
    ],
  },
  {
    id: "camo", name: "Camo", group: "virtual", schema: PACK_SCHEMA_VERSION,
    color: "#8B99A6",
    objects: [
    { type: "CamoBarrierCorner", label: "Barrier Corner", category: "Objects",
      shape: "barrierCorner", size: [1.107, 2.002, 1.107], pivot: "base",
      anchor: [0.911, 0.911], rotationAxes: "y", floor: true, defaultScale: [1, 1, 1],
      model: "CamoBarrier90CornerVisual", texture: "CamoBarrier_Diffuse.png",
      icon: "icon_MilitaryBarrier90Corner" },
    { type: "CamoBarrierFull", label: "Barrier Full", category: "Objects",
      shape: "barrierFullSlab", size: [1.01, 2.002, 0.196], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "CamoBarrierFullVisual",
      texture: "CamoBarrier_Diffuse.png", icon: "icon_MilitaryBarrierFull" },
    { type: "CamoBarrierLow", label: "Barrier Low", category: "Objects",
      shape: "barrierLowSlab", size: [1.01, 1.041, 0.189], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "CamoBarrierHalfVisual",
      texture: "CamoBarrier_Diffuse.png", icon: "icon_MilitaryBarrierHalf" },
    { type: "CamoBarrierWindow", label: "Barrier Window", category: "Objects",
      shape: "barrierWindowWide", size: [1.01, 2.002, 0.2], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "CamoBarrierWindowVisual",
      texture: "CamoBarrier_Diffuse.png", icon: "icon_MilitaryBarrierWindow" },
    { type: "CamoBarrierX", label: "Barrier X", category: "Objects", shape: "barrierX",
      size: [1.01, 2.002, 0.196], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], model: "CamoBarrierUVisual", texture: "CamoBarrier_Diffuse.png",
      icon: "icon_MilitaryBarrierU" },
    { type: "CamoTunnel", label: "Tunnel", category: "Objects", shape: "tunnel",
      size: [1, 1, 1], pivot: "center", rotationAxes: "y", floor: true, defaultScale: [1, 2, 1],
      model: "CamoTunnel", texture: "CamoWall_Diffuse.png", icon: "icon_MilitaryTunel" },
    { type: "CamoCrate", label: "Crate", category: "Objects", shape: "crate",
      size: [0.59, 0.506, 0.55], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], model: "CamoCrate", texture: "CamoCrateCombined_Diffuse.png",
      icon: "icon_MilitaryCrate" },
    // Not a crate. `longCrate` is its own family, deliberately not named with a
    // `crate` prefix, because anything beginning `crate` would be swallowed into
    // the crate family and go on standing in for a 0.5 m cube. This is a metre
    // and a bit long; the only other piece like it is Graffiti's crate, and the
    // two now swap with each other and with nothing else.
    { type: "CamoCrateBig", label: "Crate Big", category: "Objects", shape: "longCrateSkids",
      size: [1.187, 0.556, 0.55], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], model: "CamoCrateBig", texture: "CamoCrateCombined_Diffuse.png",
      icon: "icon_MilitaryCrateBig" },
    { type: "CamoBoxSolid", label: "Solid Box", category: "Shapes", shape: "box",
      size: [1, 1, 1], pivot: "center", rotationAxes: "xyz", floor: false,
      defaultScale: [1, 1, 1], model: "CamoBoxSolid", texture: "CamoWall_Diffuse.png",
      icon: "icon_MilitaryCube" },
    { type: "CamoBoxSolidGrounded", label: "Solid Box (Grounded)", category: "Shapes",
      shape: "box", size: [1, 1, 1], pivot: "center", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], hidden: true, model: "CamoBoxSolidGrounded",
      texture: "CamoWall_Diffuse.png", icon: "icon_MilitaryCube_grounded" },
    { type: "CamoCylinderSolid", label: "Solid Cylinder", category: "Shapes",
      shape: "cylinder", size: [1, 1, 1], pivot: "center", rotationAxes: "xyz", floor: false,
      defaultScale: [0.5, 2, 0.5], model: "CamoCylinderSolid", texture: "CamoWall_Diffuse.png",
      icon: "icon_MilitaryCilinder" },
    { type: "CamoCylinderSolidGrounded", label: "Solid Cylinder (Grounded)",
      category: "Shapes", shape: "cylinder", size: [1, 1, 1], pivot: "center",
      rotationAxes: "y", floor: true, defaultScale: [0.5, 2, 0.5], hidden: true,
      model: "CamoCylinderSolidGrounded", texture: "CamoWall_Diffuse.png",
      icon: "icon_MilitaryCilinder_grounded" },
    { type: "CamoWallSolid", label: "Solid Wall", category: "Shapes", shape: "wallLayered",
      size: [1, 1, 0.236], pivot: "center", rotationAxes: "y", floor: true,
      defaultScale: [2, 2.5, 1], model: "CamoWallSolid", texture: "Trimsheet_basecolor.png",
      icon: "icon_MilitaryWall" },
    ],
  },
  {
    id: "mykea", name: "Mykea", group: "virtual", schema: PACK_SCHEMA_VERSION,
    color: "#C9A97A",
    objects: [
    { type: "MYKEABarrierCorner", label: "Barrier Corner", category: "Objects",
      shape: "barrierCornerRound", size: [1.213, 2.075, 1.224], pivot: "base",
      anchor: [0.87, 0.833], rotationAxes: "y", floor: true, defaultScale: [1, 1, 1],
      model: "IndoorBarrierCornerVisual", texture: "IndoorBarrierCorner_Diffuse.png",
      icon: "Image_MYKEA_barrier_corner_icon" },
    { type: "MYKEABarrierFull", label: "Barrier Full", category: "Objects",
      shape: "barrierFullSlab", size: [1.002, 1.975, 0.218], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "IndoorBarrierFullVisual",
      texture: "Mykea_Diffuse.png", icon: "Image_MYKEA_barrier_full_icon" },
    { type: "MYKEABarrierLow", label: "Barrier Low", category: "Objects",
      shape: "barrierLowSlab", size: [1.002, 1.044, 0.218], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "IndoorBarrierLowVisual",
      texture: "Mykea_Diffuse.png", icon: "Image_MYKEA_barrier_low_icon" },
    { type: "MYKEABarrierU", label: "Barrier U", category: "Objects", shape: "barrierUCouch",
      size: [1.002, 1.987, 0.266], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], model: "IndoorBarrierUVisualCouch",
      texture: "MykeaObjects_Diffuse.png", icon: "Image_MYKEA_barrier_U_icon" },
    { type: "MYKEABarrierWindow", label: "Barrier Window", category: "Objects",
      shape: "barrierWindowWide", size: [1.012, 2.037, 0.273], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1.2337, 1.2337, 1.2337], model: "IndoorBarrierWindowVisual",
      texture: "Mykea_Diffuse.png", icon: "Image_MYKEA_barrier_window_icon" },
    { type: "MYKEATunnel", label: "Tunnel", category: "Objects", shape: "tunnel",
      size: [1, 1, 1], pivot: "center", rotationAxes: "y", floor: true, defaultScale: [1, 2, 1],
      model: "MYKEATunnel", texture: "IndoorPrimitives_Diffuse.png",
      icon: "Image_MYKEA_Tunel" },
    { type: "MYKEASofa", label: "Sofa", category: "Objects", shape: "sofa",
      size: [1.66, 1.038, 0.97], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], model: "IndoorBarrierGroundedVisualCouch",
      icon: "Image_MYKEA_sofa_icon" },
    { type: "MYKEACushion", label: "Cushion", category: "Objects", shape: "cushion",
      size: [1.002, 0.174, 0.502], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], model: "IndoorBarrierCrateVisual",
      texture: "MikeaPillow_Diffuse.png", icon: "Image_MYKEA_crate_icon" },
    // `crateOttoman` rather than `ottoman`, and the name is the whole of it:
    // shape ids are a family plus a variant, so this is Mykea's crate the way
    // `barrierUCouch` is Mykea's barrier U. It measures 0.5 x 0.51 x 0.5 against
    // the standard crate's 0.5 cubed, on the same base pivot and the same
    // yaw-only axis — the same box doing the same job in a sitting room — so a
    // theme swap should carry a crate to it and back.
    //
    // Naming it as a variant rather than the family is what keeps it clear of
    // the *destructible* crate: `crateOttoman` and `crateDestructible` are two
    // variants, and `sameShapeFamily` deliberately relates a family to its
    // variants and never two variants to each other. Swapping a destructible
    // crate to Mykea therefore finds nothing and leaves the piece alone, which
    // is right — an ottoman does not come apart when it is shot.
    { type: "MYKEAOttoman", label: "Ottoman", category: "Objects", shape: "crateOttoman",
      size: [0.5, 0.51, 0.5], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], model: "IndoorCover1x1", texture: "MikeaPillow_Diffuse.png",
      icon: "Image_MYKEA_cover_icon" },
    { type: "MYKEABoxSolid", label: "Solid Box", category: "Shapes", shape: "box",
      size: [1, 1, 1], pivot: "center", rotationAxes: "xyz", floor: false,
      defaultScale: [1, 1, 1], model: "MYKEABoxSolid", texture: "IndoorPrimitives_Diffuse.png",
      icon: "Image_MYKEA_Solid_box" },
    { type: "MYKEABoxSolidGrounded", label: "Solid Box (Grounded)", category: "Shapes",
      shape: "box", size: [1, 1, 1], pivot: "center", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], hidden: true, model: "MYKEABoxSolidGrounded",
      texture: "IndoorPrimitives_Diffuse.png", icon: "Image_MYKEA_Solid_box_grounded" },
    { type: "MYKEACylinderSolid", label: "Solid Cylinder", category: "Shapes",
      shape: "cylinder", size: [1, 1, 1], pivot: "center", rotationAxes: "xyz", floor: false,
      defaultScale: [0.5, 2, 0.5], model: "MYKEACylinderSolid",
      texture: "IndoorPrimitives_Diffuse.png", icon: "Image_MYKEA_Solid_cilinder" },
    { type: "MYKEACylinderSolidGrounded", label: "Solid Cylinder (Grounded)",
      category: "Shapes", shape: "cylinder", size: [1, 1, 1], pivot: "center",
      rotationAxes: "y", floor: true, defaultScale: [0.5, 2, 0.5], hidden: true,
      model: "MYKEACylinderSolidGrounded", texture: "IndoorPrimitives_Diffuse.png",
      icon: "Image_MYKEA_Solid_cilinder_grounded" },
    { type: "MYKEAWallSolid", label: "Solid Wall", category: "Shapes", shape: "wallPlain",
      size: [1, 1, 0.185], pivot: "center", rotationAxes: "y", floor: true,
      defaultScale: [2, 2.5, 1], model: "MYKEAWallSolid", texture: "IndoorWoodWall_Diffuse.png",
      icon: "Image_MYKEA_Wall" },
    ],
  },
  {
    id: "graffiti", name: "Graffiti", group: "virtual", schema: PACK_SCHEMA_VERSION,
    color: "#7F8B97",
    objects: [
    { type: "GraffitiBarrierCorner", label: "Barrier Corner", category: "Objects",
      shape: "barrierCorner", size: [1.104, 2.048, 1.08], pivot: "base", anchor: [0.915, 0.912],
      rotationAxes: "y", floor: true, defaultScale: [1, 1, 1],
      model: "BarrierStreetStyleCorner90", texture: "GraffitiBarrier_Diffuse.png",
      icon: "icon_Grafitti_CornerBarrier" },
    { type: "GraffitiBarrierFull", label: "Barrier Full", category: "Objects",
      shape: "barrierFullSlab", size: [1.014, 2.043, 0.187], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "BarrierStreetStyle2x1",
      texture: "GraffitiBarrier_Diffuse.png", icon: "icon_Grafitti_Barrier" },
    { type: "GraffitiBarrierLow", label: "Barrier Low", category: "Objects",
      shape: "barrierLow", size: [1.014, 1.199, 0.187], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "BarrierStreetStyleLow1m",
      texture: "GraffitiBarrier_Diffuse.png", icon: "icon_Grafitti_ShortBarrier" },
    { type: "GraffitiBarrierWindow", label: "Barrier Window", category: "Objects",
      shape: "barrierWindowWide", size: [1.014, 2.043, 0.194], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "BarrierStreetStyleWindow2x1m",
      texture: "GraffitiBarrier_Diffuse.png", icon: "icon_Grafitti_WindowBarrier" },
    { type: "GraffitiBarrierBroken", label: "Barrier Broken", category: "Objects",
      shape: "barrierBroken", size: [1.016, 2.043, 0.187], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "BarrierStreetStyleBroken2x1m",
      texture: "GraffitiBarrier_Diffuse.png", icon: "icon_Grafitti_LBarrier" },
    { type: "GraffitiTunnel", label: "Tunnel", category: "Objects", shape: "tunnel",
      size: [1, 1, 1], pivot: "center", rotationAxes: "y", floor: true, defaultScale: [1, 2, 1],
      model: "GraffitiTunnel", texture: "Graffiti_Diffuse.png", icon: "icon_Grafitti_Tunel" },
    // The game calls it a crate and it is shaped like one, but at 1.028 m it is
    // twice the standard crate deep — the same box as Camo's Crate Big, which
    // is why the two share the `longCrate` family and neither reaches an
    // ordinary crate. "Big Crate" here, so the library says which of the two
    // crates in this pack is which.
    //
    // `shapeYaw` because the long axis is Z on this mesh and X on Camo's: one
    // crate, modelled a quarter turn apart. Without it the two lie across each
    // other on the floor and a theme swap turns every one of them.
    { type: "GraffitiCrate", label: "Big Crate", category: "Objects", shape: "longCrate",
      shapeYaw: 90,
      size: [0.522, 0.519, 1.028], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], model: "StreetStyleCrate",
      texture: "StreetStyleBarrelCrate_Diffuse.png", icon: "icon_Grafitti_Crate" },
    { type: "GraffitiBarrel", label: "Barrel", category: "Objects", shape: "barrel",
      size: [0.522, 0.671, 0.522], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], model: "StreetStyleBarrel",
      texture: "StreetStyleBarrelCrate_Diffuse.png", icon: "icon_Grafitti_Barrel" },
    // Measured, not estimated, since `npm run graft-fbx` put the bird's own
    // mesh back into the prefab. The old 0.34 depth came off the only mesh the
    // prefab had, which was the hologram shell — and that is the pigeon scaled
    // by 1.1, so every guess taken from it was a tenth too big.
    { type: "GraffitiPigeon", label: "Pigeon", category: "Objects", shape: "pigeon",
      size: [0.183, 0.263, 0.297], pivot: "base", anchor: [0.5, 0.348], rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "StreetStylePigeon",
      icon: "icon_Grafitti_Pidgeon" },
    { type: "GraffitiBoxSolid", label: "Solid Box", category: "Shapes", shape: "box",
      size: [1, 1, 1], pivot: "center", rotationAxes: "xyz", floor: false,
      defaultScale: [1, 1, 1], model: "GraffitiBoxSolid", texture: "Graffiti_Diffuse.png",
      icon: "icon_Grafitti_Box_crate" },
    { type: "GraffitiBoxSolidGrounded", label: "Solid Box (Grounded)", category: "Shapes",
      shape: "box", size: [1, 1, 1], pivot: "center", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], hidden: true, model: "GraffitiBoxSolidGrounded",
      texture: "Graffiti_Diffuse.png", icon: "icon_Grafitti_Box_crate_grounded" },
    { type: "GraffitiCylinderSolid", label: "Solid Cylinder", category: "Shapes",
      shape: "cylinder", size: [1, 1, 1], pivot: "center", rotationAxes: "xyz", floor: false,
      defaultScale: [0.5, 2, 0.5], model: "GraffitiCylinderSolid",
      texture: "Graffiti_Diffuse.png", icon: "icon_Grafitti_Cilinder_crate" },
    { type: "GraffitiCylinderSolidGrounded", label: "Solid Cylinder (Grounded)",
      category: "Shapes", shape: "cylinder", size: [1, 1, 1], pivot: "center",
      rotationAxes: "y", floor: true, defaultScale: [0.5, 2, 0.5], hidden: true,
      model: "GraffitiCylinderSolidGrounded", texture: "Graffiti_Diffuse.png",
      icon: "icon_Grafitti_Cilinder_crate_grounded" },
    { type: "GraffitiWallSolid", label: "Solid Wall", category: "Shapes", shape: "wall",
      size: [1, 1, 0.119], pivot: "center", rotationAxes: "y", floor: true,
      defaultScale: [2, 2.5, 1], model: "GraffitiWallSolid", texture: "Trimsheet_basecolor.png",
      icon: "icon_Grafitti_Wall" },
    ],
  },
  {
    id: "paintball", name: "Paintball", group: "virtual", schema: PACK_SCHEMA_VERSION,
    color: "#34A57C",
    objects: [
    { type: "PaintballBarrierCorner", label: "Barrier Corner", category: "Objects",
      shape: "barrierCorner", size: [1.194, 2.01, 1.2], pivot: "base", anchor: [0.838, 0.888],
      rotationAxes: "y", floor: true, defaultScale: [1, 1, 1],
      model: "PaintBallBarrierCornerVisual", texture: "PaintBarrierX2x1_Diffuse.png",
      icon: "icon_PaintBallBarrierCorner" },
    { type: "PaintballBarrierFull", label: "Barrier Full", category: "Objects",
      shape: "barrierFullFeet", size: [1, 2.01, 0.268], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "PaintBallBarrierFullVisual",
      texture: "PaintBallBarrier2x1_Diffuse.png", icon: "icon_PaintBallBarrierFull" },
    { type: "PaintballBarrierLow", label: "Barrier Low", category: "Objects",
      shape: "barrierLowFeet", size: [1, 1.024, 0.268], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "PaintBallBarrierLowVisual",
      texture: "PaintBallBarrier_Diffuse.png", icon: "icon_PaintBallBarrierLow" },
    { type: "PaintballBarrierWindow", label: "Barrier Window", category: "Objects",
      shape: "barrierWindowSlot", size: [1, 2.01, 0.268], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "PaintBallBarrierWindowVisual",
      texture: "PaintBallBarrier_Diffuse.png", icon: "icon_PaintBallBarrierWindow" },
    { type: "PaintballBarrierD", label: "Barrier D", category: "Objects", shape: "barrierD",
      size: [1.009, 2.01, 0.268], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], model: "PaintBallBarrierUVisual",
      texture: "PaintBarrierU2x1_Diffuse.png", icon: "icon_PaintBallBarrierU" },
    { type: "PaintballTunnel", label: "Tunnel", category: "Objects", shape: "tunnel",
      size: [1, 1, 1], pivot: "center", rotationAxes: "y", floor: true, defaultScale: [1, 2, 1],
      model: "PaintBallTunnel", texture: "Chipboard_basecolor.png",
      icon: "icon_PaintBallSolidTunel" },
    // The game calls it a crate and models it as `PaintBallCrateVisual`, but it
    // is a barrel: round in plan at every height, with three raised ribs and a
    // lid. So it is called one here, and it stands in for nothing.
    //
    // `drum` rather than a variant of `barrel` is the whole of that last part.
    // Any id beginning `barrel` would be read as part of that family and go on
    // swapping with the Graffiti and Wild West barrels, and this is not their
    // size: 0.518 x 0.597 against 0.522 x 0.671 and 0.545 x 0.696 is seven to
    // ten centimetres shorter than either. Those two are within three
    // centimetres of each other and go on swapping between themselves.
    { type: "PaintballCrate", label: "Barrel", category: "Objects", shape: "drum",
      size: [0.518, 0.597, 0.518], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], model: "PaintBallCrateVisual",
      texture: "PaintBallCover1x1_Diffuse.png", icon: "icon_PaintBallCrate" },
    { type: "PaintballBoxSolid", label: "Solid Box", category: "Shapes", shape: "box",
      size: [1, 1, 1], pivot: "center", rotationAxes: "xyz", floor: false,
      defaultScale: [1, 1, 1], model: "PaintBallBoxSolid", texture: "Chipboard_basecolor.png",
      icon: "icon_PaintBallSolidCrate" },
    { type: "PaintballBoxSolidGrounded", label: "Solid Box (Grounded)", category: "Shapes",
      shape: "box", size: [1, 1, 1], pivot: "center", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], hidden: true, model: "PaintBallBoxSolidGrounded",
      texture: "Chipboard_basecolor.png", icon: "icon_PaintBallSolidCrate_grounded" },
    { type: "PaintballCylinderSolid", label: "Solid Cylinder", category: "Shapes",
      shape: "cylinder", size: [1, 1, 1], pivot: "center", rotationAxes: "xyz", floor: false,
      defaultScale: [0.5, 2, 0.5], model: "PaintBallCylinderSolid",
      texture: "Chipboard_basecolor.png", icon: "icon_PaintBallSolidCilinder" },
    { type: "PaintballCylinderSolidGrounded", label: "Solid Cylinder (Grounded)",
      category: "Shapes", shape: "cylinder", size: [1, 1, 1], pivot: "center",
      rotationAxes: "y", floor: true, defaultScale: [0.5, 2, 0.5], hidden: true,
      model: "PaintBallCylinderSolidGrounded", texture: "Chipboard_basecolor.png",
      icon: "icon_PaintBallSolidCilinder_grounded" },
    { type: "PaintballWallSolid", label: "Solid Wall", category: "Shapes", shape: "wall",
      size: [1, 1, 0.134], pivot: "center", rotationAxes: "y", floor: true,
      defaultScale: [2, 2.5, 1], model: "PaintBallWallSolid",
      texture: "PaintBallWall_Diffuse.png", icon: "icon_PaintBallSolidWall" },
    ],
  },
  {
    id: "wildwest", name: "Wild West", group: "virtual", schema: PACK_SCHEMA_VERSION,
    color: "#9E7346",
    objects: [
    { type: "WildWestBarrierCorner", label: "Barrier Corner", category: "Objects",
      shape: "barrierCornerPost", size: [1.112, 2.389, 1.167], pivot: "base",
      anchor: [0.948, 0.843], rotationAxes: "y", floor: true, defaultScale: [1, 1, 1],
      model: "WildWestBarrierCorner90", texture: "WildWestBarrier02_Diffuse.png",
      icon: "Image_WildWest_barrier_corner_icon" },
    { type: "WildWestBarrierFull", label: "Barrier Full", category: "Objects",
      shape: "barrierFullPost", size: [1.077, 2.389, 0.299], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "WildWestBarrierTall",
      texture: "WildWestBarrier02_Diffuse.png", icon: "Image_WildWest_barrier_full_icon" },
    { type: "WildWestBarrierLow", label: "Barrier Low", category: "Objects",
      shape: "barrierLowCap", size: [1.179, 1.212, 0.207], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "WildWestBarrierShort",
      texture: "WildWestBarrier02_Diffuse.png", icon: "Image_WildWest_barrier_short_icon" },
    { type: "WildWestBarrierDoor", label: "Barrier Door", category: "Objects",
      shape: "barrierDoor", size: [1.18, 2.1, 0.319], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "WildWestBarrierDoor",
      texture: "WildWestBarrier01_Diffuse.png", icon: "Image_WildWest_barrier_door_icon" },
    { type: "WildWestBarrierBroken", label: "Barrier Broken", category: "Objects",
      shape: "barrierBrokenPlanks", size: [1.18, 2.1, 0.319], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "WildWestBarrierBroken",
      texture: "WildWestBarrier01_Diffuse.png", icon: "Image_WildWest_barrier_broken_icon" },
    { type: "WildWestTunnel", label: "Tunnel", category: "Objects", shape: "tunnel",
      size: [1, 1, 1], pivot: "center", rotationAxes: "y", floor: true, defaultScale: [1, 2, 1],
      model: "WildWestTunnel", texture: "WildWestWood_Diffuse.png",
      icon: "Image_WildWest_tunel" },
    { type: "WildWestBarrel", label: "Barrel", category: "Objects", shape: "barrel",
      size: [0.545, 0.696, 0.551], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], model: "WildWestBarrel",
      texture: "WildWestCactiBarrel_Diffuse.png", icon: "Image_WildWest_barrel_icon" },
    { type: "WildWestCacti", label: "Cacti", category: "Objects", shape: "cacti",
      size: [0.84, 1.544, 0.629], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], model: "WildWestCacti",
      texture: "WildWestCactiBarrel_Diffuse.png", icon: "Image_WildWest_barrier_cactus_icon" },
    { type: "WildWestBoxSolid", label: "Solid Box", category: "Shapes", shape: "box",
      size: [1, 1, 1], pivot: "center", rotationAxes: "xyz", floor: false,
      defaultScale: [1, 1, 1], model: "WildWestBoxSolid", texture: "WildWestWood_Diffuse.png",
      icon: "Image_WildWest_cube" },
    { type: "WildWestBoxSolidGrounded", label: "Solid Box (Grounded)", category: "Shapes",
      shape: "box", size: [1, 1, 1], pivot: "center", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], hidden: true, model: "WildWestBoxSolidGrounded",
      texture: "WildWestWood_Diffuse.png", icon: "Image_WildWest_cube_grounded" },
    { type: "WildWestCylinderSolid", label: "Solid Cylinder", category: "Shapes",
      shape: "cylinder", size: [1, 1, 1], pivot: "center", rotationAxes: "xyz", floor: false,
      defaultScale: [0.5, 2, 0.5], model: "WildWestCylinderSolid",
      texture: "WildWestWood_Diffuse.png", icon: "Image_WildWest_cilinder" },
    { type: "WildWestCylinderSolidGrounded", label: "Solid Cylinder (Grounded)",
      category: "Shapes", shape: "cylinder", size: [1, 1, 1], pivot: "center",
      rotationAxes: "y", floor: true, defaultScale: [0.5, 2, 0.5], hidden: true,
      model: "WildWestCylinderSolidGrounded", texture: "WildWestWood_Diffuse.png",
      icon: "Image_WildWest_cilinder_grounded" },
    { type: "WildWestWallSolid", label: "Solid Wall", category: "Shapes",
      shape: "wallPlank", size: [1, 1, 0.15], pivot: "center", rotationAxes: "y", floor: true,
      defaultScale: [2, 2.5, 1], model: "WildWestWallSolid",
      texture: "WildWestWood_Diffuse.png", icon: "Image_WildWest_wall" },
    ],
  },
  {
    id: "hatchetcorp", name: "Hatchet Corp", group: "virtual", schema: PACK_SCHEMA_VERSION,
    color: "#56708C",
    objects: [
    { type: "HatchetCorpBarrierCorner", label: "Barrier Corner", category: "Objects",
      shape: "barrierCorner", size: [1.075, 2, 1.077], pivot: "base", anchor: [0.93, 0.878],
      rotationAxes: "y", floor: true, defaultScale: [1, 1, 1],
      model: "HatCoBarrierCornerVisual", texture: "HatCoBarriersTextureUpdated_Diffuse.png",
      icon: "icon_HatCoBarrierCorner" },
    { type: "HatchetCorpBarrierFull", label: "Barrier Full", category: "Objects",
      shape: "barrierFull", size: [1.04, 2, 0.261], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "HatCoBarrierFullVisual",
      texture: "HatCoBarriersTextureUpdated_Diffuse.png",
      icon: "icon_HatCoBarrierSmallWindow" },
    { type: "HatchetCorpBarrierWindow", label: "Barrier Window", category: "Objects",
      shape: "barrierWindowTall", size: [1.036, 1.998, 0.25], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "HatCoBarrierWallWindow",
      texture: "HatCoBarriersTextureUpdated_Diffuse.png", icon: "icon_HatCoBarrierWallWindow" },
    { type: "HatchetCorpBarrierL", label: "Barrier L", category: "Objects", shape: "barrierL",
      size: [1.028, 1.996, 0.335], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], model: "HatCoBarrierUVisual",
      texture: "HatCoBarriersTextureUpdated_Diffuse.png", icon: "icon_HatCoBarrierU" },
    { type: "HatchetCorpBarrierDoorway", label: "Barrier Doorway", category: "Objects",
      shape: "barrierDoorway", size: [1.053, 1.998, 0.262], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "HatCoBarrierDoorwayVisual",
      texture: "HatCoBarriersTextureUpdated_Diffuse.png", icon: "icon_HatCoBarrierDoorway" },
    // `barrierLowSlope`, so a theme swap treats it as Hatchet Corp's low
    // barrier — which it is. 1.028 x 1.198 x 0.262 against the standard low
    // barrier's 1.012 x 1.206 x 0.258 is a match to within eight millimetres on
    // every axis, and Hatchet Corp is the only themed pack with no low barrier
    // under that name. A variant rather than the family, so it reaches the
    // plain `barrierLow` and not Camo's or Mykea's slab.
    { type: "HatchetCorpBarrierSlope", label: "Barrier Slope", category: "Objects",
      shape: "barrierLowSlope", size: [1.028, 1.198, 0.262], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "HatCoBarrierSlopeVisual",
      texture: "HatCoBarriersTextureUpdated_Diffuse.png", icon: "icon_HatCoBarrierSlope" },
    { type: "HatchetCorpTunnel", label: "Tunnel", category: "Objects", shape: "tunnel",
      size: [1, 1, 1], pivot: "center", rotationAxes: "y", floor: true, defaultScale: [1, 2, 1],
      model: "HatchetCorpTunnel", texture: "HatchetCorpWall_Diffuse.png",
      icon: "icon_HatCoTunel" },
    { type: "HatchetCorpPillar", label: "Pillar", category: "Objects", shape: "pillar",
      size: [0.638, 1.999, 0.526], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], model: "HatCoBarrierPillarVisual",
      texture: "HatCoBarriersTextureUpdated_Diffuse.png", icon: "icon_HatCoBarrierPillar" },
    { type: "HatchetCorpCrate", label: "Crate", category: "Objects", shape: "crate",
      size: [0.553, 0.486, 0.505], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], model: "HatCoBarrierCrateVisual",
      texture: "HatCoBarrierCrate_Diffuse.png", icon: "icon_HatCoBarrierCrate" },
    { type: "HatchetCorpBoxSolid", label: "Solid Box", category: "Shapes", shape: "box",
      size: [1, 1, 1], pivot: "center", rotationAxes: "xyz", floor: false,
      defaultScale: [1, 1, 1], model: "HatchetCorpBoxSolid",
      texture: "HatchetCorpWall_Diffuse.png", icon: "icon_HatCoBoxSolid" },
    { type: "HatchetCorpBoxSolidGrounded", label: "Solid Box (Grounded)",
      category: "Shapes", shape: "box", size: [1, 1, 1], pivot: "center", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], hidden: true, model: "HatchetCorpBoxSolidGrounded",
      texture: "HatchetCorpWall_Diffuse.png", icon: "icon_HatCoBoxSolid_grounded" },
    { type: "HatchetCorpCylinderSolid", label: "Solid Cylinder", category: "Shapes",
      shape: "cylinder", size: [1, 1, 1], pivot: "center", rotationAxes: "xyz", floor: false,
      defaultScale: [0.5, 2, 0.5], model: "HatchetCorpCylinderSolid",
      texture: "HatchetCorpWall_Diffuse.png", icon: "icon_HatCoCilinderSolid" },
    { type: "HatchetCorpCylinderSolidGrounded", label: "Solid Cylinder (Grounded)",
      category: "Shapes", shape: "cylinder", size: [1, 1, 1], pivot: "center",
      rotationAxes: "y", floor: true, defaultScale: [0.5, 2, 0.5], hidden: true,
      model: "HatchetCorpCylinderSolidGrounded", texture: "HatchetCorpWall_Diffuse.png",
      icon: "icon_HatCoCilinderSolid_grounded" },
    { type: "HatchetCorpWallSolid", label: "Solid Wall", category: "Shapes", shape: "wall",
      size: [1, 1, 0.154], pivot: "center", rotationAxes: "y", floor: true,
      defaultScale: [2, 2.5, 1], model: "HatchetCorpWallSolid",
      texture: "HatchetCorpWall_Diffuse.png", icon: "icon_HatCoWall" },
    ],
  },
  {
    id: "corrupted", name: "Corrupted Technology", group: "virtual", schema: PACK_SCHEMA_VERSION,
    color: "#6B7784",
    objects: [
    { type: "WireContainer", label: "Wire Container", category: "Objects",
      shape: "wireContainer", size: [0.554, 0.718, 0.534], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "WireContainer",
      texture: "WireContainerArena_Diffuse.png", icon: "Icon_Campaign_WireContainer" },
    { type: "Console", label: "Console", category: "Objects", shape: "console",
      size: [2.762, 1.131, 1.03], pivot: "base", anchor: [0.5, 0.864], rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "Console",
      texture: "ConsoleArena_Diffuse.png", icon: "Icon_Campaign_Console" },
    { type: "Server", label: "Server", category: "Objects", shape: "server",
      size: [0.771, 1.443, 1.12], pivot: "base", anchor: [0.502, 0.34], rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "Server", texture: "ServerArena_Diffuse.png",
      icon: "Icon_Campaign_Server" },
    { type: "CenterStationCPU", label: "Center Station CPU", category: "Objects",
      shape: "centerStationCpu", size: [1.525, 2.496, 1.047], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "CentralStationCPU",
      texture: "CenterStationCPUArena_Diffuse.png", icon: "Icon_Campaign_CenterStationCPU" },
    { type: "CoffeeMachine", label: "Coffee Machine", category: "Objects",
      shape: "coffeeMachine", size: [0.94, 2.301, 0.979], pivot: "base", anchor: [0.467, 0.584],
      rotationAxes: "y", floor: true, defaultScale: [1, 1, 1], model: "CoffeeMachine",
      texture: "CoffeeMachineArena_Diffuse.png", icon: "Icon_Campaign_CoffeeMachine" },
    { type: "Recuperator", label: "Recuperator", category: "Objects", shape: "recuperator",
      size: [0.973, 0.664, 0.294], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], model: "Recuperator", texture: "RecuperatorArena_Diffuse.png",
      icon: "Icon_Campaign_Recuperator" },
    { type: "SampleAnalysisMachine", label: "Sample Analysis Machine", category: "Objects",
      shape: "sampleAnalysis", size: [2.409, 2.676, 2.026], pivot: "base",
      anchor: [0.504, 0.391], rotationAxes: "y", floor: true, defaultScale: [1, 1, 1],
      model: "SampleAnalysisMachineArena", texture: "SampleAnalysisMachine_Diffuse.png",
      icon: "Icon_Campaign_SampleAnalysisMachine" },
    { type: "Truck", label: "Truck", category: "Objects", shape: "truck",
      size: [2.497, 3.305, 6.831], pivot: "base", anchor: [0.5, 0.511], rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "Truck", texture: "TruckArena_Diffuse.png",
      icon: "Icon_Campaign_Truck" },
    { type: "Chopper", label: "Chopper", category: "Objects", shape: "chopper",
      size: [7.42, 3.149, 6.588], pivot: "base", anchor: [0.5, 0.4], rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "Chopper",
      texture: "ChopperArena_Diffuse.png", icon: "Icon_Campaign_Chopper" },
    { type: "Tank", label: "Tank", category: "Objects", shape: "tank",
      size: [3.971, 3.364, 6.477], pivot: "base", anchor: [0.5, 0.555], rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "Tank", texture: "TankArena_Diffuse.png",
      icon: "Icon_Campaign_Tank" },
    { type: "CrystalSmall", label: "Crystal Small", category: "Objects", shape: "crystalSmall",
      size: [1.001, 1.65, 0.903], pivot: "base", rotationAxes: "y", floor: true,
      defaultScale: [1, 1, 1], model: "Crystal03", texture: "CrystalsArena_Emissive.png",
      icon: "Icon_Campaign_Crystal03" },
    { type: "DarkCrystalSmall", label: "Dark Crystal Small", category: "Objects",
      shape: "crystalSmall", size: [1.001, 1.65, 0.903], pivot: "base", rotationAxes: "y",
      floor: true, defaultScale: [1, 1, 1], model: "CrystalDark03",
      texture: "DarkCrystalsArena_Emissive.png", icon: "Icon_Campaign_CrystalDark03" },
    { type: "CrystalCircle", label: "Crystal Circle", category: "Objects",
      shape: "crystalCircle", size: [1.611, 1.205, 1.364], pivot: "base",
      anchor: [0.468, 0.534], rotationAxes: "y", floor: true, defaultScale: [1, 1, 1],
      model: "Crystal02", texture: "CrystalsArena_Emissive.png",
      icon: "Icon_Campaign_Crystal02" },
    { type: "DarkCrystalCircle", label: "Dark Crystal Circle", category: "Objects",
      shape: "crystalCircle", size: [1.611, 1.205, 1.364], pivot: "base",
      anchor: [0.468, 0.534], rotationAxes: "y", floor: true,
      defaultScale: [0.9195, 0.9195, 0.9195], model: "CrystalDark02",
      texture: "DarkCrystalsArena_Emissive.png", icon: "Icon_Campaign_CrystalDark02" },
    { type: "CrystalHalfCircle", label: "Crystal Half Circle", category: "Objects",
      shape: "crystalHalf", size: [1.831, 0.994, 1.152], pivot: "base", anchor: [0.472, 0.464],
      rotationAxes: "y", floor: true, defaultScale: [1, 1, 1], model: "Crystal01",
      texture: "CrystalsArena_Emissive.png", icon: "Icon_Campaign_Crystal01" },
    { type: "DarkCrystalHalfCircle", label: "Dark Crystal Half Circle", category: "Objects",
      shape: "crystalHalf", size: [1.831, 0.994, 1.152], pivot: "base", anchor: [0.472, 0.464],
      rotationAxes: "y", floor: true, defaultScale: [1, 1, 1], model: "CrystalDark01",
      texture: "DarkCrystalsArena_Emissive.png", icon: "Icon_Campaign_CrystalDark01" },
    ],
  },
  {
    id: BOUNDARY_PACK, name: "Boundaries", group: "virtual", schema: PACK_SCHEMA_VERSION,
    color: "#4FC3E8",
    objects: BOUNDARIES,
  },
  {
    id: "gameplay", name: "Gameplay Objects", group: "gameplay", schema: PACK_SCHEMA_VERSION,
    objects: [
    { type: "WeaponSpawnPoint", objectType: "WeaponSpawnPoint",
      props: { specificWeapon: "All" }, label: "Weapon Spawn", category: "Weapon Spawns",
      shape: "spawnAll", size: [0.449, 0.344, 0.222], pivot: "base", rotationAxes: "y",
      floor: true, facing: "z", color: "#E8C547", defaultScale: [1, 1, 1], model: "WeaponSpawnPoint",
      weapon: true,
      texture: "initialShadingGroup_Diffuse.png", icon: "icon_weapons_Shotgunspawner" },
    { type: "DamageBox", objectType: "DamageBox", props: { style: "Red" }, label: "Damage Box",
      category: "Hazards", shape: "damageBox", size: [1, 1, 1], pivot: "center",
      rotationAxes: "xyz", floor: false, color: "#E0574B", defaultScale: [1, 1, 1],
      opacity: 0.12, model: "DamageBox", icon: "Icon_DamageBox",
      team: "Neutral", teamFamily: "damageBox", field: true },
    { type: "DamageBoxTeam1", objectType: "DamageBox", props: { style: "Blue" },
      label: "Damage Box Blue Team", category: "Hazards", shape: "damageBox", size: [1, 1, 1],
      pivot: "center", rotationAxes: "xyz", floor: false, color: "#4A90D9",
      defaultScale: [1, 1, 1], opacity: 0.12, model: "DamageBoxTeam1",
      icon: "Icon_DamageBoxTeam1", team: "Blue", teamFamily: "damageBox", field: true },
    { type: "DamageBoxTeam2", objectType: "DamageBox", props: { style: "Orange" },
      label: "Damage Box Orange Team", category: "Hazards", shape: "damageBox", size: [1, 1, 1],
      pivot: "center", rotationAxes: "xyz", floor: false, color: "#E08A3C",
      defaultScale: [1, 1, 1], opacity: 0.12, model: "DamageBoxTeam2",
      icon: "Icon_DamageBoxTeam2", team: "Orange", teamFamily: "damageBox", field: true },
    { type: "ExplosiveBarrel", label: "Explosive Barrel", category: "Hazards",
      shape: "explosiveBarrel", size: [0.61, 0.81, 0.61], pivot: "base", rotationAxes: "y",
      floor: true, color: "#C4452F", defaultScale: [1, 1, 1], model: "ExplosiveBarrel",
      texture: "ExplosiveBarrel_Diffuse.png", icon: "Icon_ExplosiveBarrel" },
    // The prefab is a frame around a hole: what fills it in game is a Unity
    // canvas drawn at runtime — scores, team crests, a clock — and a canvas is
    // not a mesh, so the prefab is the surround and nothing else.
    // `screen` paints the game's own picture of that display back into the
    // opening. See `_refreshScreen` in scene.js and DERIVED_ICONS in
    // tools/stage-assets.mjs.
    { type: "Jumbotron", label: "Jumbotron", category: "Emplacements", shape: "jumbotron",
      size: [1.4, 1, 0.057], pivot: "center", rotationAxes: "xyz", floor: false, facing: "z",
      color: "#3A4C5A", defaultScale: [1, 1, 1], model: "Jumbotron",
      screen: { image: "Image_JumbotronScreen", inset: 0.065 },
      icon: "Icon_JumbotronSingleScreen" },
    { type: "Minigun", label: "Minigun", category: "Emplacements", shape: "minigun",
      size: [0.643, 0.501, 1.206], pivot: "base", anchor: [0.569, 0.59], rotationAxes: "y",
      floor: true, color: "#6E7C8A", defaultScale: [0.9, 0.9, 0.9], model: "Minigun",
      texture: "lambert1_Diffuse_0.png", icon: "Icon_Minigun" },
    // A note left standing in the arena: a flat pane with a line of the
    // author's own text on it, and a tick saying whether players see it or only
    // the person building the map.
    //
    // `CustomMessage.glb` holds **no mesh at all** — it is a Unity canvas, the
    // same hole the Jumbotron has and for the same reason — so the size comes
    // from the parts of the prefab that did survive: an `Outline` box of
    // 1 x 1 x 0.1, a `Collider` of 1 x 1 x 0.01, and a `Manipulator` whose
    // handles sit at +/-0.5 in X and Y. Two things follow. The unit is a one
    // metre square, and the stretcher has **no Z handles**, so the game resizes
    // this in X and Y alone; every message in the reference map is scaled
    // exactly 1 in Z and the other two vary, which is that same fact written
    // down twice. The 0.01 depth is the collider's, and it is the pane.
    //
    // `text` paints `content` across the face — see `_refreshText` in scene.js.
    { type: "CustomMessage", objectType: "CustomMessage",
      props: { content: "New message", showInGame: true },
      label: "Custom Text Message", category: "Emplacements", shape: "messagePane",
      size: [1, 1, 0.01], pivot: "center", rotationAxes: "xyz", floor: false, facing: "z",
      color: "#8FA6B8", defaultScale: [1, 1, 1], model: "CustomMessage",
      text: { prop: "content", inset: 0.06 }, icon: "icon_text_obj" },
    ],
  },
  {
    id: "objectives", name: "Mode Objectives", group: "objectives", schema: PACK_SCHEMA_VERSION,
    objects: [
    { type: "PlayerSpawnZoneTeam1", label: "Player Spawn Zone Blue Team", category: "Spawn Zones",
      shape: "spawnZone", size: [1.202, 2.363, 1.392], pivot: "base", anchor: [0.5, 0.432], rotationAxes: "y", floor: true,
      color: "#4A90D9", defaultScale: [1, 1, 1],
      model: "PlayerSpawnZoneTeam1", texture: "TPgradientVerticalConcave00 1.png", tintModel: true, fixedParts: "Radio|SpawnPointMachine", area: SPAWN_ZONE_AREA, icon: "Icon_SpawnZoneTeam1",
      team: "Blue", teamFamily: "playerSpawnZone" },
    { type: "PlayerSpawnZoneTeam2", label: "Player Spawn Zone Orange Team", category: "Spawn Zones",
      shape: "spawnZone", size: [1.202, 2.399, 1.392], pivot: "base", anchor: [0.5, 0.432], rotationAxes: "y", floor: true,
      color: "#E08A3C", defaultScale: [1, 1, 1],
      model: "PlayerSpawnZoneTeam2", texture: "TPgradientVerticalConcave00 1.png", tintModel: true, fixedParts: "Radio|SpawnPointMachine", area: SPAWN_ZONE_AREA, icon: "Icon_SpawnZoneTeam2",
      team: "Orange", teamFamily: "playerSpawnZone" },
    { type: "EnemySpawnPoint", objectType: "EnemySpawnPoint",
      props: { enemyTypes: "All", behaviour: "Default" }, label: "Enemy Spawn",
      category: "Enemy Spawns", shape: "enemySpawn", size: [1.061, 0.289, 1.059], pivot: "base",
      rotationAxes: "y", floor: true, groundOnly: true, color: "#C0553F", defaultScale: [1, 1, 1],
      figure: "enemy", model: "EnemySpawnPoint", texture: "EnemySpawner_Diffuse.png",
      icon: "Icon_Enemy_Spawner" },
    { type: "DominationZoneA", label: "Domination Zone A", category: "Domination",
      shape: "dominationZoneA", size: [2, 0.01, 2], pivot: "base", rotationAxes: "y",
      floor: true, color: "#E8C547", defaultScale: [1, 1, 1], model: "DominationZoneA",
      texture: "Circle Outline 1024px - Stroke 10px.png", tintModel: true, cutout: true,
      badge: "A", icon: "Icon_FlagA" },
    { type: "DominationZoneB", label: "Domination Zone B", category: "Domination",
      shape: "dominationZoneB", size: [2, 0.01, 2], pivot: "base", rotationAxes: "y",
      floor: true, color: "#B98FD6", defaultScale: [1, 1, 1], model: "DominationZoneB",
      texture: "Circle Outline 1024px - Stroke 10px.png", tintModel: true, cutout: true,
      badge: "B", icon: "Icon_FlagB" },
    { type: "DominationZoneC", label: "Domination Zone C", category: "Domination",
      shape: "dominationZoneC", size: [2, 0.01, 2], pivot: "base", rotationAxes: "y",
      floor: true, color: "#5AD6A0", defaultScale: [1, 1, 1], model: "DominationZoneC",
      texture: "Circle Outline 1024px - Stroke 10px.png", tintModel: true, cutout: true,
      badge: "C", icon: "Icon_FlagC" },
    // Both flag prefabs exported with their bones, colliders and outline but no
    // mesh — Unity keeps a SkinnedMeshRenderer's mesh in a separate asset, and
    // that asset was published on its own. `npm run graft-fbx` puts it back, so
    // these draw the game's own cloth now; the stand-in stays as the fallback.
    //
    // The size is still off the prefab's colliders and outline box rather than
    // off the mesh, because they disagree and the box is the honest one: a
    // 2.15 m column 0.2 m across, of which the art fills 0.8 m to 1.9 m and the
    // rest is the empty air the flag hangs in. Hence `hover` — see seatOnFloor.
    // The cloth reaches 0.537 m to one side, and `anchor` puts the pole on the
    // object's origin, where the game has it, instead of in the middle of a
    // footprint the cloth stretches to one side.
    //
    // Team 1 is blue and team 2 orange throughout the catalog — the spawn zone
    // icons and the damage box styles both say so — and these two had each
    // other's icons.
    { type: "CaptureFlagSpawnTeam1", label: "Capture Flag Blue Team",
      category: "Capture The Flag", shape: "flagSpawn", size: [0.637, 2.15, 0.2], pivot: "base",
      anchor: [0.157, 0.5], rotationAxes: "y", floor: true, color: "#4A90D9", hover: true,
      defaultScale: [1, 1, 1], model: "CaptureFlagSpawnPointTeam1", icon: "Icon_PurpleTeamFlag",
      team: "Blue", teamFamily: "captureFlag" },
    { type: "CaptureFlagSpawnTeam2", label: "Capture Flag Orange Team",
      category: "Capture The Flag", shape: "flagSpawn", size: [0.637, 2.15, 0.2], pivot: "base",
      anchor: [0.157, 0.5], rotationAxes: "y", floor: true, color: "#E08A3C", hover: true,
      defaultScale: [1, 1, 1], model: "CaptureFlagSpawnPointTeam2", icon: "Icon_OrangeTeamFlag",
      team: "Orange", teamFamily: "captureFlag" },
    ],
  },
];
