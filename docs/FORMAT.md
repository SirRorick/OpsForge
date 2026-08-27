# Spatial Ops map file format (v4)

Reverse engineered from sixteen v4 map files exported out of the in-game
editor — one per library group, one per object theme, one with every rule set
option deliberately changed, one with none of them changed, and one holding a
pair of enemy spawners between them naming every enemy in the game. Those files
are not published. Everything here is verified against them unless marked
**unconfirmed**: each one loads and re-exports byte for byte, which is the
standard every claim below is held to. Corrections welcome.

## The file itself

- **No extension.** The name is `` `${name}_${guid}` `` — e.g.
  `Warehouse_3f2b1c4d5e6a7b8c9d0e1f2a3b4c5d6e`.
- **Minified JSON**, UTF-8, no BOM, no trailing newline.
- Serialised by **Newtonsoft.Json**, which matters for two reasons below.

## GUIDs

`guid` is `Guid.NewGuid().ToString("N")`: a RFC 4122 **version 4** UUID printed
as 32 lowercase hex digits with no hyphens or braces. The sample decomposes to
`f1d7dd74-461f-492a-a897-773d77451a78` — note the `4` starting the third group
and the `a` (binary `10xx`) starting the fourth, exactly as v4 requires.

Generate with `crypto.randomUUID().replace(/-/g, '')`, not with 32 random hex
digits, or the version and variant bits will be wrong.

## Number formatting

Two rules have to be reproduced to get a byte-identical file:

1. **Ints and floats are written differently.** `mapBoundsSize` and
   `navCloud.divisions` are integer vectors and are written bare (`"x":7`).
   Every other numeric is a single-precision float, and Newtonsoft always
   leaves a decimal point on, so integral values become `"y":0.0`.

2. **Floats use .NET Framework / Mono `"R"` formatting**, not the modern
   shortest-round-trip algorithm: 7 significant digits with trailing zeros
   trimmed, falling back to 9 significant digits when 7 does not round-trip.
   This is why the sample contains both `2.729975` (7 digits) and
   `2.54036975` (9 digits). Shortest-round-trip formatting would emit
   `2.5403697` and produce a file that differs from the game's own output.

3. **Below `1e-5`, .NET writes scientific notation** — `E`, an explicit sign,
   and the exponent padded to two digits: `-1.65042636E-07`. The rule is
   .NET's own for `"G{p}"`: fixed-point when the exponent is greater than −5
   and less than the precision, scientific otherwise.

That third rule was missing until a map full of custom messages turned up. It
is easy to go a long way without meeting it, because nothing in the arena is a
fraction of a micrometre — but a *rotation* can be. A sign placed by hand in VR
sits a hair off the vertical, and its third axis comes out at about `1e-7`,
which the editor was spelling as `-0.000000165042636`. The value is the same
float; the bytes are not.

Every float literal in every reference export is reproduced exactly by the
three rules above; see `f32` in `src/format.js`.

## Top-level fields

| Field | Type | Notes |
|---|---|---|
| `guid` | string | 32 hex, matches the file name suffix |
| `version` | int | `4` in the sample. Format version, unrelated to UUID v4 |
| `name` | string | Display name, also the file name prefix |
| `author` | string | |
| `source` | string | `"Player"` in the sample. Other values **unconfirmed** |
| `createdTime` / `editedTime` / `playedTime` | string | `yyyy-MM-ddTHH:mm:ss`, no timezone, no fractional seconds. Never played is `0001-01-01T00:00:00` (`DateTime.MinValue`) |
| `mapBoundsSize` | int vector | Arena size in whole metres. `y` is ceiling height |
| `ruleSets` | array | See below |
| `anchors` | array | See below |
| `mapObjects` | array | The actual level |
| `navCloud` | object | Physical play space |
| `hasArUcoAnchor` | bool | `false` in the sample |

## `ruleSets`

A list of rule sets. Each has a free-text `name`, a `type` naming its base mode,
and four value dictionaries. Types seen: `FreeForAll`, `Survival`,
`TeamDeathMatch`, `CaptureTheFlag`, `Domination`. Most maps have five entries,
one per mode, with four empty dictionaries each:

```json
{"name":"Free For All","type":"FreeForAll","intValues":{},"boolValues":{},"enumValues":{},"flagsValues":{}}
```

The list is addressed by position, not by type: two sets may share a base mode
and differ only by name, so order is part of the file. **There is no id field** —
a builder that adds one writes a key the game never wrote.

**An empty dictionary means "every setting is at the game's default", not
"nothing is set".** The game only serialises settings that were changed. Two
exports pin this down from both ends. `reference/Library/DefaultRules_*` was
made by opening the rules screen and changing nothing, and every one of its
five modes comes back with four empty dictionaries — the game does not write
out the values it is using. `reference/Rules Examples_*` was made with a large
number of settings deliberately moved off their defaults, and every one of them
appears:

