# packs/

**Nothing in this folder is loaded.** It is kept as a place to read about how
the object catalog is put together; the editor does not fetch anything from
here.

Every object the editor offers is built into `src/packs.js` — 173 of them
across 14 packs, measured off the game's own prefabs and matched to the game's
own icons. That is deliberate rather than a limitation:

**What the game has is what the editor offers.** A map file names its objects
by type, and the game builds them from *its* catalog. An object type the game
does not know about is one it cannot draw, so a map built with a made-up type
loads into the headset with a hole where the object should be. An editor that
let you place one would be an editor that let you build a map that cannot be
played — and it would do it quietly, because everything looks right until the
headset is on.

The editor used to fetch extra packs listed in `packs/index.json` at boot. That
is gone. It also never quite worked: re-registering a pack replaced its library
entries but not the lookup that map files go through, so an overridden pack
showed one set of objects in the panel and built the map out of another.

## Adding an object

Add it to `BUILTIN_PACKS` in `src/packs.js`. The field notes at the top of that
file say what every key means, and `src/catalog.js` fills in the defaults. It is
still data and nothing else — no code changes — it just lives with the rest of
the catalog rather than beside it.

An object type no pack knows about still loads from a map file, still shows as
the pink Unrecognised marker, and still exports byte for byte. A map can never
be corrupted by a type the editor has not heard of.
