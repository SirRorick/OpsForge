# Spatial Ops Map Editor

A 3D map editor for the VR game **Spatial Ops**, running in your browser. Open a
map exported from the game, build with it, and export a file the game reads
back.

> **No game meshes or textures are included.** Objects are drawn with the
> editor's own stand-in shapes, built from measurements rather than extracted
> geometry. The one exception is a set of small (128 px) library thumbnails
> sliced from the game's sprite atlases so the object list is recognisable —
> see [Licence](#licence). If you own the game you can point the editor at your
> own extraction and it will use the real models instead.

## Features

**Building**

- 167 objects in 13 packs — eleven themes plus gameplay objects and mode
  objectives, transcribed from maps the game itself exported.
- One gizmo for everything: arrows move, three coloured circles turn about X, Y
  and Z, cubes scale from the far side, and the centre disc slides across the
  floor.
- Click or drag-box to select, group, duplicate, copy and paste, undo and redo.
- **Array** — repeat a selection into a grid, spaced to its own size so copies
  sit flush.
- **Mirror** — copy a half of the arena to the other side as a true reflection,
  so pieces with a left and a right come out the other way round. Optionally in
  a different theme, for a blue half and an orange half.
- **Drop** onto whatever is underneath, for stacking, or straight to the floor.
- Grid and angle snapping.

**Map setup**

- Per-object settings where the game has them: which weapon a spawner holds,
  which of 13 enemy types an enemy spawn produces and how it behaves, which team
  a damage box belongs to.
- Game mode rule sets, with every setting the in-game rules screen exposes. A
  mode becomes available once the map holds the objectives to play it.
- Paint the bot grid — the ground bots are allowed to walk on.
- Set the arena size.

**Safety**

- **Autosave** keeps a rolling dozen snapshots in the browser, restorable after
  a crash or a closed tab.
- Exports are faithful to the game's own format down to the byte: objects you
  never touched are written back exactly as they arrived, and edited ones go
  through a float writer that matches .NET's output.
- Object types the editor has never seen still load, and export unchanged.

## Run it

Download the latest zip from [Releases](../../releases) and unzip it anywhere.

The editor has to be **served over http**, not opened from disk — browsers will
not let a `file://` page load the thumbnails and packs. Any static web server
does. The simplest is Node's:

```sh
cd spatial-ops-map-editor
npx serve .
```

Then open the address it prints. [Node.js](https://nodejs.org) 18 or newer is
required for that command; if you already have a web server you prefer, point it
at the folder instead.

Exported maps have **no file extension**. That is correct — copy the file
straight into the game's maps folder.

## Build it yourself

Clone the repository and run:

```sh
npm run build
```

That writes `dist/spatial-ops-map-editor.html`, the whole editor in one file.
There is nothing to install first — the project has no dependencies.

To work on it, use the dev server instead, which serves `src/` unbundled:

```sh
npm run serve
```

Node.js 18 or newer is the only requirement, on Windows, macOS or Linux.
three.js is loaded from a CDN, so the first load needs an internet connection.

## Using the game's own models

Objects are drawn as stand-in shapes by default, and that is a complete way to
use the editor. If you own Spatial Ops and would like the real thing, extract it
with [AssetRipper](https://github.com/AssetRipper/AssetRipper) and copy the
`.glb` files into `assets/Prefabs/`.
[That folder's README](assets/Prefabs/README.md) lists every filename the editor
looks for. A partial set is fine — anything missing keeps its stand-in, and the
**Stand-ins** switch in the toolbar flips between the two at any time.

Those files stay on your machine. They are not redistributed here and must not
be committed.

## Keyboard

| | |
|---|---|
| Left drag | Select — click an object, or drag a box across several |
| Middle drag | Orbit &middot; Right drag pans &middot; <kbd>Alt</kbd>+left orbits |
| <kbd>Shift</kbd> / <kbd>Ctrl</kbd> + click | Add to the selection / pick one out of a group |
| <kbd>G</kbd> / <kbd>Shift</kbd>+<kbd>G</kbd> | Group / ungroup |
| <kbd>Ctrl</kbd>+<kbd>D</kbd> / <kbd>C</kbd> / <kbd>V</kbd> | Duplicate / copy / paste |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> | Undo / redo |
| <kbd>F</kbd> | Frame the selection |
| <kbd>End</kbd> / <kbd>Shift</kbd>+<kbd>End</kbd> | To the floor / onto whatever is underneath |
| <kbd>Del</kbd> | Delete |

## Adding your own objects

Drop a JSON file into `packs/` and list it in `packs/index.json` — no code
changes. [packs/README.md](packs/README.md) describes the fields.

## More

[docs/FORMAT.md](docs/FORMAT.md) documents the map file format as it is
currently understood, including which parts are confirmed and which are still
inference.

## Licence

MIT, for the code.

`assets/Icons/` is not the project's to license: those thumbnails are the game's
artwork, reproduced so the object library is recognisable. See
[assets/Icons/NOTICE.md](assets/Icons/NOTICE.md). Delete the folder if you would
rather not carry them — the library falls back to drawing each object's stand-in
shape as its thumbnail, and nothing else changes.

No game meshes or textures are included.

Not affiliated with or endorsed by the makers of Spatial Ops.

Developed with the assistance of [Claude Code](https://claude.com/claude-code).