```json
{"name":"Free For All Example","type":"FreeForAll",
 "intValues":{"GameDuration":360,"PlayerRespawnTime":4,"RespawnInvulnerabilityTime":4,
              "BarrierPenaltyTime":6,"ScoreObjective":1501,"DamageModifier":101,
              "DamageBoxDamageModifier":101},
 "boolValues":{"SilentBotSpawning":true,"FriendlyFire":true,"ShowHelmet":true,
               "HideMapOnLobby":true,"SingleWeaponPerSpawner":true,"EnableAllowedWeapons":true},
 "enumValues":{"Permadeath":"Everyone","BotDifficulty":"Hard"},
 "flagsValues":{"WeaponSource":"Spawners;Holsters"}}
```

Ints are written bare, bools as JSON literals, enums as strings, and flags as
a semicolon-joined set. Note the semicolon: it belongs to this serialiser only,
and the spawner props below use a comma. `src/rules.js` holds the full per-mode
key list; the editor writes a key only once you change it, and clearing a field
removes the key again rather than writing a zero.

### Where the schema comes from

Three sources, and they are not equally strong.

`reference/rules/spatial-ops-rules-spec.md` is a writeup of the in-game rules
screen — every field, its control, its default, its range, and the conditions
that nest one rule under another. Every default and every stepper range in
`src/rules.js` comes from it, and nothing else to hand records a single one of
them.

The reference exports are the only evidence of what the game actually *writes*.
They confirm 23 of the 46 keys, which dictionary each lives in, and the flags
encoding. They do **not** cover the other 23: the `Rules Examples` export
changed a large subset of the rules screen, not all of it, so `ShowVest`, the
holsters, the per-weapon respawn times and the survival lives fields are absent
from it.

`reference/GameAssets/Definitions/*Rule.asset` is one asset per rule. The
MonoBehaviours are stripped to their names — no values — but the names and the
`m_Script` guids survive, and both are useful. The guid groups the rules by
class, which settles the dictionary for every key an export never showed: 23
share the int class, 11 the bool class, the six holsters share one flags class,
and `WeaponSourceRule` and `AllowedWeaponsRule` have one each. And the name
gives the key: for all 23 keys an export confirms, **the key is exactly the
asset name with the `Rule` suffix removed** — `GameDurationRule` →
`GameDuration`, `SingleWeaponPerSpawnerRule` → `SingleWeaponPerSpawner`, 23 for
23. The other 23 keys are derived that way, and `src/rules.js` marks them
`confirmed: false` so the editor can say which is which.

Two spellings in there are worth not tidying. `ShowSpawnZoneArrowInLobby.asset`
has no `Rule` suffix at all, while its key matches the file. And
`WeaponRespawnTimeRiotshieldRule` spells the shield with a small s where the
weapon id itself is `RiotShield` — the two are different strings in the game.

### Sections, defaults and conditions

The screen renders five sections in order: `GAME`, `OBJECTIVES`, `WEAPON`, then
`WEAPON SPAWNERS` and `HOLSTERS`, the last two only when `WeaponSource` asks for
them. Three of them are identical in all five modes; only the game and
objectives sections differ, and section 8 of the spec lists exactly how.

Four rows are conditional on another setting: the two survival lives fields on
`LifeMode`, `AllowedWeapons` on `EnableAllowedWeapons`, and the respawn block on
`EnableWeaponRespawnTimePerWeaponType`, which swaps one global field for nine
per-weapon ones. `WeaponDespawnTime` is present in both states.

`GameDuration` is one integer of seconds, entered on screen as separate minute
and second steppers. The seconds stepper stops at 59 and does not roll over, and
the ten-second floor is on the total, so 0m 0s through 0m 9s are not reachable.

Three numeric ceilings are narrower than the general 10000 and are the ones to
lose in a refactor: penalty time at 100, domination objective at 100, and the
two co-op lives fields at 20 and 100.

Ranges bound what the editor *writes*, never what it reads. The `Rules Examples`
export carries `DominationObjective: 101` against a stated ceiling of 100, so
clamping on load would rewrite a file the game itself produced. A loaded value
outside its range is flagged in the panel and left alone.

`fallback` in `src/rules.js` is the game's own value for an untouched setting.
It is display only: the editor shows it greyed inside each control and never
writes it, because the whole point of the sparse dictionaries is that an
untouched setting stays absent.

### Flags

Multi-select values are semicolon-joined member lists. **A full selection is
spelled out, not collapsed** — a back holster with four of its five weapons
ticked was written `"Shotgun;SniperRifle;RiotShield;RPG"`, and the one
two-of-two value any export contains was written `"Spawners;Holsters"` rather
than `"All"`. `All` is a display convention of the in-game dropdown only.
Members come out in the rules screen's own order rather than the order they
were ticked.

### The same weapon has two names

A weapon is spelled one way when a map object names it and another when a rule
names it, and the two are not interchangeable:

```
"specificWeapon":"Sniper"                    a WeaponSpawnPoint
"HolsterWeaponsBackLeft":"SniperRifle"       a rule set
```

Four of the nine differ, and they are exactly the four the rules screen shows
under a different name:

