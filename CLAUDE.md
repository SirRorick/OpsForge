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

Base mesh dimensions in `src/catalog.js` marked `uncertain: true` are
**estimates**. Map files only store scale multipliers, so real mesh sizes cannot
be recovered from them. Do not present these as fact, and do not tune other code
to compensate for them. Replacing them with real numbers or `.glb` files via the
`model` field is the fix.

Also unconfirmed: what the `Grounded` suffix means, what the `ruleSets` value
dictionaries hold, and the row/column axis order in the nav cloud grid (the
fixture mask is symmetric, so it cannot be settled from that file alone).
See `docs/FORMAT.md`.

## Layout

```
src/format.js       parse and serialise map files, GUIDs, nav cloud codec
src/unity.js        Unity <-> three.js conversion  (no three.js import — keep it that way so it stays testable)
src/catalog.js      pack schema and the built-in Default pack
src/placeholders.js procedural stand-in geometry
src/scene.js        viewport, selection, gizmos, marquee picking
src/app.js          UI, history, file I/O
test/               node:test suites, no dependencies
build.mjs           bundles src/ into dist/
serve.mjs           local dev server
```

`src/format.js`, `src/unity.js` and `src/catalog.js` must stay free of three.js
imports so the tests can run headless.

## Adding a pack

Packs are data. Add a JSON file to `packs/`, list it in `packs/index.json`, and
add nothing else — no code changes. Unknown types must keep loading as pink
markers and exporting unchanged, so a missing pack can never corrupt a map.

## Known untested area

The three.js layer has never run. It was written without a browser available, so
gizmos, marquee picking, drag-and-drop placement, the library thumbnail
renderer, and the `TransformControls.getHelper()` version shim are all
unexercised. Everything under `test/` is verified; everything touching WebGL is
not. Start there.

## Windows notes

The toolchain is Node-only so every command works the same in PowerShell as it
does in a shell. Do not reintroduce Python scripts or shell-specific syntax in
`package.json`.

`.gitattributes` normalises line endings to LF and marks `test/fixtures/**` as
binary. That fixture is compared byte for byte by the format tests, so any
line-ending translation would break them. Leave those rules alone.
