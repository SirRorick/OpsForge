# OpsForge

A self-hosted map editor for the VR game **Spatial Ops**, running in your own
browser on your own machine. Open a map exported from the game, build with it,
and export a file the game reads back — or open one straight from the Spatial
Ops map library, and publish yours back to it. Nothing is uploaded unless you
ask for it, and when you do it goes from your browser straight to mod.io under
your own token — there is no OpsForge server for it to pass through.

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
fetches `assets/` from wherever it is served, so on its own it has
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
  objects and mode objectives, drawn with the game's own meshes. Boxes, walls,
  cylinders and tunnels tile their texture as they are stretched, so four metres
  of wall is four metres of brick rather than one smeared one. Every object
  also has a built-in stand-in shape, and the **Stand-ins** switch at the foot
  of the Library panel draws those instead at any time.
- **Hide** on the right-click menu puts finished work out of the way — a roof
  over the room you are building, an outer wall between the camera and
  everything behind it. Hidden objects stay on the map and export exactly as
  they would have done; what they stop doing is being *there*, so a click, a
  marquee, a drop, the wheel and **Orbit at cursor** all pass straight through
  where they used to be. **Show hidden** in the toolbar brings them back faded
  so you can pick one out and restore it for good.
- **Boundaries** are the game's invisible walls, the AR half of the library: a
  box, a cylinder and a wall that give collision without being drawn, so a real
  coffee table becomes cover and a real sofa becomes something to hide behind.
  The editor draws them at a tenth opacity with their edges picked out, and
  **Hide boundaries** in the toolbar takes them out of the view entirely.
- **Custom Text Message** puts a line of your own text on a pane in the arena,
  with a tick for whether players see it or only you.
- **Weapon spawners** are drawn holding the weapon they would produce, at the
  height and the angle the game holds it — across the crate rather than along
  it. A spawner offering several shows the longest, since that is the one whose
  clearance is in question: an RPG is a metre long, and a spawner set flush
  against a wall spawns it with its tube through the wall.
- **Damage boxes** are drawn as the crackling volume they are in the headset
  rather than as a solid slab, so you can see what is standing inside the
  region they mark.
- **Swap theme** on the right-click menu rebuilds a selection in another theme
  where it stands, keeping every position, angle and size.
- **Flip across X** and **Flip across Z**, also on the right-click menu, turn a
  selection round where it stands rather than copying it across the arena. A
  piece with a left and a right comes out the other way round; several pieces
  flip as one, so a run comes out as the run you would have built from the
  other end. Hovering either row draws the result in the view before you commit
  to it, and the selection stays live afterwards.
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
  told apart by looking rather than by reading. What falls together is whatever
  is standing on what: a stack lands stacked whether or not it was ever grouped,
  and pieces standing apart each land on their own. The under-ground preview is
  drawn through the floor and through the object it is about to leave, since a
  hologram of somewhere you cannot see is no preview at all.

**Three things the headset minds and the editor cannot show you**

- A bar across the foot of the window fills as objects are placed, and is full
  at **700**. Past that the frame rate goes — the map still plays and still
  exports, it just stutters. The warning can be overridden for the session, and
  a map opened with more than 700 in it starts overridden, because that is a
  decision its author already made.
- The game draws a **60 x 60 metre square** and nothing outside it. An object
  placed entirely beyond that loads and exports perfectly and then is simply
  not there in the headset, so the editor paints those red and says so once.
  Anything overlapping the square even partly is drawn in full, so stretching a
  wall out past the edge is fine.
- **Enemy spawns stay on the ground.** The game delivers its bots to the floor
  beneath the pad wherever the pad is, so a spawner lifted onto a crate puts
  enemies inside the crate. The editor holds them down and explains why once.

**The view**

- Middle drag orbits, right drag pans, and the wheel zooms towards whatever the
  pointer is over, taking a share of the distance to it each notch: metres at a
  time across the arena, millimetres up against a crate.