| Object | Rule | On screen |
|---|---|---|
| `Handgun` | `Revolver` | Revolver |
| `SMG` | `TommyGun` | Tommy Gun |
| `Sniper` | `SniperRifle` | Sniper Rifle |
| `Healthpack` | `HealthKit` | Health Kit |
| `Shotgun` `RiotShield` `RPG` `Grenade` `Flashbang` | the same | Riot Shield, … |

Both halves are confirmed and by different evidence. The object spelling appears
as `specificWeapon` in the reference exports and again in the game's own asset
names — `WeaponRespawnTimeSniperRule`, `WeaponRespawnTimeHealthpackRule`, which
is why the per-weapon respawn *keys* keep it. The rule spelling comes from two
maps saved in-headset that between them set every option of every holster.

The rule name is the screen name with its space taken out, but that is a
description rather than a rule to derive from: `RiotShield` is written
`RiotShield` in both namespaces while its own rule asset is
`WeaponRespawnTimeRiotshieldRule`, with a small s. Three spellings of one
weapon, each belonging where it belongs.

Getting this wrong is silent. A holster sent a name the game does not recognise
matches nothing and reads as **None** in the headset — no error, no warning, and
a map that looks correct everywhere else.

### Still unconfirmed

- **The literal an enum writes for a value no export used.** `Everyone`,
  `Hard` and `Permadeath` are confirmed; `Off`, `BlueTeam`, `OrangeTeam`,
  `Individual`, `Team`, `UnlimitedLives`, `Easy` and `Normal` are the spec's
  option names and are what the editor writes if you pick them.
- **How Allowed Weapons spells its weapons.** No export to hand has ever
  carried an `AllowedWeapons` value. It is taken to share the holsters' spelling
  above, being the same kind of control in the same dictionary listing the same
  weapons under the same screen names, but nothing has been seen to confirm it.
- **What a flags field emptied to nothing writes.** `None` is an option the
  rules screen offers on the holsters and on Allowed Weapons, so it serialises
  as something; `src/rules.js` writes `"None"`, and an empty string is the other
  candidate if that turns out not to load.
- **Whether Survival's game duration defaults to something other than 5m.** The
  game keeps a separate `GameSurvivalDurationRule.asset` — a second instance of
  `GameDurationRule`'s class, which is what a differently configured default
  would look like — and the `Rules Examples` export wrote 240 there against 360
  in the other four modes while nudging every other number by exactly one
  stepper step, which points at 3m. The spec says 5m for every mode and that is
  what the editor shows. `fallbacks: { GameDuration: 180 }` on the Survival mode
  in `src/rules.js` is the whole change if the rules screen ever settles it.

## `anchors`

```json
{"$type":"MetaGroupSpatialAnchor","guid":"...","groupGuid":"...","positionOffset":{...},"rotationOffset":{...}}
```

Meta shared spatial anchors — runtime headset data tying the map to a physical
room. `$type` implies other anchor subclasses exist. The editor passes these
through untouched; it does not invent them.

## `mapObjects`

```json
{"$type":"MapObject","type":"Crate","position":{...},"rotation":{...},"scale":{...}}
```

- `type` is the contract with the game. Everything else the editor knows about
  an object (size, pivot, mesh) is local metadata.
- `position` is **Unity** coordinates: left-handed, Y up, metres, origin at the
  centre of the arena floor.
- `rotation` is Euler **degrees** in `[0, 360)`, applied in Unity's Z→X→Y order.
- `scale` multiplies the base mesh.

### Subtypes

Four `$type` values carry extra fields, written **between `$type` and
`type`**. Key order is part of the format: get it wrong and an untouched map
stops re-exporting byte for byte.

| `$type` | Extra keys | Values seen |
|---|---|---|
| `WeaponSpawnPoint` | `specificWeapon` | `Handgun`, `SMG`, `Shotgun`, `Sniper`, `RPG`, `Grenade`, `Flashbang`, `RiotShield`, `Healthpack`, `All` |
| `DamageBox` | `style` | `Red` (`DamageBox`), `Blue` (`DamageBoxTeam1`), `Orange` (`DamageBoxTeam2`) |
| `EnemySpawnPoint` | `enemyTypes`, `behaviour` | `All`; `Default`, `Aggresive` *(sic)*, `Stationary` |
| `CustomMessage` | `content`, `showInGame` | any string; `true` / `false` |

`behaviour` really is spelled `Aggresive` in the files. It is written back
exactly as it came.

`showInGame` is the one extra field that is **not a string**: it is a real JSON
boolean, written bare. `content` is the text on the sign, and it is the only
place in the format where a player's own words end up in the file, so it is the
only string that can carry anything needing escaping.

### `CustomMessage`

A flat pane with a line of the author's text on it. `showInGame` false keeps it
in the map and out of the game — a note to whoever is building it.

