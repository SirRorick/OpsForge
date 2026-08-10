# Spatial Ops Map Editor

A browser-based 3D map editor for the VR game Spatial Ops. Vanilla ES modules
plus three.js from a CDN. No framework, no bundler, no npm dependencies.

## Commands

```sh
npm test        # node --test test/*.test.mjs  — run before every commit
npm run serve   # http://localhost:8000, needed because ES modules don't load over file://
npm run build   # regenerate dist/spatial-ops-map-editor.html from src/

npm run stage-assets  # fill assets/ from reference/GameAssets/
npm run package       # assemble reference/selfhosted/ for a private server
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
`THREE.Euler(-ux, -uy, uz, 'YXZ')`, **and then a half turn about the object's
own Y** (`MODEL_YAW`). Skipping the reflection mirrors the map; skipping the
half turn leaves every object facing backwards. Both only show up on asymmetric
pieces like `BarrierCorner` or a crate's lettering. The half turn was confirmed
in the headset — positions landed where the editor said and the text still read
left to right, so it is a rotation and not a mirror — and it is applied on the
right because a world-side half turn would have moved things as well as turned
them. All of it lives in `src/unity.js`; do not scatter sign flips through the
codebase. `MODEL_YAW` is its own inverse, so it costs a round trip nothing.

**Locking is enforced by keeping an object out of the selection.** Every way to
move, rotate, scale, drop, nudge or delete goes through `vp.selection`, so
`setSelection` filtering out `userData.locked` is the single guard — there is no
operation that could forget about it. The consequence is that unlocking cannot
go through the selection either: `pickAt` ignores the lock so right-click can
reach a locked object, and the outliner's padlock does the same.

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
defaults into the map permanently. Confirmed from both ends: an export made
without touching the rules screen has four empty dictionaries per mode, and one
made with a large subset of settings nudged carries exactly those keys.
`fallback` in `src/rules.js` is display only and must never be written — it
exists so the panel can show what an untouched setting will do. This is also
why numeric ranges bound what the editor *writes* and never what it reads: the
reference export carries a `DominationObjective` of 101 against a stated ceiling
of 100, and clamping on load would rewrite a file the game itself produced. See
`src/rules.js`.

**Rule sets are a list, not a set of five modes.** Two of them may share a base
mode and differ only by name, so they are addressed by position and the order is
part of the file. There is no id field in the format; do not add one.

**There is one build, not two.** The public repository and the private
self-hosted copy run identical code; the only difference is what is sitting in
`assets/`, which is where `ASSET_BASE` in `catalog.js` points.

```
assets/Icons/     library thumbnails, 128 px  — committed (~2.3 MB)
assets/Prefabs/   the game's .glb models      — gitignored, ~418 MB
```

A fresh clone therefore has thumbnails and the stand-in shapes in
`placeholders.js`. A machine that has run `npm run stage-assets` has the game's
models too, and `npm run package` copies that into `reference/selfhosted/` with
a Caddyfile. Do not add a build flag, an environment variable or a second entry
point to tell the two apart — the fallback in `modelUrl`/`iconUrl` already is
the difference, and every asset is optional by design.

`reference/GameAssets/` stays the raw AssetRipper extraction and stays the
source of truth for the tools. `assets/` is only ever generated from it.

**Everything at floor level fights everything else at floor level.** The depth
buffer cannot separate coplanar surfaces, which is what made the grid strobe
against the shadow catcher and the domination rings strobe against both. The
ground layers are stacked in a few millimetres — grid at -0.006, centre cross at
-0.004, shadow plane at -0.002, objects at 0 — and the overlays do not write
depth. Do not move any of them back to zero. And the centre cross is thin quads
rather than lines because WebGL ignores `linewidth` on every desktop driver, so
a line cannot be drawn heavier than the grid it has to stand out from.

**Placeholder meshes must rest exactly on the cell floor.** Floor lock drops a
selection until its bounding box sits on `y = 0`, so a placeholder that misses
by a centimetre shifts the object on every edit and writes the shift into the
file. `geometryFor` normalises for this; do not remove that step, and do not
assume a builder got it right by hand.

**Placeholders are measured from the real prefabs, never copied from them.**
`npm run trace-prefabs` decodes a prefab's actual triangles and prints its
silhouette band by band, the openings cut through it and cross-sections through
its middle, all in metres. A builder in `src/placeholders.js` is then written
from those numbers out of boxes, cylinders and prisms. That distinction is the
point: the numbers are measurements, the way the catalog's `size` is, while
voxelising the mesh and shipping the voxels would be a mechanical derivation of
the artists' work. **Do not import, decimate or convert mesh data into `src/`.**
To change a placeholder, run the tracer and read the numbers.

**An object's origin is not always the middle of its own footprint.**
`seatOnFloor` in `scene.js` corrects only Y for a loaded prefab, so the mesh
keeps whatever X and Z origin the artists gave it — and the ten corner barriers
put theirs in the corner where the two arms meet, 44 cm from the centre of the
box. The catalog's `anchor` carries that as a fraction of the footprint and
`geometryFor` applies it, so the placeholder stands where the real model does.
25 of the 167 entries need one; the rest are `[0.5, 0.5]`.

**The inspector's numeric fields display rounded values.** Reading one back as
if it were typed applies a delta of up to half a display unit to an axis nobody
touched. `applyNumericEdit` compares against the rounded display value and
treats an unchanged field as exactly unchanged. This is why an untouched map
survives select-all plus a no-op edit byte for byte.

**`navCloud` is the ground the bots may walk on** — the editor calls it the bot
grid. One gzipped byte per grid point on a 0.25 m lattice, a ~5 m disc in the
fixture.

This file used to claim it was captured headset room data. That was an
inference from the disc's size and it was wrong: the field is named `navCloud`,
the dump ships a `NewNavCloudValidatorSettings` asset beside it, and the owner
of the map format confirmed it is the walkable grid. Corrected here rather than
quietly, because a fair amount of the editor was built around the old reading.

It is still **preserved byte for byte unless the user paints it.** `setNavCloud`
keeps the decoded mask on the viewport, the brushes edit that in place, and only
a finished stroke re-encodes — so loading a map and exporting it again returns
the same gzip, which is checked in the browser pass below. Never derive it from
map geometry.

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

**Scaling holds the far side, and holds the floor.** TransformControls scales
about the object's origin, which moves both faces at once and lifts a
centre-pivot box off the ground as it shrinks. `_applyScaleAnchor` captures a
point in pivot-local space at drag start — the face opposite the handle, and the
bottom of the selection on any axis that is not being dragged — and shifts the
*children* each frame to keep it still. The children rather than the pivot on
purpose: TransformControls measures the drag against a plane through the gizmo's
own position, so moving the gizmo mid-drag feeds back into the scale it computes.

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

The placeholder shapes are measured too, and no longer guessed. `trace-prefabs`
settled several that had been wrong: `BarrierU`'s notch is open at the **top**
rather than being a hole with a lintel over it, the piece catalogued as
`barrierX` is not a cross but an I-beam pinched to half width through its
middle, `IndoorBarrierCrateVisual` is a 17 cm floor cushion rather than a 90 cm
cube, and `IndoorCover1x1` is a square pouffe on four feet rather than a
cylinder. Where the real meshes genuinely differ between themes the shape is
split — 66 builders across 167 entries, clustered by comparing traced
silhouettes rather than by assuming — and where they do not, one builder serves
them all. The primitives really are identical in all eleven themes.

Two placeholders are **not** traced, and both say so in place. The two capture
flag spawn points contain no meshes at all — nodes and UI only, with the flag
built at runtime — so `flagSpawn` is designed from the library icon.
`StreetStylePigeon`'s body is a skinned mesh the export dropped, leaving only
the hologram shell, so the pigeon's numbers are a couple of centimetres
generous.

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

The thirteen ids in the `ENEMIES` table, and their order, are the game's own,
read off `reference/Library/Enemies_*`. Do not take them from the spawner
prefab's `BotToggle_*` nodes: those say `SMGCorrupted` and `Chopper` where the
file says `CorruptedSMG` and `Helicopter`. Their `icon`s are the weak part —
matched by name against the `filled_Icon_*_silhouette` family, which is the only
one covering drones and the Corrupted variants, and the helicopter borrows a
campaign icon for want of a silhouette at all. `label`, `icon` and `model` all
fall back cleanly, so a row with an `id` and nothing else still loads, exports
and edits; it just draws plainer.

Where `Handgun` sits in that order is the one inference left, since the export
listing the other twelve is the one it was removed from. See `src/packs.js`.

The rule set schema now has all 46 settings, their defaults and their ranges,
from `reference/rules/spatial-ops-rules-spec.md` — a writeup of the in-game
rules screen, and the only record of a single default. Half of it is corroborated
by the exports: 23 keys appear in `reference/Rules Examples_*`, which is what
`confirmed: true` in `src/rules.js` means. The other 23 are derived from the
`*Rule.asset` names in the dump, where **the key is the asset name minus the
`Rule` suffix** — 23 for 23 on the keys an export can check. The `m_Script` guid
groups those assets by class, which is what settles the dictionary for a key no
export ever showed. Two spellings are the game's, not typos:
`ShowSpawnZoneArrowInLobby` has no `Rule` suffix on its asset, and
`WeaponRespawnTimeRiotshield` has a small s where the weapon id is `RiotShield`.

Still unconfirmed: what the `Grounded` suffix means to the game (the game keeps
a separate `TransformerSettings` asset for the grounded box and cylinder, and
draws their icons standing on a floor grid, which supports the floor-and-yaw
reading without closing it — the assets are empty stubs); the literal an enum
writes for an option no export used, and what a flags field emptied to nothing
writes (`None` is what the editor writes); whether Survival's game duration
defaults to 3m rather than the spec's 5m, which the separate
`GameSurvivalDurationRule` asset and the export's 240-against-360 both hint at;
and the row/column axis order in the nav cloud grid (the fixture mask is
symmetric, so it cannot be settled from that file alone). See `docs/FORMAT.md`.

## Layout

```
src/format.js       parse and serialise map files, GUIDs, nav cloud codec
src/unity.js        Unity <-> three.js conversion  (no three.js import — keep it that way so it stays testable)
src/rules.js        game mode rule set schema and editing rules
src/packs.js        the 13 built-in object packs, transcribed from reference/
src/catalog.js      pack registry and lookups
src/placeholders.js procedural stand-in geometry
src/gizmo.js        the combined move/rotate/scale gizmo
src/scene.js        viewport, selection, gizmos, marquee picking
src/app.js          UI, history, file I/O
assets/             what the editor loads art from. Icons committed, Prefabs
                    gitignored — see the one-build note above
