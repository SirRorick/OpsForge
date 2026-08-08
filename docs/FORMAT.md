# Spatial Ops map file format (v4)

Reverse engineered from a single v4 map file. Everything here is verified
against that file unless marked **unconfirmed**. Corrections welcome.

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

Five entries in the sample, one per game mode, each with four empty
dictionaries:

```json
{"name":"Free For All","type":"FreeForAll","intValues":{},"boolValues":{},"enumValues":{},"flagsValues":{}}
```

Types seen: `FreeForAll`, `Survival`, `TeamDeathMatch`, `CaptureTheFlag`,
`Domination`. The dictionaries are presumably per-mode overrides
(score limits, timers, and so on) — **unconfirmed**, since all four are empty
here. The editor passes them through untouched.

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

### Pivots

Derived from the sample and consistent across all 14 objects: props
(`Crate`, `Barrier*`, `DestructibleCrate`, `DefaultElectricityBox`) have their
origin **at the base**, so a grounded piece sits at `y = 0`. Primitives
(`BoxSolid`, `CylinderSolid`, `WallSolid`) and `Tunnel` have their origin **at
the centre**, so a grounded piece sits at `y = height × scale.y / 2`.

Checking `base_y = pivot === 'center' ? y - h·s.y/2 : y` against the sample
gives exactly `0.000` for thirteen of fourteen objects. The exception is the
single `BoxSolid`, which is the one object with non-zero X and Z rotation —
i.e. deliberately thrown in the air.

### The `Grounded` suffix

`BoxSolid` vs `BoxSolidGrounded` and `CylinderSolid` vs
`CylinderSolidGrounded` have identical pivots and geometry in the sample. The
distinction is **unconfirmed**. Both non-`Grounded` samples are the only
free-floating and freely-rotated pieces, so the working assumption is that
`Grounded` variants are constrained to the floor and to yaw-only rotation. The
editor encodes this as `rotationAxes` and `floor` in the pack, both trivially
editable.

### Base mesh dimensions

**All unconfirmed.** The file only stores scale multipliers, so the real mesh
sizes cannot be recovered from it. The catalog's `size` values are estimates
chosen to look plausible against the observed scales — for example `WallSolid`
appears at scale `(1.24, 2.5, 1.0)`, which reads as a 1.24 m × 2.5 m wall only
if the base mesh is about 1 × 1 × 0.1 m. Replacing these with real numbers, or
with `.glb` files, is a one-line change per object.

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

Because this is captured hardware data, the editor preserves it byte-for-byte
by default and only regenerates it if you explicitly pick a new shape.
