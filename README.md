# Spatial Ops Map Editor

A 3D map editor for the VR game **Spatial Ops**, running in your browser. Open a
map exported from the game, build with it, and export a file the game reads
back.

> **The game's own models and thumbnails are included**, with the developers'
> permission — so what you place is what you will see in the headset, not an
> approximation of it. See [Licence](#licence). Every object also has a
> built-in stand-in shape, and the **Stand-ins** switch in the toolbar draws
> those instead at any time.

## Features

**Building**

- 167 objects in 13 packs — eleven themes plus gameplay objects and mode
  objectives, transcribed from maps the game itself exported, and drawn with
  the game's own meshes.
- One gizmo for everything: arrows move, three coloured circles turn about X, Y
  and Z, cubes scale from the far side, and the centre disc slides across the
  floor.
- Click or drag-box to select, group, duplicate, copy and paste, undo and redo.
- Nudge the selection with the arrow keys, the way the view is facing and a grid
  step at a time.
- **Array** — repeat a selection into a grid, spaced to its own size rounded to
  the nearest 25 cm so copies sit flush and stay on the grid.
- **Mirror** — copy a half of the arena to the other side as a true reflection,
  so pieces with a left and a right come out the other way round. Optionally in
  a different theme, for a blue half and an orange half.
- Both tools show what they are about to make: translucent copies stand where
  the current settings would put real ones, so the numbers need no guessing.
- **Drop** onto whatever is underneath, for stacking, or straight to the floor.
  Loose objects each find their own landing; a group falls as one body and keeps
  its own stacking.
- Grid and angle snapping.
- **Preview** — stand in the map at a player's height and walk about, which is
  the only way to find out whether a doorway is generous or a squeeze and
  whether a crate is cover or scenery. Arrow keys walk, the mouse looks,
  <kbd>C</kbd> crouches from six feet to three, <kbd>Esc</kbd> puts you back
  exactly where you were in the editor.
- **Orbit at cursor** — turn the view about whatever is under the pointer rather
  than about the middle of the view, so leaning in on one corner of the arena
  and orbiting keeps it on screen.

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
It holds the editor and all of its artwork.

The editor has to be **served over http**, not opened from disk — browsers will
not let a `file://` page load the models, thumbnails and packs. Any static web
server does. The simplest is Node's:

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
npm run build      # dist/spatial-ops-map-editor.html — the editor in one file
npm run package    # dist/spatial-ops-map-editor/ and .zip — that plus the art
```

There is nothing to install first: the project has no dependencies. Node.js 18
or newer is the only requirement, on Windows, macOS or Linux. three.js is loaded
from a CDN, so the first load needs an internet connection.

The single file `npm run build` writes really is the whole editor, but it
fetches `assets/` and `packs/` from wherever it is served, so on its own it has
no artwork. `npm run package` is what puts the two together into something you
can hand to someone else. `dist/` is a build output and is not committed.

To work on it, use the dev server instead, which serves `src/` unbundled:

```sh
npm run serve
```

## Where the artwork comes from

`assets/` is extracted from the game with
[AssetRipper](https://github.com/AssetRipper/AssetRipper) and staged into the
repository by `npm run stage-assets`, which takes the few hundred files the
catalog actually asks for out of a dump ten times the size, caps prefab textures
at 512 px and icons at 128 px. That is a size decision rather than a quality
one: objects are drawn a few hundred pixels tall in a viewport, and the
originals are four hundred megabytes of detail nobody sees.

That is most of what a clone weighs — about 115 MB, nearly all of it
`assets/Prefabs/`. If you only want to read the code,
`git clone --filter=blob:none` leaves the models on the server until something
asks for them.

The extraction itself lives under `reference/`, which is not published. You do
not need it to run or build the editor — only to re-stage the assets, or to
convert a mesh the dump missed with `npm run graft-fbx`.

## Keyboard

| | |
|---|---|
| Left drag | Select — click an object, or drag a box across several |
| Middle drag | Orbit &middot; Right drag pans &middot; <kbd>Alt</kbd>+left orbits |
| Wheel | Zoom towards the pointer, a share of the distance to whatever it is over |
| Arrow keys | Nudge the selection, the way the view faces &middot; <kbd>Shift</kbd> for up and down |
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

**Not for `assets/`.** The models in `assets/Prefabs/` and the thumbnails in
`assets/Icons/` are Spatial Ops' own artwork, included here with the developers'
permission to redistribute them with this editor. That permission is for this;
it is not a licence to reuse the art elsewhere, and the MIT licence above does
not cover it. See [assets/Icons/NOTICE.md](assets/Icons/NOTICE.md) and
[assets/Prefabs/README.md](assets/Prefabs/README.md).

Deleting either folder still leaves a working editor: objects fall back to the
stand-in shapes in `src/placeholders.js`, built from measurements rather than
extracted geometry, and the library draws those as its thumbnails instead.

Not affiliated with or endorsed by the makers of Spatial Ops.

Developed with the assistance of [Claude Code](https://claude.com/claude-code).
