# Extra object packs

The packs the game ships with are built into the editor — see `src/packs.js`.
This folder is for packs the game does not have, or for overriding a built-in
one while you work on it.

Drop a JSON file here, list its file name in `index.json`, and reload. No code
changes. A pack is:

```json
{
  "id": "my-pack",
  "name": "My Pack",
  "group": "virtual",
  "objects": [
    {
      "type": "MyPackCrate",
      "label": "Crate",
      "category": "Props",
      "shape": "crate",
      "size": [0.6, 0.6, 0.6],
      "pivot": "base",
      "rotationAxes": "y",
      "floor": true,
      "color": "#A8794A",
      "defaultScale": [1, 1, 1],
      "uncertain": true
    }
  ]
}
```

`group` is one of `virtual`, `gameplay` or `objectives` and decides which
top-level library section the pack appears under. `shape` must name a builder
in `src/placeholders.js`; anything else falls back to the pink unknown marker.
Registering a pack whose `id` already exists replaces it.

A type that no loaded pack knows about still loads, still shows as a marker,
and still exports byte for byte — a missing pack can never corrupt a map.
