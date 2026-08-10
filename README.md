# Spatial Ops Map Editor

A visual 3D map editor for the VR game **Spatial Ops**. Runs entirely in your
browser, offline, with no build step and no account. MIT licensed.

Load a map file, drag objects in from the library, move and scale them with
gizmos, set up the game mode rules, and export a file the game can read.

The library mirrors the in-game one: **Virtual Objects** with a pack per theme
(Default, Blue, Orange, Purple, Camo, Mykea, Graffiti, Paintball, Wild West,
Hatchet Corp, Corrupted Technology), then **Gameplay Objects** and **Mode
Objectives** — 178 objects in all, transcribed from maps exported out of the
game itself.

## Run it

**The quick way** — open `dist/spatial-ops-map-editor.html` in a browser. That
is the whole editor in one file; no server needed.

**The developer way** — browsers refuse to load ES modules over `file://`, so
the multi-file version in `src/` needs a local server:

```sh
npm run serve             # opens http://localhost:8000
```

After editing anything in `src/`, run `npm run build` to refresh the
single-file build. Node 18+ is the only requirement, and there is nothing to
`npm install` — the project has no package dependencies.

An internet connection is needed on first load, because three.js comes from a
CDN. To go fully offline, download three.js and repoint the `importmap` at the
top of `index.html`.

## Using it

| | |
|---|---|
| Left drag | Select — click an object, or drag a box across several |
| Middle drag | Orbit |
| Right drag | Pan |
| <kbd>Alt</kbd> + left drag | Orbit, for trackpads |
| <kbd>Shift</kbd> + click | Add to or remove from the selection |
| <kbd>Ctrl</kbd> + click | Pick one object out of a group |

| Key | |
|---|---|
| <kbd>W</kbd> <kbd>E</kbd> <kbd>R</kbd> | Move, rotate, scale |
| <kbd>G</kbd> / <kbd>Shift</kbd>+<kbd>G</kbd> | Group / ungroup |
| <kbd>Ctrl</kbd>+<kbd>D</kbd> | Duplicate in place |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>Ctrl</kbd>+<kbd>V</kbd> | Copy / paste — the copy rides the cursor, click to drop it, <kbd>Esc</kbd> to cancel |
| <kbd>Ctrl</kbd>+<kbd>A</kbd> | Select all |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> | Undo / redo |
| <kbd>F</kbd> | Frame the selection |
| <kbd>End</kbd> | Drop to floor |
| <kbd>Del</kbd> | Delete |

Grouped objects select together and rotate around the group's shared centre.
Duplicating a group makes a new group, so the copy moves independently.

Exported files have **no file extension** — that is correct, and it is what the
game expects. Copy the file straight into the game's maps folder.

### Object properties

Weapon spawners, enemy spawns and damage boxes carry an extra setting — which
weapon, which behaviour, which team colour. Select one and it appears at the
top of the inspector. The values the game is known to use are offered as a
list, but the field is free text, because one export is not proof of the whole
enum.

### Rules

The **Rules** panel in the inspector edits the five game mode rule sets. A
blank field means the game decides, and only the settings you actually change
are written to the file — which is exactly what the game does. Touched settings
get a dot beside them and a count on the mode tab.

Numbers are not clamped and the enum options are suggestions rather than a
closed list, because the reference export shows which settings exist without
revealing their defaults or valid ranges. Settings the editor does not
recognise are listed and passed through untouched.

### The `Grounded` variants

The in-game editor has solid boxes and cylinders plus a `Grounded` variant of
each. The web editor offers only the plain ones — the grounded variants exist
because VR has nothing to snap to, and here the grid does that job. Maps that
already use them load, display and export unchanged.

## Adding a pack

The packs the game ships with are built in. To add one the game does not have,
drop a JSON file in `packs/` and list it in `packs/index.json` — no code
changes. See [packs/README.md](packs/README.md) for the fields.

| Field | |
|---|---|
| `type` | **Exact** string the game writes to the map file. This is the only field the game sees |
| `label` / `category` | How it appears in the library |
| `group` | `virtual`, `gameplay` or `objectives` — which library section it sits under |
| `shape` | Placeholder generator — one of the ~60 builders in `src/placeholders.js` |
| `size` | `[width, height, depth]` of the base mesh in metres, at scale 1 |
| `pivot` | `base` (origin on the floor) or `center` |
| `rotationAxes` | `y` for yaw only, `xyz` for free rotation |
| `floor` | Whether the piece should rest on the ground |
| `defaultScale` | Scale a freshly placed object gets |
| `model` | Optional path to a `.glb`. When present it replaces the placeholder |

