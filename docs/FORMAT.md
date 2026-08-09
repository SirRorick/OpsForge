# Spatial Ops map file format (v4)

Reverse engineered from fourteen v4 map files exported out of the in-game
editor — one per library group, one per object theme, and one with every rule
set option deliberately changed. They live in `reference/`. Everything here is
verified against those files unless marked **unconfirmed**, and the test suite
re-exports all fourteen byte for byte on every run. Corrections welcome.

## The file itself

- **No extension.** The name is `` `${name}_${guid}` `` — e.g.
  `Default_f1d7dd74461f492aa897773d77451a78`.
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

All 61 distinct float literals in the sample are reproduced exactly by the rule
above; see `src/format.js`.

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

Five entries, one per game mode. Types seen: `FreeForAll`, `Survival`,
`TeamDeathMatch`, `CaptureTheFlag`, `Domination`. Most maps have four empty
dictionaries per mode:

```json
{"name":"Free For All","type":"FreeForAll","intValues":{},"boolValues":{},"enumValues":{},"flagsValues":{}}
```

**An empty dictionary means "every setting is at the game's default", not
"nothing is set".** The game only serialises settings that were changed. This
is confirmed by a second export made with every setting deliberately moved off
its default, which produced a full set of keys:

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
a semicolon-joined set. `src/rules.js` holds the full per-mode key list; the
editor writes a key only once you change it, and clearing a field removes the
key again rather than writing a zero.

**Unconfirmed:** the defaults themselves, the valid range of every number, and
the full option list for each enum. One export only shows the values it
happens to use, so the editor does not clamp numbers and treats the enum
options it knows as suggestions rather than a closed list.

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

Three `$type` values carry extra fields, written **between `$type` and
`type`**. Key order is part of the format: get it wrong and an untouched map
stops re-exporting byte for byte.

| `$type` | Extra keys | Values seen |
|---|---|---|
| `WeaponSpawnPoint` | `specificWeapon` | `Handgun`, `SMG`, `Shotgun`, `Sniper`, `RPG`, `Grenade`, `Flashbang`, `RiotShield`, `Healthpack`, `All` |
| `DamageBox` | `style` | `Red` (`DamageBox`), `Blue` (`DamageBoxTeam1`), `Orange` (`DamageBoxTeam2`) |
| `EnemySpawnPoint` | `enemyTypes`, `behaviour` | `All`; `Default`, `Aggresive` *(sic)*, `Stationary` |

`behaviour` really is spelled `Aggresive` in the files. It is written back
exactly as it came.

The list of values above is what has been observed, not necessarily the whole
enum, so the parser collects **any** key that is not one of the five base keys
and writes it back in place. A field added by a future game update survives a
round trip without this module knowing it exists.

### Pivots

Consistent across all 178 objects in the reference exports: props
(`Crate`, `Barrier*`, `DestructibleCrate`, `*ElectricityBox`, every themed
prop, and every gameplay and objective marker) have their origin **at the
base**, so a grounded piece sits at `y = 0`. Primitives (`BoxSolid`,
`CylinderSolid`, `WallSolid`) and `Tunnel` have their origin **at the centre**,
so a grounded piece sits at `y = height × scale.y / 2`.

Checking `base_y = pivot === 'center' ? y - h·s.y/2 : y` gives exactly `0.000`
for every object that is not deliberately tilted or mounted in the air — the
free-rotated `BoxSolid`, the `DamageBox` volumes (placed at ~90° about X) and
the wall-mounted `Jumbotron`.

This has a consequence for the editor's placeholder meshes: floor lock drops a
selection until its bounding box rests on `y = 0`, so a placeholder whose
geometry misses the floor by a centimetre would shift the object every time it
is edited and write that shift into the exported map. `geometryFor` therefore
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
`TransformerSettings` assets are empty stubs (see *The game asset dump* below)
and the values inside them cannot be read.

The web editor offers only the plain solids: the VR editor needs the grounded
variants because there is nothing to snap to in there, whereas here the grid
does that job. The grounded types stay in the catalog marked `hidden`, so a map
that already uses them loads, displays and re-exports unchanged.

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

The editor writes them semicolon-joined — `"Shotgun;Sniper"` — because that is
what the game uses for its own multi-valued strings elsewhere in this same file
format: rule set flags are written `"WeaponSource":"Spawners;Holsters"`. That is
a different field though, and a .NET `[Flags]` enum serialised by Newtonsoft
would more likely be `", "`. If a two-weapon spawner turns out not to load in
game, `WEAPON_SEPARATOR` in `src/packs.js` is the single line to change.

The blast radius is small by construction: untouched objects are written back
from their original bytes, so this can only reach spawners the user edits, and
ticking every weapon collapses back to `All` rather than spelling the set out.

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
ship in the asset dump as `Prefabs/*.glb`, named after the map type string, and
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

Index layout is assumed to be `row * width + col` with `col` along X and `row`
along Z, world position `(i - (n-1)/2) × 0.25`. The mask is symmetric, so the
axis assignment **cannot be confirmed** from this file alone; it only matters
if you generate a non-square play space.

Note the play space (10 m disc) is much larger than `mapBoundsSize` (7 × 7).
The arena sits inside the room.

## The game asset dump

`reference/GameAssets/` is an AssetRipper export of the shipped game. It is
gitignored and is not needed to build or run the editor; it is evidence, and
the tools that read it live in `tools/`. Nothing in this section changes the
file format — it is here because it is where several of the answers above came
from, and because one of its limits is worth knowing before trusting it.

### The definitions carry no fields

`Definitions/` holds 1 161 `.asset` files, the game's ScriptableObjects. **Every
one is an empty stub.** Each is the same 14 lines of MonoBehaviour header, and
the only two things that survived are `m_Name` and the `m_Script` GUID; the
serialised fields are absent, because the IL2CPP build ships no type tree for
the game's own scripts.

So display names, categories, prefab references, icon references, the rule set
defaults and the insides of the `TransformerSettings` assets are **not
recoverable from this dump**. `npm run read-definitions` reports what is there
and re-checks the stub claim on every run, so a better export would announce
itself rather than being silently ignored.

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
texture is not in the dump. Three details govern whether the result is correct:

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
them, with nothing in the dump linking the two. `Small` is settled by footprint;
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
