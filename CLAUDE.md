# Spatial Ops Map Editor

A browser-based 3D map editor for the VR game Spatial Ops. Vanilla ES modules
plus three.js from a CDN. No framework, no bundler, no npm dependencies.

## Commands

```sh
npm test        # node --test test/*.test.mjs  — run before every commit
npm run serve   # http://localhost:8000, needed because ES modules don't load over file://
npm run build   # regenerate dist/spatial-ops-map-editor.html from src/
```

Node 18+ is the only dependency. There is no npm install step: the project has
no packages, and three.js is loaded from a CDN at runtime.

`dist/` is generated. Never hand-edit it — change `src/` and rebuild.

## Invariants

These were derived from a real map file and verified by the test suite. Do not
"simplify" any of them; each one is load-bearing.

**Float formatting is .NET Framework `"R"`, not shortest round-trip.**
7 significant digits with trailing zeros trimmed, falling back to 9 when 7 does
not round-trip. This is why the fixture holds both `2.729975` and `2.54036975`.
Modern shortest-round-trip formatting emits `2.5403697` and produces a file the
game did not write. Newtonsoft also always leaves a decimal point on floats
(`0.0`), while int vectors — `mapBoundsSize`, `navCloud.divisions` — stay bare.

**Unity is left-handed, three.js is right-handed.** The conversion is the
reflection `M(x, y, z) = (x, y, -z)`, with rotation becoming
`THREE.Euler(-ux, -uy, uz, 'YXZ')`. Skipping this mirrors the map, which only
shows up on asymmetric pieces like `BarrierCorner`. All of it lives in
`src/unity.js`; do not scatter sign flips through the codebase.

**Untouched objects are written back from their original bytes.** `parseMap`
keeps each map object's source text in `raw`, and `serializeMap` reuses it
unless `dirty` is set. Editing one crate must not perturb any other object.

**Three `$type`s carry extra fields, and their key order is load-bearing.**
`WeaponSpawnPoint` has `specificWeapon`, `DamageBox` has `style`,
`EnemySpawnPoint` has `enemyTypes` and `behaviour` — all written *between*
`$type` and `type`. `parseMap` collects every non-base key into `props`
generically, so a field a future update adds still round-trips. Never rebuild a
map object from `type` alone; that silently turns a shotgun spawner into a
nameless one and the raw passthrough hides it until someone edits the object.
`behaviour` is spelled `Aggresive` in the files. Do not fix the typo.

**Empty rule set dictionaries mean "game defaults", not "nothing set".** The
game serialises only settings changed away from their default, so the editor
writes a key only when the user touches it and deletes the key when a field is
cleared. Writing a full dictionary of current values would bake today's
defaults into the map permanently. See `src/rules.js`.

**Placeholder meshes must rest exactly on the cell floor.** Floor lock drops a
selection until its bounding box sits on `y = 0`, so a placeholder that misses
by a centimetre shifts the object on every edit and writes the shift into the
file. `geometryFor` normalises for this; do not remove that step, and do not
assume a builder got it right by hand.

**The inspector's numeric fields display rounded values.** Reading one back as
if it were typed applies a delta of up to half a display unit to an axis nobody
touched. `applyNumericEdit` compares against the rounded display value and
treats an unchanged field as exactly unchanged. This is why an untouched map
survives select-all plus a no-op edit byte for byte.

**`navCloud` is the player's physical room, not a navmesh.** It is captured
headset data: one gzipped byte per grid point, a ~5 m disc in the fixture.
Preserve it byte for byte unless the user explicitly asks for a new shape.
Never derive it from map geometry.

**Map ids are `Guid.NewGuid().ToString("N")`** — an RFC 4122 v4 UUID as 32
lowercase hex digits, no hyphens. Use `crypto.randomUUID()` and strip the
hyphens; 32 random hex digits would have wrong version and variant bits.
Exported files are named `Name_guid` with **no extension**. That is correct.

**Pivots come from the catalog, not from guessing.** Props use `base` (origin on
the floor), primitives and `Tunnel` use `center`. Verified against the fixture:
every non-airborne object lands at exactly `base y = 0`.

**Multi-object scaling is forced uniform.** A rotated child under a
non-uniformly scaled parent shears, and no position/rotation/scale triple can
represent shear. See `_constrainDuringDrag` in `src/scene.js`.

## What is confirmed vs. guessed

Base mesh dimensions in `src/packs.js` marked `uncertain: true` are
**estimates**. Map files only store scale multipliers, so real mesh sizes cannot
be recovered from them. Do not present these as fact, and do not tune other code
to compensate for them. Replacing them with real numbers or `.glb` files via the
`model` field is the fix.

