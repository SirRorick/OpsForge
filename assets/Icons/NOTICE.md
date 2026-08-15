# Where these came from

These thumbnails are sliced out of Spatial Ops' own sprite atlases by
`npm run slice-icons`, and downscaled to 128 px by `npm run stage-assets`.

`Image_*` files are not thumbnails. They are the same artwork cropped and kept
larger because the editor draws them as surfaces in the scene rather than as
icons in a list — `Image_JumbotronScreen` is the jumbotron's display, which the
prefab itself does not carry, because the game assembles it from UI sprites at
runtime.

They are the game's artwork, owned by its makers and included here with their
permission to redistribute them with this editor. That permission covers this
project; it is not a grant to reuse the artwork anywhere else. See
[LICENSE.md](../../LICENSE.md), section 5.

If you fork this and would rather not carry them, delete the folder: the
library falls back to drawing each object's stand-in shape as its thumbnail,
and nothing else changes.