The prefab carries **no mesh at all**: its whole visual is a Unity canvas built
at runtime, so the files carry the furniture and nothing else. What
did survive settles the geometry anyway. The `Outline` box is 1 × 1 × 0.1, the
`Collider` is 1 × 1 × 0.01, and the `Manipulator` has handles at ±0.5 in X and
Y and **none in Z** — so the unit is a one metre square, the pane is a
centimetre thick, and the game resizes it in two axes rather than three. Every
message in `test/fixtures/maps/text example_*` is scaled exactly 1 in Z and
varies in the other two, which is the same fact from the other direction.

Rotation is free: the reference messages are tilted about X as well as turned
about Y, which is what a sign angled down towards a player looks like.

The list of values above is what has been observed, not necessarily the whole
enum, so the parser collects **any** key that is not one of the five base keys
and writes it back in place. A field added by a future game update survives a
round trip without this module knowing it exists.

### `enemyTypes`

A set of thirteen, written **comma-separated with no spaces**, or `All`.
`reference/Library/Enemies_*` holds one spawner with every type but the handgun
and one with the handgun alone:

```json
"enemyTypes":"SMG,Shotgun,Sniper,HandgunShield,Drone,Helicopter,RPG,CorruptedSMG,CorruptedShotgun,CorruptedSniper,CorruptedHandgun,CorruptedRPG"
"enemyTypes":"Handgun"
```

Three things worth stating outright, because the spawner prefab suggests
otherwise on all three:

- **The separator is a comma**, not the semicolon the rule sets use for their
  flags. Same file, two serialisers.
- **The names are not the prefab's node names.** The in-VR toggles are
  `BotToggle_SMGCorrupted` and `BotToggle_Chopper`; the file says
  `CorruptedSMG` and `Helicopter`. The prefab's `MapEditorUI` children are the
  ones that match. Where they disagree, the file wins.
- **The order above is the game's**, and is neither of the prefab's two
  orderings. `src/packs.js` reproduces it so a spawner the editor rewrites looks
  like one the game wrote.

The one gap is where `Handgun` sits, since the export listing the other twelve
is the one with the handgun taken out. It is placed after `Sniper`, because the
Corrupted block — which is complete — runs SMG, Shotgun, Sniper, Handgun, RPG,
and the plain block is that same run with HandgunShield, Drone and Helicopter
inserted before RPG. Immediately before `RPG` would fit equally well; only a set
holding `Handgun` *and* several others would tell them apart.

The assets also hold a figure of each of them, `<Enemy>BotSpawner.glb`, which
is what the editor stands on a spawner pad. `EnemySpawnPoint.glb`'s own
`BotPreview` node is empty — the game instantiates that figure at runtime — and
its `HandgunBotSpawnerHologram` is a shell of the *pad*, not a bot: 1.08 × 0.30
× 1.08 against the pad's 1.06 × 0.29 × 1.06.

### Pivots

Consistent across all 198 objects in the reference exports: props
(`Crate`, `Barrier*`, `DestructibleCrate`, `*ElectricityBox`, every themed
prop, and every gameplay and objective marker) have their origin **at the
base**, so a grounded piece sits at `y = 0`. Primitives (`BoxSolid`,
`CylinderSolid`, `WallSolid`), the boundaries and `Tunnel` have their origin
**at the centre**, so a grounded piece sits at `y = height × scale.y / 2`.

Checking `base_y = pivot === 'center' ? y - h·s.y/2 : y` gives exactly `0.000`
for every object that is not deliberately tilted or mounted in the air — the
free-rotated `BoxSolid` and its boundary twin `Box`, the `DamageBox` volumes
(placed at ~90° about X), the `CustomMessage` signs, and the wall-mounted
`Jumbotron`.

This has a consequence for the editor's placeholder meshes: **Drop to floor**
lowers a selection until its bounding box rests on `y = 0`, so a placeholder
whose geometry misses the floor by a centimetre would shift the object it
stands for and write that shift into the exported map. `geometryFor` therefore
normalises every placeholder to sit exactly on the cell floor.

### The `Grounded` suffix

`BoxSolid` vs `BoxSolidGrounded` and `CylinderSolid` vs
`CylinderSolidGrounded` have identical pivots and geometry. Across all eleven
themed packs the non-`Grounded` box is the only object with free X and Z
rotation, and the only one placed in mid-air, so the working assumption is
that `Grounded` variants are constrained to the floor and to yaw.

The game's own assets support that reading, without quite closing it:

- Measuring `BoxSolid.glb` against `BoxSolidGrounded.glb` confirms the meshes
  really are identical — both exactly 1 m cubes with a centre pivot. Whatever
  the suffix changes, it is not the geometry.
- The definitions include a `TransformerSettings` class of 27 assets, and
  `BoxTransformerSettings` and `BoxGroundedTransformerSettings` are two of
  them, as are `CylinderTransformerSettings` and
  `CylinderGroundedTransformerSettings`. So the game holds a separate
  *transform* profile for the grounded variant of exactly the two types that
  have one — which is what "constrained differently when you move it" would
  look like. There is no `WallGroundedTransformerSettings`, consistent with the
  wall always being grounded.
- The library icons differ in the same direction: `Icon_BoxSolid_grounded` and
  `Icon_CilinderSolid_grounded` draw the object standing on a floor grid, while
  the plain variants are drawn floating with no grid.