reference/          **entirely gitignored** private working directory: the
                    AssetRipper dump, the packaged builds, design notes. Its
                    ScriptableObjects are empty stubs; its prefabs and sprite
                    atlases are not
test/fixtures/maps/ the exported maps the suite verifies against — the only
                    evidence for what the game actually writes, so they live
                    with the tests rather than in the private folder
tools/              read the asset dump: read-definitions, slice-icons,
                    measure-prefabs, trace-prefabs, match-assets. None of it is
                    imported by src/, and none of it ships anything it reads.
                    stage-assets and package-selfhosted build the two payloads
test/               node:test suites, no dependencies
build.mjs           bundles src/ into dist/  (ORDER must match the import graph)
serve.mjs           local dev server
```

`format.js`, `unity.js`, `rules.js`, `packs.js` and `catalog.js` must stay free
of three.js imports so the tests can run headless. `rules.js` must also stay
free of `packs.js`: it is built before it, which is why the weapon ids appear in
both. A test holds the two lists to each other rather than letting them drift.

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
byte-for-byte re-export of all sixteen reference files both untouched and with
every object forced down the float-writing path.

The three.js layer has now been exercised in a browser: all sixteen reference
maps load, get pushed through real meshes with select-all plus a no-op numeric
edit — which marks every object dirty — and re-export byte for byte. That is
the check to repeat after touching `scene.js`, `placeholders.js` or the
inspector, because none of it is covered by `npm test`. Watch the console while
you do it: `mergeGeometries` reports a failed merge there and nowhere else, and
the fallback it takes — the largest single part — looks like art rather than an
error. That is how the spawn machine spent a while drawn as a bare pillar.

Scale anchoring is exercised the same way, by driving `_beginDrag`,
`pivot.scale` and `_constrainDuringDrag` directly: dragging `X` from either side
must leave the opposite face on its original coordinate to the millimetre, and
the uniform `XYZ` handle must leave `box.min.y` at 0. Remember to call
`pivot.updateMatrixWorld(true)` before measuring — `Box3.setFromObject` updates
the object but not its parents, so without it every number is a frame stale.

The rules panel has been exercised the same way, since none of its DOM is
covered by `npm test` either: every conditional row and section toggled from the
control that drives it, a holster taken through All / None / cleared, the last
weapon source refusing to come off, the five list operations, and
`reference/Rules Examples_*` loaded and re-exported with only `editedTime`
differing. Repeat that after touching `buildRules` or `ruleRow`. Loading a file
into the hidden `#filepick` input with a `DataTransfer` is the quick way in.

