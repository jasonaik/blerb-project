import type { ResolvedCell, ResolvedPack } from '@blerb/pack';
import type { Rect, RenderFrame, World } from '@blerb/core';

/**
 * The only render sink in the project.
 *
 * Used verbatim by the Electron overlay, the petgen preview page, and (later)
 * the offline baker that renders procedural gait frames into a real atlas.
 * Because all three share this code, the pet cannot look different depending
 * on where it is drawn.
 *
 * The context type is declared structurally rather than imported from `lib.dom`
 * so this package compiles without DOM types and works unchanged against
 * `@napi-rs/canvas` in Node.
 */

export interface AtlasImage {
  readonly width: number;
  readonly height: number;
}

export interface Ctx2D {
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  scale(x: number, y: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  stroke(): void;
  fill(): void;
  fillText(text: string, x: number, y: number): void;
  drawImage(
    image: never,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
  globalAlpha: number;
  imageSmoothingEnabled: boolean;
  strokeStyle: string;
  fillStyle: string;
  lineWidth: number;
  font: string;
}

/**
 * The axis-aligned box a frame actually covers on screen, in the same space as
 * `f.x`/`f.y`.
 *
 * Must be derived from the transform, not from the cell box: the sprite is
 * rotated a quarter turn on a wall and a half turn under a ceiling, so the
 * footprint moves to the side of, or below, the anchor. Assuming it always
 * sits above the anchor is what made a hanging pet nearly impossible to click —
 * the interactive region was a sprite's height above where the pet was drawn.
 *
 * `atlasScale` must match the pack's, since `draw` divides by it.
 */
export function frameBounds(cell: ResolvedCell, f: RenderFrame, atlasScale = 1): Rect {
  const inv = 1 / atlasScale;
  const sx = f.facing * f.scale * f.squash.sx * inv;
  const sy = f.scale * f.squash.sy * inv;
  const cos = Math.cos(f.rotation);
  const sin = Math.sin(f.rotation);

  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;

  // Four corners of the cell, through translate -> rotate -> scale.
  for (const [u, v] of [
    [0, 0],
    [cell.w, 0],
    [0, cell.h],
    [cell.w, cell.h],
  ] as const) {
    const lx = sx * (u - cell.anchor[0]);
    const ly = sy * (v - cell.anchor[1]);
    const wx = f.x + lx * cos - ly * sin;
    const wy = f.y + lx * sin + ly * cos;
    x0 = Math.min(x0, wx);
    y0 = Math.min(y0, wy);
    x1 = Math.max(x1, wx);
    y1 = Math.max(y1, wy);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export interface CanvasRendererOptions {
  ctx: Ctx2D;
  pack: ResolvedPack;
  atlas: AtlasImage;
  /**
   * Device pixel ratio the canvas backing store is scaled by. The renderer
   * needs it only to decide where a "whole pixel" is when snapping pixel art.
   */
  dpr?: number;
}

export class CanvasRenderer {
  private readonly ctx: Ctx2D;
  private readonly pack: ResolvedPack;
  private readonly atlas: AtlasImage;
  private dpr: number;

  constructor(opts: CanvasRendererOptions) {
    this.ctx = opts.ctx;
    this.pack = opts.pack;
    this.atlas = opts.atlas;
    this.dpr = opts.dpr ?? 1;
  }

  setDpr(dpr: number): void {
    this.dpr = dpr;
  }

  clear(w: number, h: number): void {
    this.ctx.clearRect(0, 0, w, h);
  }

  /**
   * Draw one frame.
   *
   * Order matters: translate to the anchor first, then rotate and scale, so
   * every deformation happens *about the pet's feet*. That single choice is
   * what makes squash-and-stretch read as weight on the ground rather than as
   * the sprite sinking into it, and it's why `anchor` is mandatory in the pack
   * format.
   */
  draw(f: RenderFrame): void {
    if (f.opacity <= 0) return;

    const cell = this.pack.cells.get(f.cellId);
    if (!cell) return; // A bad cell id should drop a frame, not take down the loop.

    const ctx = this.ctx;
    const invAtlas = 1 / this.pack.atlasScale;

    ctx.save();
    ctx.imageSmoothingEnabled = !this.pack.pixelArt;

    // Sub-pixel positioning is what makes motion look smooth, but on hard-edged
    // art it makes the sprite shimmer as pixel boundaries drift. Snap to whole
    // device pixels for pixel-art packs and leave everything else continuous.
    let px = f.x;
    let py = f.y;
    if (this.pack.pixelArt) {
      px = Math.round(px * this.dpr) / this.dpr;
      py = Math.round(py * this.dpr) / this.dpr;
    }

    ctx.translate(px, py);
    if (f.rotation !== 0) ctx.rotate(f.rotation);

    const sx = f.facing * f.scale * f.squash.sx * invAtlas;
    const sy = f.scale * f.squash.sy * invAtlas;
    if (sx !== 1 || sy !== 1) ctx.scale(sx, sy);

    ctx.globalAlpha = f.opacity;

    ctx.drawImage(
      this.atlas as never,
      cell.x,
      cell.y,
      cell.w,
      cell.h,
      -cell.anchor[0],
      -cell.anchor[1],
      cell.w,
      cell.h,
    );

    ctx.restore();

    // Effects render in world space, unmirrored — a `zzz` should not flip just
    // because the pet happens to be facing left. The effects atlas lands with
    // the game layer; until then this loop is inert by construction.
    for (const _fx of f.effects) {
      void _fx;
    }
  }

  /**
   * Development overlay: platform edges, the world bound, and the pet's anchor.
   *
   * This is the tool for the Phase 2 gate — "stands on the top edge of a real
   * window at the correct pixel" is exactly the kind of off-by-7px error that
   * `DWMWA_EXTENDED_FRAME_BOUNDS` exists to prevent, and it is invisible
   * without something drawing the platform line you think you computed.
   */
  drawDebug(world: World, f: RenderFrame): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;

    ctx.strokeStyle = 'rgba(80, 200, 255, 0.55)';
    for (const p of world.platforms) {
      ctx.beginPath();
      ctx.moveTo(p.x0, p.y + 0.5);
      ctx.lineTo(p.x1, p.y + 0.5);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(255, 200, 90, 0.55)';
    for (const c of world.ceilings) {
      ctx.beginPath();
      ctx.moveTo(c.x0, c.y - 0.5);
      ctx.lineTo(c.x1, c.y - 0.5);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(255, 90, 140, 0.9)';
    ctx.beginPath();
    ctx.arc(f.x, f.y, 3, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }
}