Confirmed since the reference exports landed: the solid box, cylinder and wall
are **one metre unit meshes**, so their Unity scale is literally their size in
metres. The same scales recur across all eleven themed packs at heights that
put them exactly on the floor, which is what pins this down.

The Default pack no longer estimates anything: its sizes are measured off the
prefab meshes by `npm run measure-prefabs`, which also settles `WallSolid`'s
thickness at 0.125. Two traps make that measurement easy to get wrong, and both
are worth knowing before measuring anything else. Most of a prefab is not the
object — drag handles, hologram shells, collider proxies and lower LODs ship
alongside the mesh, and measuring the lot makes every primitive 1.25 m, which
contradicts the confirmed one metre above. And the mesh is not always the unit
the game scales: the wall's frame overhangs its own unit at 1.069 × 1.019, so
where a map file confirms the unit, the map file wins. See `docs/FORMAT.md`.

`defaultScale` in `src/packs.js` is read off the reference files, which were
made without changing any scale except the box, cylinder and wall. Two values
look odd but are reproduced deliberately: `MYKEABarrierWindow` at `1.2337`
uniform and `DarkCrystalCircle` at `0.9195` uniform.

Still unconfirmed: what the `Grounded` suffix means to the game (the game keeps
a separate `TransformerSettings` asset for the grounded box and cylinder, and
draws their icons standing on a floor grid, which supports the floor-and-yaw
reading without closing it — the assets are empty stubs); the defaults,
ranges and full enum option lists behind the rule set keys (one export only
shows the values it used, so numbers are unclamped and enum options are
suggestions); and the row/column axis order in the nav cloud grid (the fixture
mask is symmetric, so it cannot be settled from that file alone).
See `docs/FORMAT.md`.

## Layout

```
src/format.js       parse and serialise map files, GUIDs, nav cloud codec
src/unity.js        Unity <-> three.js conversion  (no three.js import — keep it that way so it stays testable)
src/rules.js        game mode rule set schema and editing rules
src/packs.js        the 13 built-in object packs, transcribed from reference/
src/catalog.js      pack registry and lookups
src/placeholders.js procedural stand-in geometry
src/scene.js        viewport, selection, gizmos, marquee picking
src/app.js          UI, history, file I/O
reference/          map files exported from the in-game editor — the only
                    evidence for what the game actually writes
reference/GameAssets/  AssetRipper dump of the shipped game (gitignored, and
                    not needed to build or run). Its ScriptableObjects are
                    empty stubs; its prefabs and sprite atlases are not
tools/              read the asset dump: read-definitions, slice-icons,
                    measure-prefabs. None of it is imported by src/
test/               node:test suites, no dependencies
build.mjs           bundles src/ into dist/  (ORDER must match the import graph)
serve.mjs           local dev server
```

`format.js`, `unity.js`, `rules.js`, `packs.js` and `catalog.js` must stay free
of three.js imports so the tests can run headless.

## Adding a pack

Packs are data. The ones the game ships with are built into `src/packs.js` so
the single-file `dist/` build works offline. `packs/` is for anything extra: add
a JSON file, list it in `packs/index.json`, add nothing else. Unknown types must
keep loading as pink markers and exporting unchanged, so a missing pack can
never corrupt a map.

Library entries are keyed by `key`, not `type` — ten weapon spawners share the
type `WeaponSpawnPoint` and are told apart by `props`. Anything caching per
object (thumbnails, geometry) must key on `key`.

## Verification

`npm test` covers the format, the catalog and the rules headlessly, including a
byte-for-byte re-export of all fourteen reference files both untouched and with
every object forced down the float-writing path.

The three.js layer has now been exercised in a browser: all thirteen reference
maps load, get pushed through real meshes with select-all plus a no-op numeric
edit — which marks every object dirty — and re-export byte for byte. That is
the check to repeat after touching `scene.js`, `placeholders.js` or the
inspector, because none of it is covered by `npm test`. Still unexercised:
marquee picking, drag-and-drop placement, the gizmo handles themselves, and the
`TransformControls.getHelper()` version shim.

## Windows notes

The toolchain is Node-only so every command works the same in PowerShell as it
does in a shell. Do not reintroduce Python scripts or shell-specific syntax in
`package.json`.

`.gitattributes` normalises line endings to LF and marks `test/fixtures/**` as
binary. That fixture is compared byte for byte by the format tests, so any
line-ending translation would break them. Leave those rules alone.
