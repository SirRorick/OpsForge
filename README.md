# OpsForge

A self-hosted map editor for the VR game **Spatial Ops**, running in your own
browser on your own machine. Open a map exported from the game, build with it,
and export a file the game reads back. Nothing is uploaded anywhere — you run
the editor, and your maps stay on your computer.

The game's own models and thumbnails are included, so what you place is what
you will see in the headset.

OpsForge is an unofficial community project. Not affiliated with the developers
of Spatial Ops (Resolution Games).

## Licence

**OpsForge Project & Asset License**

You may use, modify, and share this project and all included assets only for
OpsForge or for Spatial Ops projects — maps, mods, tools, and content built for
Spatial Ops related projects, or contributions back to this repo.

**You may:** build and publish Spatial Ops content with these files, modify
them, and redistribute them for that purpose — free of charge, with credit, and
under this same license.

**You may not:** use them in any other game, engine, app, or product; repackage
them as an asset pack; sell them or put them behind a paywall; or use them to
train AI models.

Additional licence information can be found in [LICENSE.md](LICENSE.md).

The artwork in `assets/` is Spatial Ops' own, included here with the
developers' permission to redistribute it with this editor. See
[assets/Icons/NOTICE.md](assets/Icons/NOTICE.md) and
[assets/Prefabs/README.md](assets/Prefabs/README.md).

## Run it on your own computer