The placeholders need a browser too, since `npm test` cannot import three.js.
The quick check is a contact sheet: over the dev server, `import('/src/placeholders.js')`
and `import('/src/packs.js')` from the console, call `geometryFor` for all 167
entries, and assert no builder threw, that `box.min.y` is 0 for a `base` pivot
and `-size[1]/2` for a `center` one, and that the console stayed silent —
`mergeGeometries` reports a failed merge there and nowhere else. Rendering each
distinct shape into a grid of small canvases is worth the extra few lines,
because a builder can satisfy every one of those assertions and still be
unrecognisable.

The combined gizmo (`src/gizmo.js`) is checked the same way, and has to be:
none of its maths is reachable headlessly. Build one on a throwaway `<div>` with
a known camera, project each picker's world position to get an exact screen
point, and dispatch real `PointerEvent`s at it — guessing pixel coordinates
picks the wrong handle and silently falls through to selection instead. Assert
both halves: which handle was grabbed (`gizmo.axis`, `gizmo.activeMode`) and
what the object did. Dragging the X arrow must move X alone, the Y arc must
produce a rotation about Y alone, and so on.

**No two grabbable parts of that gizmo may share a radius.** The first version
had the translate handles pickable along their whole shaft, which put them on
top of the rotation arcs at the arcs' own radius, and reaching for a turn got
you a slide. Each band belongs to one kind of handle; the arrows sit outside the
outer ring entirely.

Still unexercised: marquee picking, drag-and-drop placement, and the
`TransformControls.getHelper()` version shim.

## Windows notes

The toolchain is Node-only so every command works the same in PowerShell as it
does in a shell. Do not reintroduce Python scripts or shell-specific syntax in
`package.json`.

`.gitattributes` normalises line endings to LF and marks `test/fixtures/**` as
binary. That fixture is compared byte for byte by the format tests, so any
line-ending translation would break them. Leave those rules alone.