What the suffix means to the game is still **unconfirmed**, because the
`TransformerSettings` assets are empty stubs (see *The game assets* below)
and the values inside them cannot be read.

The web editor offers only the plain solids: the VR editor needs the grounded
variants because there is nothing to snap to in there, whereas here the grid
does that job. The grounded types stay in the catalog marked `hidden`, so a map
that already uses them loads, displays and re-exports unchanged.

### Boundaries

**Invisible walls.** Five types, and they are the solid primitives' names with
`Solid` taken out:

| Type | Same as | Pivot | Placed at |
|---|---|---|---|
| `Box` | `BoxSolid` | centre | `1, 1, 1` |
| `BoxGrounded` | `BoxSolidGrounded` | centre | `1, 1, 1` |
| `Cylinder` | `CylinderSolid` | centre | `0.5, 2, 0.5` |
| `CylinderGrounded` | `CylinderSolidGrounded` | centre | `0.5, 2, 0.5` |
| `Wall` | `WallSolid` | centre | `2, 2.5, 1` |

The game gives them collision and does not draw them, which is what makes them
the AR half of the library: a boundary over the real coffee table is cover you
can throw a grenade against, and one along the real sofa is a wall you can hide
behind, without a virtual object standing in the room.

**Confirmed from a map the game wrote** — `test/fixtures/maps/Example Map 1_*`
holds one of each — and the prefabs say the same thing three ways:

- `Box.glb`'s visible mesh wears a material called
  `ProximityWarning_AlphaZero_PVP`. Zero alpha.
- `Cylinder.glb`'s is named `InvisibleCylinder` outright.
- The library icons are the unused `*Transparent` set —
  `Icon_BoxSolidTransparent`, `Icon_CylinderTransparent`,
  `Icon_WallSolidTransparent` and the two grounded ones — each drawn as a glass
  box with a standard lamp inside it.

Geometry, pivots and default scales are the solid primitives' exactly, and the
reference map corroborates all three the same way it did for the solids: its
`Wall` sits at `y = 1.25` with `scale.y = 2.5`, its `CylinderGrounded` at
`y = 1` with `(0.5, 2, 0.5)`, its `BoxGrounded` at `y = 0.5` with
`scale.y = 1`. A centre pivot puts those on the floor only if the unit mesh is
one metre.

There is no `WallGrounded`, which is the same gap the solid wall has, and no
themed variant of any of them: a boundary has no colour to theme. The grounded
pair is `hidden` for the same reason the solids' pair is.

Two things worth knowing before drawing one. Each prefab carries **two**
visuals — the invisible one the game draws in the room, and a wood-textured
`RemoteVisual` from the Wild West theme for a spectator watching from outside
it — so a naive merge paints every invisible wall with wood grain; the catalog's
`keepParts` keeps only the first. And the invisible material brings neither a
texture nor a colour, so `displayMaterial`'s existing rule hands it the
catalog's tint without any special case.

### Weapon spawners and `specificWeapon`

A `WeaponSpawnPoint` carries one prop saying what it may produce. Every spawner
in every reference export names exactly one weapon — `Handgun`, `Sniper`, or
the shorthand `All` — so those values are confirmed.

**More than one weapon per spawner is inferred, not confirmed.** Two things say
a spawner can hold a set: the rule sets carry a `SingleWeaponPerSpawner`
boolean, which would be meaningless if a spawner could only ever hold one, and
the game describes a spawner with no restriction as `All` rather than listing
everything. What is *not* known is the separator, because nothing the game
wrote shows two.

The editor writes them comma-joined — `"Shotgun,Sniper"` — by analogy with
`enemyTypes`, which is the same idea on the same kind of object and *is*
confirmed: an export listing twelve enemy types uses a bare comma with no
spaces. It deliberately is **not** the semicolon the rule sets use for their
flags (`"WeaponSource":"Spawners;Holsters"`); that turned out to be a different
serialiser with its own separator, which is exactly why one field cannot settle
another. If a two-weapon spawner turns out not to load in game,
`LIST_SEPARATOR` in `src/packs.js` is the single line to change.

The blast radius is small by construction: untouched objects are written back
from their original bytes, so this can only reach spawners the user edits, and
ticking every weapon collapses back to `All` rather than spelling the set out.

### Reading the shape of a prefab

`npm run measure-prefabs` answers how big a prefab is, from the accessor
`min`/`max` alone and without decoding a vertex. `npm run trace-prefabs` answers
what shape it is: it decodes the actual triangles and reports the silhouette on
each plane band by band, the openings cut through it, and cross-sections through
its middle — all in metres.

That second tool exists because `src/placeholders.js` has to stand in for the
art in the open-source build, and a stand-in that misses the hole in a barrier
is not standing in for much. **It reports numbers and converts nothing.** A
builder is then written from those numbers out of boxes and cylinders, which is
a measurement of the artists' work in the same sense the `size` field is —
unlike voxelising the mesh and shipping the voxels, which would not be. Nothing
under `src/` contains mesh data.

