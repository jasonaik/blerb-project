/**
 * `petgen from-image <png|jpg> -o packs/x`
 *
 * Tier 4: ONE static picture becomes a walking pet. No frames are generated —
 * the pack carries a procedural rig, and @blerb/core's applyGait deforms the
 * single cell about its ground anchor at render time: double-bounce bob,
 * volume-preserving squash, a lean into travel. AI frame generation was
 * evaluated and rejected (CLAUDE.md §7): deformation can look stiff, but it
 * can never flicker into a different character.
 */

import { alignGroup, buildAtlas } from '../import/layout.js';
import { loadRaster } from '../import/io.js';
import { transparentFraction, trimBox, type Raster } from '../import/raster.js';
import { detectForImport, downscaleBy } from '../import/pixelart.js';
import { removeBackground, erodeEdge } from '../import/bgremove.js';
import { emitPack, idFromOutDir } from '../import/emit.js';

export interface FromImageOptions {
  input: string;
  outDir: string;
  /** Perceptual backdrop tolerance 0..1. Default 0.1. */
  tolerance?: number | undefined;
  /** Skip background removal entirely (the alpha is already right). */
  keepBg?: boolean | undefined;
  id?: string | undefined;
  name?: string | undefined;
  author?: string | undefined;
  license?: string | undefined;
}

export async function fromImage(o: FromImageOptions): Promise<string> {
  let img: Raster = await loadRaster(o.input);

  // "Already cut out" means a MEANINGFUL amount of the frame is transparent —
  // one stray 254-alpha pixel (matte fringe, soft-eraser residue) is not a
  // cut-out, and gating on any-alpha-at-all silently skipped removal on
  // otherwise-opaque art.
  const alreadyCut = transparentFraction(img) >= 0.02;
  let removalRan = false;
  if (alreadyCut) {
    console.log('input already has transparency — skipping background removal');
  } else if (!o.keepBg) {
    const { out, removed } = removeBackground(img, o.tolerance ?? 0.1);
    if (removed < 0.02) {
      console.warn(
        'no backdrop found from the corners — the character may fill the frame, ' +
          'or the background is too varied for a flood fill. Importing as-is; ' +
          'cut it out in an editor if the pet comes out rectangular.',
      );
    } else {
      console.log(`removed backdrop (${Math.round(removed * 100)}% of the image)`);
      img = out;
      removalRan = true;
    }
  }

  if (!trimBox(img)) {
    throw new Error('nothing left after background removal — try a lower --tolerance');
  }

  // A flood-filled alpha channel is binary by construction, so it must not
  // count as pixel-art evidence.
  const verdict = detectForImport([img], { alphaSynthetic: removalRan });
  if (verdict.scale >= 2) {
    console.log(`detected pixel art upscaled ${verdict.scale}x — importing at native resolution`);
    img = downscaleBy(img, verdict.scale);
  }
  if (!verdict.pixelArt && removalRan) {
    // Feather the cut edge on smooth art; pixel art keeps its hard outline.
    img = erodeEdge(img);
  }

  const layout = buildAtlas(alignGroup([img]));
  const content = trimBox(img)!;
  const contentW = content.x1 - content.x0 + 1;
  const contentH = content.y1 - content.y0 + 1;

  // Hi-res smooth art — official artwork, a photo, a painting — renders at
  // pet size via atlas.scale rather than being downsampled: the pixels stay
  // in the file for anyone who turns the pet size up. Target: ~64px tall on
  // screen at pet size 1. Pixel art is always native, whatever its size.
  const atlasScale =
    !verdict.pixelArt && contentH > 128 ? Math.round((contentH / 64) * 100) / 100 : 1;
  if (atlasScale !== 1) {
    console.log(
      `hi-res art (${contentH}px tall) — setting atlas.scale ${atlasScale} so it renders ~64px`,
    );
  }

  const id = o.id ?? idFromOutDir(o.outDir);
  return emitPack({
    outDir: o.outDir,
    id,
    name: o.name ?? id,
    author: o.author ?? 'unknown',
    license: o.license ?? 'unknown',
    source: `from-image ${o.input.replace(/\\/g, '/').split('/').pop()}`,
    pixelArt: verdict.pixelArt,
    layout,
    atlasScale,
    animations: [{ name: 'idle', frames: [0], fps: 1 }],
    rig: {
      type: 'procedural',
      gaits: {
        // Stride scales with the character AS DISPLAYED: bigger creatures
        // take bigger steps, but in world px, not file px. Everything else
        // rides on the schema's tuned defaults.
        walk: { strideLength: Math.max(10, Math.round((contentW / atlasScale) * 0.7)) },
        idle: {},
        sleep: {},
      },
    },
  });
}
