/**
 * Pure pixel operations over raw RGBA buffers. No sharp, no IO — everything
 * here is unit-testable with hand-built ten-pixel images, which is exactly how
 * it is tested.
 */

export interface Raster {
  w: number;
  h: number;
  /** RGBA, row-major, w*h*4 bytes. */
  data: Uint8Array;
}

/** Inclusive pixel bounds. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Alpha below this is treated as empty when trimming and deriving anchors. */
const ALPHA_MIN = 8;

export function makeRaster(w: number, h: number): Raster {
  return { w, h, data: new Uint8Array(w * h * 4) };
}

export function alphaAt(r: Raster, x: number, y: number): number {
  return r.data[(y * r.w + x) * 4 + 3] ?? 0;
}

/** Tight bounds of non-transparent content, or null for a fully empty image. */
export function trimBox(r: Raster): Box | null {
  let x0 = r.w,
    y0 = r.h,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      if (alphaAt(r, x, y) >= ALPHA_MIN) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

export function unionBox(a: Box, b: Box): Box {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

/**
 * Max-alpha composite of several same-sized frames, as an alpha-only accessor.
 * This is what anchor derivation runs on: the union of everywhere the
 * character ever is, so the anchor is stable across the whole animation
 * instead of jittering frame to frame.
 */
export function compositeAlpha(frames: readonly Raster[]): (x: number, y: number) => number {
  return (x, y) => {
    let a = 0;
    for (const f of frames) {
      const v = alphaAt(f, x, y);
      if (v > a) a = v;
    }
    return a;
  };
}

export interface Anchor {
  ax: number;
  ay: number;
}

/**
 * Where the feet are.
 *
 * ay is the lowest row with content — the contact row. ax is the alpha-weighted
 * centroid of the bottom 8% of the trimmed height (the feet band), NOT of the
 * whole silhouette: a character leaning forward has its mass ahead of its feet,
 * and anchoring at the mass centroid makes it toe-stand.
 *
 * When the feet band splits into two or more disjoint columns of content — a
 * character mid-stride, one leg forward — the anchor is the midpoint of the
 * leftmost and rightmost components' centroids, so it doesn't list toward
 * whichever leg happens to carry more pixels.
 */
export function deriveAnchor(alpha: (x: number, y: number) => number, box: Box): Anchor {
  const ay = box.y1;
  const bandH = Math.max(1, Math.ceil((box.y1 - box.y0 + 1) * 0.08));
  const yTop = Math.max(box.y0, ay - bandH + 1);

  // Column weights across the feet band. Same emptiness threshold as trimBox:
  // sub-threshold residue (antialiasing, faint shadow) must not register as a
  // phantom foot — one alpha=4 pixel used to shift the whole group's anchor.
  const weights: number[] = [];
  for (let x = box.x0; x <= box.x1; x++) {
    let w = 0;
    for (let y = yTop; y <= ay; y++) {
      const a = alpha(x, y);
      if (a >= ALPHA_MIN) w += a;
    }
    weights.push(w);
  }

  // Runs of columns with content = feet components.
  interface Run {
    sum: number;
    moment: number;
  }
  const runs: Run[] = [];
  let cur: Run | null = null;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i]!;
    if (w > 0) {
      cur ??= { sum: 0, moment: 0 };
      cur.sum += w;
      cur.moment += w * (box.x0 + i);
    } else if (cur) {
      runs.push(cur);
      cur = null;
    }
  }
  if (cur) runs.push(cur);

  if (runs.length === 0) return { ax: (box.x0 + box.x1) / 2, ay };
  if (runs.length === 1) {
    const r = runs[0]!;
    return { ax: r.moment / r.sum, ay };
  }
  const first = runs[0]!;
  const last = runs[runs.length - 1]!;
  return { ax: (first.moment / first.sum + last.moment / last.sum) / 2, ay };
}

/** Copy src[box] into dest with the given offset. Silently clips at dest edges. */
export function blit(dest: Raster, src: Raster, box: Box, dx: number, dy: number): void {
  for (let y = box.y0; y <= box.y1; y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= dest.h) continue;
    for (let x = box.x0; x <= box.x1; x++) {
      const tx = x + dx;
      if (tx < 0 || tx >= dest.w) continue;
      const s = (y * src.w + x) * 4;
      const d = (ty * dest.w + tx) * 4;
      dest.data[d] = src.data[s]!;
      dest.data[d + 1] = src.data[s + 1]!;
      dest.data[d + 2] = src.data[s + 2]!;
      dest.data[d + 3] = src.data[s + 3]!;
    }
  }
}

/** Byte-identical? Used to collapse duplicate GIF frames. */
export function sameRaster(a: Raster, b: Raster): boolean {
  if (a.w !== b.w || a.h !== b.h) return false;
  const x = a.data,
    y = b.data;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/**
 * Collapse byte-identical consecutive frames: unique frames once, plus a play
 * list that repeats indices where the source repeated frames. GIF optimizers
 * emit duplicates freely; storing them would pay atlas space for timing.
 */
export function collapseDuplicates(frames: readonly Raster[]): {
  unique: Raster[];
  play: number[];
} {
  const unique: Raster[] = [];
  const play: number[] = [];
  for (const f of frames) {
    const prev = unique.length > 0 ? unique[unique.length - 1]! : null;
    if (prev && sameRaster(prev, f)) {
      play.push(unique.length - 1);
    } else {
      unique.push(f);
      play.push(unique.length - 1);
    }
  }
  return { unique, play };
}

/** Cut a sub-rectangle out as its own raster. */
export function crop(src: Raster, x: number, y: number, w: number, h: number): Raster {
  const out = makeRaster(w, h);
  blit(out, src, { x0: x, y0: y, x1: x + w - 1, y1: y + h - 1 }, -x, -y);
  return out;
}

/** Does the raster contain ANY pixel that is not fully opaque? One is enough. */
export function hasAlphaChannel(r: Raster): boolean {
  for (let i = 3; i < r.data.length; i += 4) {
    if (r.data[i]! < 255) return true;
  }
  return false;
}

/**
 * Fraction of pixels that are actually transparent (below the trim
 * threshold). The honest test for "is this image already cut out" — one
 * stray 254-alpha pixel is not a cut-out, and treating it as one silently
 * skipped background removal on otherwise-opaque art.
 */
export function transparentFraction(r: Raster): number {
  let n = 0;
  for (let i = 3; i < r.data.length; i += 4) {
    if (r.data[i]! < 8) n++;
  }
  return n / (r.data.length / 4);
}