Two things it cannot help with. `CaptureFlagSpawnPointTeam1` and `Team2` hold
**no meshes at all** — a node hierarchy and UI, with the flag built at runtime —
and no other prefab has flag geometry either. And
`StreetStylePigeon`'s body is a skinned mesh the export dropped, leaving only
its hologram shell, which is a couple of centimetres proud of the bird.

The tool also settles which themes genuinely differ. Clustering the traced
silhouettes puts the 173 catalog entries on 71 shapes: the primitives really are
one mesh across all eleven themes, while the window barrier has four distinct
forms — a small centred hole, a wide low one, a full-width letterbox, and a tall
opening — and the U barrier's notch is open at the top rather than being a hole.

Four of those 71 are not traced from anything. The three boundaries are
deliberately plain — the game's own invisible meshes are a bare cube, cylinder
and slab, with none of the bevels and end caps the solid versions carry — and
`CustomMessage` has no mesh anywhere to trace.

### Base mesh dimensions

The map file only stores scale multipliers, so real mesh sizes cannot be
recovered from it. Anything still marked `uncertain` in `src/packs.js`, and `~`
in the library, is an estimate.

**The primitives are confirmed from the map files themselves.** Across all
eleven themed packs, `CylinderSolid` is always at scale `(0.5, 2, 0.5)` with
`y = 1`, `BoxSolidGrounded` always has `scale.y = 1` with `y = 0.5`, and
`WallSolid` always has `scale.y = 2.5` with `y = 1.25`. A centre pivot puts all
three exactly on the floor only if the base mesh is one metre tall. So for
these, **the Unity scale is literally the size in metres** — a solid cylinder
at `(0.5, 2, 0.5)` is 0.5 m across and 2 m tall.

**The Default pack is now measured rather than estimated.** The prefab meshes
ship as `Prefabs/*.glb`, named after the map type string, and
`npm run measure-prefabs` reads the bounding box out of the POSITION accessors.
The barriers turn out to be 2 m tall rather than the 1.4 m estimated, and the
crates 0.5 m rather than 0.6 m. Two traps are worth recording.

*Most of a prefab is not the object.* Every one carries editor furniture beside
its mesh: a `Manipulator` of drag handles, a `*Hologram*` shell a couple of
centimetres proud of the surface, `Collider` proxies, an `Outline`, and LOD1+
copies that measure slightly smaller than LOD0 because they are simplified.
Measuring the whole prefab makes every primitive 1.25 m — the drag handles
stand 0.125 m off each face — which flatly contradicts the one metre confirmed
above. `BoxSolid`'s actual `SolidCubeModel` is exactly ±0.5.

*A prefab's bounding box is not always where the object stands.*
`measure-prefabs` reports the pivot as `base`, `center` or `offset`, and the two
player spawn zones come back `offset`: their `SpawnZoneArea` is a one metre cube
centred on the origin, running `y = -0.5 .. 0.5`, while every other part of the
prefab — corner beacons, edge links, the machine — sits at `y = 0`. That cube is
a volume marker rather than a solid, so `src/packs.js` flattens it to a 10 cm
translucent slab on the floor and takes the measured height less the half metre
it used to add: 2.363 m for Team 1, 2.399 m for Team 2, which is the machine.
Nothing about the file depends on this — the game's own stretcher offers only
`PosX`, `NegX`, `PosZ` and `NegZ` handles and every zone in the exports is
scaled `y = 1` exactly.

*The mesh and the unit the game scales are not the same thing.* For a
floor-resting object with a centre pivot the map files settle the unit exactly,
and it is 1 m; but the meshes measure a little off it, because the art overhangs
the unit. The solid wall's corner frames stand proud at 1.069 × 1.019, and the
cylinder's bevelled caps bring it in to 0.993. `src/packs.js` therefore keeps
the confirmed 1 m for those axes and takes the measured box everywhere a `base`
pivot makes the height irrelevant to placement. The one number the measurement
genuinely settles for a primitive is `WallSolid`'s thickness, which nothing in
the map files pins down: it is 0.125, not the 0.1 previously guessed.

### Default placement scale

The reference exports were made without changing the scale of anything except
the solid box, cylinder and wall, which are sized as you drag them out in VR.
Every other object's scale in those files is therefore the game's own default,
and the editor places at exactly that: `1, 1, 1` for most things, `1, 2, 1` for
`Tunnel`, `0.5, 2, 0.5` for the solid cylinder, `0.9, 0.9, 0.9` for `Minigun`,
`1.2337` uniform for `MYKEABarrierWindow`, `0.9195` uniform for
`DarkCrystalCircle`. The last two look like mistakes but are reproduced
faithfully; if they turn out to be player edits after all, the fix is one
`defaultScale` per entry.

### Default placement rotation

Everything is placed square to the grid, with one exception. Camo's `CamoCrateBig`
and Graffiti's `GraffitiCrate` are the same long box — 1.187 × 0.556 × 0.55 and
0.522 × 0.519 × 1.028, which is that box a quarter turn round — but the game
models the first down X and the second down Z. Left alone, the two lie across
each other on the floor, and swapping a map between the two themes turns every
one of them.

