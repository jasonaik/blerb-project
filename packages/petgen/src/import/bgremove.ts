/**
 * Background removal for `from-image`: the input is one photo-ish picture of
 * a character, usually on a flat backdrop, and the pet needs to be cut out.
 *
 * Flood fill from the corners, not chroma-key: only pixels CONNECTED to the
 * image edge are background, so a white character on a white backdrop keeps
 * its interior (eyes, teeth, highlights) — those regions aren't reachable
 * from outside. This is also why the input requirements ask for a ≥2px
 * margin: the fill needs a moat.
 */

import type { Raster } from './raster.js';

/**
 * Perceptually-weighted colour distance, 0..1. Green dominates luminance
 * perception; the 2/4/3 weights are the classic cheap approximation.
 */
function dist(r: Raster, i: number, c: readonly [number, number, number]): number {
  const dr = r.data[i]! - c[0];
  const dg = r.data[i + 1]! - c[1];
  const db = r.data[i + 2]! - c[2];
  return Math.sqrt(2 * dr * dr + 4 * dg * dg + 3 * db * db) / 765;
}

export interface RemovalResult {
  out: Raster;
  /** Fraction of pixels removed, 0..1. ~0 means no backdrop was found. */
  removed: number;
}

/**
 * Remove the edge-connected backdrop. `tolerance` is the perceptual distance
 * (0..1) a pixel may sit from a corner colour and still count as backdrop;
 * 0.10 forgives JPEG noise and soft vignettes without eating pale characters.
 */
export function removeBackground(src: Raster, tolerance = 0.1): RemovalResult {
  const { w, h } = src;
  const out: Raster = { w, h, data: new Uint8Array(src.data) };

  // The backdrop's colours, sampled where the backdrop must be: the corners.
  // Four samples, deduplicated loosely, so a subtle gradient still matches.
  const corners: [number, number, number][] = [];
  for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]] as const) {
    const i = (y * w + x) * 4;
    corners.push([out.data[i]!, out.data[i + 1]!, out.data[i + 2]!]);
  }
  const isBackdrop = (i: number) => corners.some((c) => dist(out, i, c) <= tolerance);

  // BFS from every edge pixel that looks like backdrop.
  const visited = new Uint8Array(w * h);
  const queue: number[] = [];
  const push = (x: number, y: number) => {
    const p = y * w + x;
    if (visited[p]) return;
    visited[p] = 1;
    if (out.data[p * 4 + 3]! >= 8 && isBackdrop(p * 4)) queue.push(p);
  };
  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    push(0, y);
    push(w - 1, y);
  }

  let removed = 0;
  while (queue.length > 0) {
    const p = queue.pop()!;
    out.data[p * 4 + 3] = 0;
    removed++;
    const x = p % w;
    const y = (p / w) | 0;
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const np = ny * w + nx;
      if (visited[np]) continue;
      visited[np] = 1;
      if (out.data[np * 4 + 3]! >= 8 && isBackdrop(np * 4)) queue.push(np);
    }
  }

  return { out, removed: removed / (w * h) };
}

/**
 * Soften the cut edge by one pixel: any surviving pixel that touches a
 * removed/empty one gets half alpha. For smooth art this hides the fringe of
 * backdrop-coloured pixels the tolerance left behind; for pixel art it would
 * blur the outline, so from-image skips it when the art detects as pixel art.
 */
export function erodeEdge(src: Raster): Raster {
  const { w, h } = src;
  const out: Raster = { w, h, data: new Uint8Array(src.data) };
  const empty = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= w || y >= h) return true;
    return src.data[(y * w + x) * 4 + 3]! < 8;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (src.data[i + 3]! < 8) continue;
      if (empty(x - 1, y) || empty(x + 1, y) || empty(x, y - 1) || empty(x, y + 1)) {
        out.data[i + 3] = Math.floor(src.data[i + 3]! / 2);
      }
    }
  }
  return out;
}