- **Mouse / Trackpad** in the top bar switches the whole scheme, for a laptop
  with no mouse to switch to. On the trackpad scheme two fingers on the pad
  orbit, <kbd>Shift</kbd> and two fingers pan, <kbd>Ctrl</kbd> or the OS key and
  two fingers zoom, and a two-finger tap is a right click — the gestures
  Blender uses. The choice is remembered in the browser.

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
  different theme, for a blue half and an orange half — and with player spawn
  zones, capture flags or damage boxes selected, the same box offers the teams
  instead, since a team is not a theme and no themed pack holds either.
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
- Grouping, locks and what you have hidden come back with it. None of the three
  is anything the map file can carry — they are the editor's, not the game's —
  so they are kept beside the checkpoint rather than in it, and an afternoon's
  arena comes back as the arena rather than as four hundred loose objects.
- Take one by hand at any time from the Checkpoints panel.

**Exporting**

- Exports are faithful to the game's own format down to the byte: objects you
  never touched are written back exactly as they arrived, and edited ones go
  through a float writer that matches .NET's output.
- Object types the editor has never seen still load, and export unchanged.

**Publishing to mod.io**

- **Open** offers a choice between a file on this computer and the Spatial Ops
  map library, and **Export** offers a choice between writing a file and
  publishing to it. Browsing the library needs no sign-in.
- The thumbnail is the view as you left it, so framing the map before pressing
  Export is how you choose the picture. The editor's own interface stays out of
  it — the grid, the icon badges over the spawners, the gizmo — so the shot is
  the map rather than the map being worked on. What each spawner is holding
  stays in: the weapon and the bot stand in the arena at their own size, the
  way the game puts them there, so they are part of the map rather than a note
  about it. OpsForge is badged in the corner.
- Publishing needs a mod.io sign-in: enter your email in the Export dialog,
  mod.io sends a 5-digit code, and entering that code back signs you in. This
  is the same sign-in the game itself uses in-headset — not a personal access
  token from mod.io/me/access, which is bound to your account rather than to
  Spatial Ops and cannot publish here.
- The token this exchange returns lives only in this browser's storage. It is
  never written into a map file, never logged, and never sent anywhere but
  mod.io itself.
- Uploading a map you have published before offers to update that entry
  instead of creating a second one, once mod.io confirms you own it.

## Keyboard

| | |
|---|---|
| Left drag | Select — click an object, or drag a box across several |
| Middle drag | Orbit &middot; Right drag pans &middot; <kbd>Alt</kbd>+left orbits |
| Wheel | Zoom towards the pointer |
| Two fingers | Orbit, with the top bar switched to **Trackpad** &middot; <kbd>Shift</kbd> pans &middot; <kbd>Ctrl</kbd> zooms &middot; a two-finger tap is a right click |
| Arrow keys | Nudge the selection, the way the view faces &middot; <kbd>Shift</kbd> for up and down |
| <kbd>Ctrl</kbd> + click | Add to the selection, or take something back out of it |
| <kbd>Shift</kbd> + click | Pick one object out of a group, leaving the rest |
| <kbd>G</kbd> / <kbd>Shift</kbd>+<kbd>G</kbd> | Group / ungroup |
| <kbd>Ctrl</kbd>+<kbd>A</kbd> | Select everything on screen |
| <kbd>Ctrl</kbd>+<kbd>D</kbd> / <kbd>C</kbd> / <kbd>V</kbd> | Duplicate / copy / paste |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> | Undo / redo &middot; <kbd>Ctrl</kbd>+<kbd>Y</kbd> also redoes |
| <kbd>Ctrl</kbd>+<kbd>S</kbd> | Export |
| <kbd>F</kbd> | Frame the selection |
| <kbd>End</kbd> / <kbd>Shift</kbd>+<kbd>End</kbd> | To the floor / onto whatever is underneath |
| <kbd>Ctrl</kbd>+<kbd>End</kbd> | Under the ground, top face on y = 0 |
| <kbd>Del</kbd> | Delete |

## More

- [packs/README.md](packs/README.md) — why the object catalog is built in, and
  where to add to it.
- [docs/FORMAT.md](docs/FORMAT.md) — the map file format as it is currently
  understood, including which parts are confirmed and which are still
  inference.

Developed with the assistance of [Claude Code](https://claude.com/claude-code).