`src/packs.js` records the difference as `shapeYaw: 90` on the Graffiti entry,
which is a fact about the mesh rather than about the map. The editor places that
crate at 90° so it lies like its opposite number, and a Replace, a theme swap or
a themed mirror between the two adds the difference to the rotation rather than
copying it — so the crate keeps its footprint and comes back to its original
angle if it is swapped back. Nothing else in the catalog carries the field.

## `navCloud`

**This is the player's physical room, not a navmesh built from map geometry.**

| Field | Sample | Meaning |
|---|---|---|
| `position` / `rotation` | zero | Placement of the grid |
| `size` | `35.0 × 35.0` | Metres covered |
| `divisions` | `141 × 141` | Grid points, so 0.25 m spacing |
| `encodedPoints` | base64 | gzip of one byte per point, `0` or `1` |

Decoded, the sample is 19 881 bytes (141 × 141) with 1 281 ones forming a clean
disc centred on the origin. Solving the boundary gives a radius between
5.031 m and 5.056 m — a real room-scale guardian boundary, roughly 10 m across.

Index layout is `row * width + col` with `col` along X and `row` along Z, world
position `(i - (n-1)/2) × 0.25`. The disc in the original sample is symmetric
and settled nothing, but `Example Map 1` and `Example Map 2` do: both were made
in a headset by scattering crates and walking a rough boundary round them, so
the mask and the objects are two measurements of one arrangement. Under this
layout every crate in both maps sits 5 or 6 cells inside the edge — a near
constant 1.3 m margin, which is what "walked round them" looks like. Transposed
it puts a crate outside the mask, and mirrored front to back the margins fall
apart, ranging from 0 to 9.

Note the play space (10 m disc) is much larger than `mapBoundsSize` (7 × 7).
The arena sits inside the room.

### Two fields the editor now reads

These used to be the obvious suspects for a grid that lands in the wrong
place after a map has been realigned in a headset — recorded here because that
symptom took a while to track down to `src/scene.js` ignoring them.

- **`position` and `rotation`.** Loading a map in the headset asks the player
  to align it with their own room, and a realignment is exactly what writes a
  value into those two fields. `setNavCloud` in `src/scene.js` now sets
  `navGroup`'s own position (via `convertPosition`) and yaw from them, and
  `_renderNavMask` / `_paintNavAt` work in that group's local space rather than
  in world space — so a grid that arrived off-centre or turned stays exactly
  that way, and a brush stroke lands in the same cell the outline is drawn in.
  Only yaw is applied; the format has never carried a tilted floor mask.
- **The 0.25 m spacing** is still `NAV_SPACING` as a fallback for a
  degenerate one-point-wide grid, but `setNavCloud` otherwise derives it per
  axis from `size / (divisions - 1)`, so a grid recorded at another scale, or
  with unequal `divisions.x` / `divisions.y`, draws and paints correctly.
  `buildNavMask` (used only by the Fill tool's Circle/Rectangle presets, which
  always build a fresh 141×141 grid at 0.25 m) still assumes a square grid at
  the hardcoded spacing — that one is a deliberate match to what the Fill tool
  always produces, not the same gap.

## The game assets

`reference/GameAssets/` holds the game's own art and definitions, provided by
the developers with permission to ship them with this editor. It is gitignored
and is not needed to build or run the editor; it is evidence, and the tools that
read it live in `tools/`. Nothing in this section changes the file format — it
is here because it is where several of the answers above came from, and because
one of its limits is worth knowing before trusting it.

### The definitions carry no fields

`Definitions/` holds 1 161 `.asset` files, the game's ScriptableObjects. **Every
one is an empty stub.** Each is the same 14 lines of MonoBehaviour header, and
the only two things that survived are `m_Name` and the `m_Script` GUID; the
serialised fields are absent, because the IL2CPP build ships no type tree for
the game's own scripts.

So display names, categories, prefab references, icon references, the rule set
defaults and the insides of the `TransformerSettings` assets are **not
recoverable from these files**. `npm run read-definitions` reports what is there
and re-checks the stub claim on every run, so a fuller set would announce itself
rather than being silently ignored.

What does survive is still useful:

- **The roster.** Grouping by script GUID picks out 174 map object definitions,
  which is the full library the game ships.
- **Type strings, once corroborated.** A definition's asset name is not the map
  type string. The Default set is named `Default<Thing>` while the game writes
  the bare `<Thing>` — except `DefaultElectricityBox`, which keeps its prefix.
  The tool confirms each one against the reference maps rather than assuming
  the rule, and the crystals show why: their definitions are `Crystal01..03`
  and `CrystalDark01..03` where the map files say `CrystalCircle`,
  `CrystalHalfCircle`, `CrystalSmall` and the `Dark` variants.
- **Prefabs and sprites by name.** `Prefabs/*.glb` are named after the map type
  string, exactly, for 13 of the Default pack's 14; the exception is the
  electricity box, whose mesh is `ElectricityBoxDefaultVisual.glb`.