**[Node.js](https://nodejs.org) is required.** Version 18 or newer. Install it
first — the editor will not run without it.

The editor has to be served over http. Opening the page from disk does not
work: browsers will not let a `file://` page load the models, thumbnails and
packs it needs.

1. Download the latest zip from [Releases](../../releases).
2. Extract it anywhere.
3. Open a command prompt in the extracted `spatial-ops-map-editor` folder.
4. Run:

   ```sh
   npx serve .
   ```

5. Ctrl+click the `localhost` link it prints, or type that address into your
   browser.

Leave the command prompt open while you work — closing it stops the server.

Exported maps have **no file extension**. That is correct — copy the file
straight into the game's maps folder.

## Build your own copy from this repo

Clone the repository. There is nothing to install first: the project has no
dependencies. Node.js 18 or newer is the only requirement, on Windows, macOS or
Linux.

```sh
npm run build      # dist/spatial-ops-map-editor.html — the editor in one file
npm run package    # dist/spatial-ops-map-editor/ and .zip — that plus the art
```

The single file `npm run build` writes really is the whole editor, but it
fetches `assets/` and `packs/` from wherever it is served, so on its own it has
no artwork. `npm run package` puts the two together and produces the same zip
the releases carry. `dist/` is a build output and is not committed.

To work on the editor, use the dev server instead, which serves `src/`
unbundled:

```sh
npm run serve
```

three.js is loaded from a CDN, so the first load needs an internet connection.

A clone is about 115 MB, nearly all of it the models in `assets/Prefabs/`. If
you only want to read the code, `git clone --filter=blob:none` leaves those on
the server until something asks for them.

## Features

**Building**

- 173 objects in 14 packs — eleven themes and the boundaries, plus gameplay
  objects and mode objectives, drawn with the game's own meshes. Every object
  also has a built-in stand-in shape, and the **Stand-ins** switch in the
  toolbar draws those instead at any time.
- **Boundaries** are the game's invisible walls, the AR half of the library: a
  box, a cylinder and a wall that give collision without being drawn, so a real
  coffee table becomes cover and a real sofa becomes something to hide behind.
  The editor draws them at a tenth opacity with their edges picked out, and
  **Hide boundaries** in the toolbar takes them out of the view entirely.
- **Custom Text Message** puts a line of your own text on a pane in the arena,
  with a tick for whether players see it or only you.
- **Swap theme** on the right-click menu rebuilds a selection in another theme
  where it stands, keeping every position, angle and size.
- One gizmo for everything: arrows move, three coloured circles turn about X, Y
  and Z, cubes scale from the far side, and the centre disc slides across the
  floor.
- Click or drag-box to select, group, duplicate, copy and paste, undo and redo.
- Grid and angle snapping, and arrow keys that nudge the selection a grid step
  at a time, the way the view is facing. Angle snap rounds the angle you arrive
  at rather than the turn you make, so a piece left at 43 degrees squares up
  with everything else the next time it is turned.
- **To floor**, **Drop** and **Under ground** land a selection on the ground, on
  whatever is beneath it, or under the ground with nothing showing. Hovering
  any of the three draws the selection where it would land, so the three are
  told apart by looking rather than by reading.

**Prefabs**

- Keep a piece of map on its own — a bunker, a doorway, a stack of crates — in a
  `.opsprefab` file, and drop it into any other map.
- **Export prefab** writes the selection out with every type, angle, size and
  height as it stands; **Import prefab** brings one back under the cursor as a
  single group, which ungroups like any other.

**Array and Mirror**

- **Array** repeats a selection into a grid, spaced to its own size so copies
  sit flush.
- **Mirror** copies half the arena to the other side as a true reflection, so
  pieces with a left and a right come out the other way round. Optionally in a
  different theme, for a blue half and an orange half.
- Both show their work first: translucent copies stand where the current
  settings would put real ones, so the numbers need no guessing.

**First-person preview**

- **Preview** stands you in the map at a player's height and lets you walk
  about — the only way to find out whether a doorway is generous or a squeeze,
  and whether a crate is cover or scenery.
- Arrow keys walk, the mouse looks, <kbd>C</kbd> crouches from six feet to
  three, and <kbd>Esc</kbd> puts you back exactly where you were in the editor.

**Rules editor**

- Game mode rule sets, with every setting the in-game rules screen exposes. A
  mode becomes available once the map holds the objectives to play it.
- Per-object settings where the game has them: which weapon a spawner holds,
  which of 13 enemy types an enemy spawn produces and how it behaves, which
  team a damage box belongs to.
- Paint the bot grid — the ground bots are allowed to walk on — and set the
  arena size.

**Checkpoints**

- The editor takes a snapshot of the map every couple of minutes of actual
  editing, on export, and on the way out, keeping a rolling twelve in the
  browser. Restore one after a crash or a closed tab.
- Take one by hand at any time from the Checkpoints panel.

**Exporting**

- Exports are faithful to the game's own format down to the byte: objects you
  never touched are written back exactly as they arrived, and edited ones go
  through a float writer that matches .NET's output.
- Object types the editor has never seen still load, and export unchanged.

## Keyboard

| | |
|---|---|
| Left drag | Select — click an object, or drag a box across several |
| Middle drag | Orbit &middot; Right drag pans &middot; <kbd>Alt</kbd>+left orbits |
| Wheel | Zoom towards the pointer |
| Arrow keys | Nudge the selection, the way the view faces &middot; <kbd>Shift</kbd> for up and down |
| <kbd>Shift</kbd> / <kbd>Ctrl</kbd> + click | Add to the selection / pick one out of a group |
| <kbd>G</kbd> / <kbd>Shift</kbd>+<kbd>G</kbd> | Group / ungroup |
| <kbd>Ctrl</kbd>+<kbd>D</kbd> / <kbd>C</kbd> / <kbd>V</kbd> | Duplicate / copy / paste |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> | Undo / redo |
| <kbd>F</kbd> | Frame the selection |
| <kbd>End</kbd> / <kbd>Shift</kbd>+<kbd>End</kbd> | To the floor / onto whatever is underneath |
| <kbd>Ctrl</kbd>+<kbd>End</kbd> | Under the ground, top face on y = 0 |
| <kbd>Del</kbd> | Delete |

## More

- [packs/README.md](packs/README.md) — add your own objects with a JSON file in
  `packs/`, no code changes.
- [docs/FORMAT.md](docs/FORMAT.md) — the map file format as it is currently
  understood, including which parts are confirmed and which are still
  inference.

Developed with the assistance of [Claude Code](https://claude.com/claude-code).
