# Spatial Ops Map Editor

A visual 3D map editor for the VR game **Spatial Ops**. Runs entirely in your
browser, offline, with no build step and no account. MIT licensed.

Load a map file, drag objects in from the library, move and scale them with
gizmos, and export a file the game can read.

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
| Right drag | Orbit |
| Middle drag | Pan |
| <kbd>Alt</kbd> + left drag | Orbit, for trackpads |
| <kbd>Shift</kbd> + click | Add to or remove from the selection |
| <kbd>Ctrl</kbd> + click | Pick one object out of a group |

| Key | |
|---|---|
| <kbd>W</kbd> <kbd>E</kbd> <kbd>R</kbd> | Move, rotate, scale |
| <kbd>G</kbd> / <kbd>Shift</kbd>+<kbd>G</kbd> | Group / ungroup |
| <kbd>Ctrl</kbd>+<kbd>D</kbd> | Duplicate |
| <kbd>Ctrl</kbd>+<kbd>A</kbd> | Select all |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> | Undo / redo |
| <kbd>F</kbd> | Frame the selection |
| <kbd>End</kbd> | Drop to floor |
| <kbd>Del</kbd> | Delete |

Grouped objects select together and rotate around the group's shared centre.
Duplicating a group makes a new group, so the copy moves independently.

Exported files have **no file extension** — that is correct, and it is what the
game expects. Copy the file straight into the game's maps folder.

## Adding a pack

A pack is a JSON file. Nothing else is needed — no code changes.

```json
{
  "id": "urban",
  "name": "Urban",
  "schema": 1,
  "objects": [
    {
      "type": "UrbanDumpster",
      "label": "Dumpster",
      "category": "Props",
      "shape": "box",
      "size": [1.6, 1.2, 0.9],
      "pivot": "base",
      "rotationAxes": "y",
      "floor": true,
      "color": "#3F6B4A"
    }
  ]
}
```

| Field | |
|---|---|
| `type` | **Exact** string the game writes to the map file. This is the only field the game sees |
| `label` / `category` | How it appears in the library |
| `shape` | Placeholder generator: `box`, `cylinder`, `crate`, `barrier`, `barrierWindow`, `barrierCorner`, `barrierU`, `tunnel`, `electricityBox` |
| `size` | `[width, height, depth]` of the base mesh in metres, at scale 1 |
| `pivot` | `base` (origin on the floor) or `center` |
| `rotationAxes` | `y` for yaw only, `xyz` for free rotation |
| `floor` | Whether the piece should rest on the ground |
| `model` | Optional path to a `.glb`. When present it replaces the placeholder |

Use **Import pack…** in the library panel to load one from disk, or drop the
file in `packs/` and add it to `packs/index.json` if you are running from a
server.

Types the editor has never seen still load: they appear as pink markers and
export completely unchanged, so an unknown pack can never corrupt a map.

## Dropping in real models

Set `model` on a catalog entry to a `.glb` path and the editor loads it in place
of the placeholder, including in the library thumbnails. Models should be
authored at scale 1 with the origin matching the `pivot` setting.

Everything currently marked `~` in the library has estimated dimensions — see
[docs/FORMAT.md](docs/FORMAT.md) for what is confirmed and what is a guess.

## Development

```sh
npm test        # 25 tests, no dependencies, runs in under a second
npm run serve   # dev server at http://localhost:8000
npm run build   # regenerate dist/ after changing src/
```

Works identically on Windows, macOS and Linux.

`dist/` is generated — edit `src/` and rebuild rather than touching it.
[CLAUDE.md](CLAUDE.md) records the format invariants that must not be broken;
it is worth reading before your first change whether or not you use Claude Code.

## What is verified

The file format work is tested against a real map file:

- Loading and re-exporting an untouched map is **byte-identical**, including
  .NET float formatting quirks.
- Pushing every object through the editor's Unity ↔ three.js conversion and
  back gives **zero** drift in position, rotation, and scale.
- Objects you never touch are written back from their original bytes, so an
  edit to one crate cannot perturb anything else.

Read [docs/FORMAT.md](docs/FORMAT.md) for the format itself.

## Layout

```
index.html    markup and styling
CLAUDE.md     format invariants and project conventions
src/
  format.js       map file parse and serialise, GUIDs, nav cloud codec
  unity.js        Unity <-> three.js coordinate and rotation conversion
  catalog.js      pack schema and the built-in Default pack
  placeholders.js procedural stand-in geometry
  scene.js        viewport, selection, gizmos, marquee picking
  app.js          UI, history, file I/O
packs/            pack JSON, loaded when served over http
test/             node:test suites and the sample map fixture
docs/FORMAT.md    format notes
build.mjs         bundles src/ into dist/
serve.mjs         local dev server
```

## Licence

MIT.