### The theme system

Object names decompose into a theme prefix and one of 14 base types. Four
themes carry all 14 — `Default`, `Blue`, `Orange`, `Purple` — and six carry a
subset: `MYKEA`, `Camo` and `Graffiti` 11 each, `HatchetCorp` and `Paintball`
10, `WildWest` 9. Each theme drops the base types it has no art for and adds
its own (`GraffitiPigeon`, `WildWestCacti`, `MYKEASofa`, `HatchetCorpPillar`).

Two things are worth noting before treating "theme" as a uniform mechanism:

- There are only five `MapObjectTheme_*` assets — `CorruptedTechnology`,
  `Graffiti`, `HatchetCorp`, `Paintball`, `WildWest`. The colour themes and
  `Camo` and `MYKEA` have none, so whatever a `MapObjectTheme` is, it is not
  the thing that defines every pack.
- `CorruptedTechnology` has an asset but no prefixed objects. Its members are
  the bare-named campaign props — `CenterStationCPU`, `Server`, `Tank`,
  `Recuperator`, `Crystal01` — which is why that pack's type strings look
  unlike every other pack's.

The art-side names are their own vocabulary and do not match the type strings:
`Camo` is `Military` in the icons, and `HatchetCorp` is `HatCo`.

### Icons

`Sprite/*.json` carry a packed rect, `Textures/sactx-*.png` are the packed
sheets, and `SpriteAtlas/*.json` says which sheets belong to which atlas.
`npm run slice-icons` cuts 763 of the 772 sprites out into
`reference/GameAssets/Icons/`; the nine it skips are UI chrome whose source
texture is not among them. Three details govern whether the result is correct:

- **The Y axis is flipped.** Unity rects are measured from the sheet's
  bottom-left, PNG rows run top-down. Getting this wrong yields a
  plausible-looking crop of a neighbouring icon rather than an obvious error.
- **Nothing maps a texture PathID to a filename.** A sprite names its sheet by
  PathID only. An atlas lists the PathIDs of its own pages and the pages are on
  disk as `sactx-<n>-...`, so the nth-lowest PathID is page n. Every one of the
  633 packed sprite rects fits the page that rule assigns, including the three
  atlases whose last page is half-height and would catch a misordering.
- **`m_Name` is not unique.** Five distinct sprites are all called
  `Icon_BoxSolid`, one per theme, and `LabRats_Briefing` and `Labrats_Briefing`
  differ only in case, which on Windows is not a difference at all.

### Matching the whole library

`npm run match-assets` ties all 178 catalog entries to a prefab, a texture and
an icon, and says how each was reached so a guess never passes as a fact. All
178 resolve to a prefab and an icon; 170 resolve to a texture, the other eight
being objects whose GLB embeds no image at all (the damage boxes, the jumbotron,
the flag spawns, the pigeon, the MYKEA sofa).

Textures are the one part that is not name-matched. A GLB embeds its images in
the BIN chunk with no filename attached, so each embedded PNG is hashed and
looked up against a hash of every file in `Textures/` — an identity rather than
a resemblance. Only base-colour maps are embedded; the `_Normal` and `_ORM`
siblings sitting beside them in `Textures/` have to be reached through the
material name instead.

Prefab names need four theme rewrites (`MYKEA`→`Indoor`, `Graffiti`→
`StreetStyle`, `HatchetCorp`→`HatCo`, `Paintball`→`PaintBall`), a rule for the
colour themes, which reskin the Default meshes as `Default<Base><Colour>Visual`,
and a table for the rest. Some of that table had to be settled by measuring,
because the names actively mislead: MYKEA's `IndoorBarrierUVisualCouch` is a
2 m barrier panel rather than the sofa it sounds like, the sofa is the 1.66 m
`IndoorBarrierGroundedVisualCouch`, the cushion is a 1.0 × 0.17 × 0.5 mat, and
the ottoman is a 0.5 m cube called `IndoorCover1x1`. Ten entries remain
**reasoned rather than read** and are listed as `inferred` by the tool — chiefly
the crystals, where the art numbers them `01..03` and the type strings describe
them, with nothing in the assets linking the two. `Small` is settled by
footprint;
`Circle` against `HalfCircle` only by which is rounder.

The icon names are their own vocabulary too, and cannot be derived from the
type string. `Icon_BarrierNormal` is `BarrierFull` and `Icon_BarrierUWall` is
`BarrierU`. Both `Cilinder` and `Cylinder` spellings appear, and they are two
different icon sets rather than a typo to normalise: `Cilinder` belongs to the
512 px photographic renders in `ItemIconsAtlas`, which is the set the library
uses, and `Cylinder` to a 256 px schematic set in `SolidIconsAtlas` that holds
one variant per theme. The `icon` field in `src/packs.js` was picked by eye
from the sliced PNGs.

Because this is captured hardware data, the editor preserves it byte-for-byte
by default and only regenerates it if you explicitly pick a new shape.