Types the editor has never seen still load: they appear as pink markers and
export completely unchanged, so an unknown pack can never corrupt a map.

## Dropping in the real models

Out of the box the editor draws its own stand-in shapes — simple geometry
written from measurements of the real pieces, so a barrier with a window in it
has a window in it. That is what these screenshots show and it needs nothing
from you.

To see the game's own models instead, extract Spatial Ops with
[AssetRipper](https://github.com/AssetRipper/AssetRipper) and copy the `.glb`
files into `assets/Prefabs/`. That folder is empty here and ignored by git;
[its README](assets/Prefabs/README.md) lists every filename the editor looks
for. Anything missing simply keeps its stand-in, so a partial set is fine.

The **Stand-ins** switch in the toolbar flips between the two at any time, which
is the quickest way to check whether a file landed.

If you have the extraction and want to work from it directly:

```sh
npm run stage-assets   # copies what the catalog needs out of reference/GameAssets/
```

Adding a new catalog entry works the same way: set `model` to a `.glb` basename
and the editor loads it in place of the stand-in, thumbnails included. Models
should be authored at scale 1 with the origin matching the `pivot` setting.

Everything still marked `~` in the library has estimated dimensions — see
[docs/FORMAT.md](docs/FORMAT.md) for what is confirmed and what is a guess.

## Development

```sh
npm test        # 76 tests, no dependencies, runs in under a second
npm run serve   # dev server at http://localhost:8000
npm run build   # regenerate dist/ after changing src/
```

Works identically on Windows, macOS and Linux.

`dist/` is generated — edit `src/` and rebuild rather than touching it.
[CLAUDE.md](CLAUDE.md) records the format invariants that must not be broken;
it is worth reading before your first change whether or not you use Claude Code.

## What is verified

The format work is tested against sixteen real map files exported from the
game, kept in `reference/`:

- Loading and re-exporting an untouched map is **byte-identical**, including
  .NET float formatting quirks — for all sixteen files.
- So is re-exporting with **every object marked as edited**, which forces each
  one through the float writer instead of reusing its original bytes.
- Pushing every object through the editor's Unity ↔ three.js conversion and
  back gives **zero** drift in position, rotation, and scale.
- Objects you never touch are written back from their original bytes, so an
  edit to one crate cannot perturb anything else.
- Loading each map in a real browser, selecting everything, committing a no-op
  edit and re-exporting also comes back **byte-identical** — the whole
  three.js pipeline, not just the pure functions.

Read [docs/FORMAT.md](docs/FORMAT.md) for the format itself, including what is
still guesswork.

## Layout

```
index.html    markup and styling
CLAUDE.md     format invariants and project conventions
src/
  format.js       map file parse and serialise, GUIDs, nav cloud codec
  unity.js        Unity <-> three.js coordinate and rotation conversion
  rules.js        game mode rule set schema
  packs.js        the 13 built-in object packs
  catalog.js      pack registry and lookups
  placeholders.js procedural stand-in geometry
  scene.js        viewport, selection, gizmos, marquee picking
  app.js          UI, history, file I/O
packs/            extra pack JSON, loaded when served over http
reference/        map files exported from the in-game editor
test/             node:test suites and the sample map fixture
docs/FORMAT.md    format notes
build.mjs         bundles src/ into dist/
serve.mjs         local dev server
```

## Licence

MIT, for the code.

`assets/Icons/` is not the project's to license: those thumbnails are sliced out
of Spatial Ops' own sprite atlases and are reproduced so the object library is
recognisable. See [assets/Icons/NOTICE.md](assets/Icons/NOTICE.md). Delete the
folder if you would rather not carry them — the library falls back to rendering
each object's stand-in shape as its thumbnail, and nothing else changes.

No game meshes or textures are included.

`reference/` holds a set of maps exported from the in-game editor. They are my
own maps rather than the game's, and they are here because they are the evidence
for how the file format actually works — every claim in
[docs/FORMAT.md](docs/FORMAT.md) is checked against them by the test suite, and
without them the format notes would be guesswork. They contain object type
names, transforms and rule settings, and nothing about the room anyone is
playing in.

The editor is not affiliated with or endorsed by the makers of Spatial Ops.
