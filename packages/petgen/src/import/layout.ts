/**
 * From loose frames to a uniform atlas.
 *
 * THE RULE THAT MATTERS: frames that came off one source canvas are already
 * registered against each other — the bob of a walk cycle is baked into where
 * the artist drew each frame. So frames are trimmed with ONE box, the union of
 * every frame's individual bounds, and share ONE anchor derived from their
 * max-alpha composite. Trimming each frame tight and re-centring it — the
 * obvious thing, and what people do by hand — silently deletes the animation.
 *
 * Frames from different canvases (a folder of differently-sized PNGs, two GIFs)
 * can't be registered against each other, so each GROUP gets its own box and
 * anchor, and the final cell size is unified across groups in anchor space.
 */

import {
  blit,
  compositeAlpha,
  deriveAnchor,
  makeRaster,
  trimBox,
  unionBox,
  type Box,
  type Raster,
} from './raster.js';

/** A frame plus where its content and anchor sit on its own canvas. */
export interface AlignedFrame {
  raster: Raster;
  /** Content bounds to copy, in this frame's canvas space. */
  box: Box;
  /** Anchor (feet), in this frame's canvas space. Shared by its whole group. */
  ax: number;
  ay: number;
}

/**
 * Align a group of same-canvas frames: one union box, one composite anchor.
 * Throws if every frame is empty; empty individual frames keep the shared box.
 */
export function alignGroup(frames: readonly Raster[]): AlignedFrame[] {
  if (frames.length === 0) throw new Error('no frames to align');
  const w = frames[0]!.w;
  const h = frames[0]!.h;
  for (const f of frames) {
    if (f.w !== w || f.h !== h) {
      throw new Error(`frames in one group must share a canvas (${w}x${h} vs ${f.w}x${f.h})`);
    }
  }

  let union: Box | null = null;
  for (const f of frames) {
    const b = trimBox(f);
    if (b) union = union ? unionBox(union, b) : b;
  }
  if (!union) throw new Error('every frame is fully transparent');

  const { ax, ay } = deriveAnchor(compositeAlpha(frames), union);
  return frames.map((raster) => ({ raster, box: union, ax, ay }));
}

export interface AtlasLayout {
  atlas: Raster;
  cellW: number;
  cellH: number;
  cols: number;
  spacing: number;
  margin: number;
  count: number;
}

/** Transparent pixels between the content and the cell's side/top edges. */
const CELL_PAD = 1;
const SPACING = 1;
const MARGIN = 1;

/**
 * Pack aligned frames onto a uniform grid.
 *
 * Cell geometry is chosen so the DEFAULT anchor — [w/2, h-1], what the schema
 * gives a grid cell — lands exactly on the derived anchor. That is why the
 * generated pet.json needs no explicit `cells` block: the content is placed
 * around the anchor rather than the anchor being written down.
 *
 *   - width is symmetric about the anchor (2 * max(left, right) + padding)
 *   - the anchor row is the LAST row of the cell: no bottom padding, ever,
 *     or the pet floats that many pixels above every floor it stands on
 */
export function buildAtlas(frames: readonly AlignedFrame[]): AtlasLayout {
  let left = 0,
    right = 0,
    up = 0;
  for (const f of frames) {
    left = Math.max(left, Math.ceil(f.ax - f.box.x0));
    right = Math.max(right, Math.ceil(f.box.x1 - f.ax));
    up = Math.max(up, f.ay - f.box.y0);
  }

  const half = Math.max(left, right) + CELL_PAD;
  const cellW = 2 * half;
  const cellH = up + 1 + CELL_PAD;

  const count = frames.length;
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const atlas = makeRaster(
    MARGIN * 2 + cols * cellW + (cols - 1) * SPACING,
    MARGIN * 2 + rows * cellH + (rows - 1) * SPACING,
  );

  frames.forEach((f, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cellX = MARGIN + col * (cellW + SPACING);
    const cellY = MARGIN + row * (cellH + SPACING);
    // Map the frame's anchor to the cell's default anchor [w/2, h-1].
    const dx = cellX + half - Math.round(f.ax);
    const dy = cellY + (cellH - 1) - f.ay;
    blit(atlas, f.raster, f.box, dx, dy);
  });

  return { atlas, cellW, cellH, cols, spacing: SPACING, margin: MARGIN, count };
}
