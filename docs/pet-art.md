# Art requirements for importing a pet

What `petgen from-sheet`, `from-frames`, and `from-gif` need from your art to
produce a good pack. `petgen doctor` warns about most of these; this page is
the reasoning.

## The short version

- **PNG (or WebP/GIF) with a transparent background.** No scene, no baked
  drop-shadow — the desktop provides the scene, and a baked shadow becomes a
  dark smear that drags the derived anchor sideways.
- **One character per image.**
- **Facing right.** The renderer mirrors for leftward travel; art that faces
  left walks backwards.
- **Feet at the bottom, uncropped.** The importer finds the feet by looking at
  the lowest opaque pixels. If the feet are clipped off the canvas edge, the
  anchor lands on the shins.
- **≥2px transparent margin on every side.** Cropped-to-the-pixel art gives
  the trimmer nothing to verify the edges against.
- **64–512px tall** for smooth art. Pixel art: whatever its native size is.
- **Pixel art at native resolution** — not upscaled. Import detects and undoes
  clean nearest-neighbour upscales, but native art is always safer.

## Frames must share a canvas

Export every frame of an animation (ideally every frame of every animation)
on the **same canvas size, with the character registered** — drawn where it
actually is in each pose, including the up-and-down of a walk bob.

The importer trims all frames with one shared bounding box, so relative
placement between frames survives. That is what keeps the bob. If your frames
are tightly cropped to the character (every frame a different size), the
importer falls back to aligning each frame by its own feet, which usually
works but can jitter by a pixel.

## How the anchor is derived

The pet's position is always its **ground anchor** — the point between its
feet. The importer derives it, per group of registered frames:

- **y**: the lowest opaque row across all frames — the contact pose.
- **x**: the alpha-weighted centroid of the bottom 8% of the character —
  the feet, not the body, so a leaning character doesn't toe-stand.
- If the feet band splits into two islands (mid-stride, one leg forward),
  the anchor is the midpoint of the two — so the pet doesn't lean toward
  whichever leg has more pixels.

If the derived anchor is wrong for your art, the escape hatch is editing the
emitted `pet.json`: add an explicit `cells` entry with a hand-placed `anchor`
for the frames that need it. Explicit cells win over the grid.

## Animated GIF / WebP specifics

- One file = one animation, named after the file (`walk.gif` → `walk`),
  or `--anim <name>` for a single file.
- Playback speed comes from the file's own frame delays (the most common
  delay wins). Variable frame timing does not survive import — `petgen`
  warns when it detects it.
- Byte-identical consecutive frames are stored once and replayed by index,
  so optimizer-padded GIFs don't bloat the atlas.
- The background must actually be transparent. A GIF with an opaque
  background imports as a walking rectangle. Automatic background removal
  is part of `from-image` (not built yet) — until then, remove it in your
  editor of choice.

## What the importer refuses to guess

- **Which frames belong to which animation** (`from-sheet` needs `--anim`).
- **designSpeed** — the travel speed (px/s) the walk cycle was drawn for.
  Without it the sim uses the pack's walk speed and feet may skate. Measure
  it in the preview (`petgen preview <pack>`) and set it by hand in
  `pet.json` — see `packs/blob/pet.json` for the shape.
