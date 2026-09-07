/**
 * Background removal for opaque inputs: a picture (or a GIF's frames) of a
 * character, usually on a flat backdrop, and the pet needs to be cut out.
 *
 * Flood fill from the corners, not chroma-key: only pixels CONNECTED to the
 * image edge are background, so a white character on a white backdrop keeps
 * its interior (eyes, teeth, highlights) — those regions aren't reachable
 * from outside. This is also why the input requirements ask for a ≥2px
 * margin: the fill needs a moat.
 */

import type { Raster } from './raster.js';

export type RGB = readonly [number, number, number];

/**
 * Perceptually-weighted colour distance, 0..1. Green dominates luminance
 * perception; the 2/4/3 weights are the classic cheap approximation.
 */
function dist(r: Raster, i: number, c: RGB): number {
  const dr = r.data[i]! - c[0];
  const dg = r.data[i + 1]! - c[1];
  const db = r.data[i + 2]! - c[2];
  return Math.sqrt(2 * dr * dr + 4 * dg * dg + 3 * db * db) / 765;
}

/**
 * Removed pixels this close to a backdrop colour mean the backdrop met the
 * art in a hard step — no anti-aliased blend fringe. That is the evidence
 * the pixel-art detector's binary-alpha vote stood for, still observable in
 * the RGB after the alpha has been synthesized.
 */
const HARD_CUT = 0.02;

/** The backdrop's colours, sampled where the backdrop must be: the corners. */
export function cornerColours(r: Raster): RGB[] {
  const { w, h, data } = r;
  const out: RGB[] = [];
  for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]] as const) {
    const i = (y * w + x) * 4;
    out.push([data[i]!, data[i + 1]!, data[i + 2]!]);
  }
  return out;
}

/**
 * One backdrop for a whole animation: per corner position, the modal colour
 * across frames. A frame that happens to put a foot in a corner would
 * otherwise sample the CHARACTER as its backdrop and flood the character
 * away — the encoder flattened every frame onto the same colour, and the
 * other frames know what it was.
 */
export function sharedBackdrop(frames: readonly Raster[]): RGB[] {
  const out: RGB[] = [];
  for (let k = 0; k < 4; k++) {
    const counts = new Map<string, { c: RGB; n: number }>();
    for (const f of frames) {
      const c = cornerColours(f)[k]!;
      const key = c.join(',');
      const e = counts.get(key) ?? { c, n: 0 };
      e.n++;
      counts.set(key, e);
    }
    out.push([...counts.values()].sort((a, b) => b.n - a.n)[0]!.c);
  }
  return out;
}

export interface RemovalResult {
  out: Raster;
  /** Fraction of pixels removed, 0..1. ~0 means no backdrop was found. */
  removed: number;
  /** Every removed pixel was within HARD_CUT of the backdrop: no blend fringe. */
  hardCut: boolean;
}

/**
 * Remove the edge-connected backdrop. `tolerance` is the perceptual distance
 * (0..1) a pixel may sit from a backdrop colour and still count as backdrop;
 * 0.10 forgives JPEG noise and soft vignettes without eating pale characters.
 * `backdrop` defaults to this frame's own corners; a GIF passes the colours
 * shared across its frames.
 */
export function removeBackground(
  src: Raster,
  tolerance = 0.1,
  backdrop: readonly RGB[] = cornerColours(src),
): RemovalResult {
  const { w, h } = src;
  const out: Raster = { w, h, data: new Uint8Array(src.data) };

  const nearest = (i: number): number => {
    let best = Infinity;
    for (const c of backdrop) best = Math.min(best, dist(out, i, c));
    return best;
  };
  const isBackdrop = (i: number) => nearest(i) <= tolerance;

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
  let hardCut = true;
  while (queue.length > 0) {
    const p = queue.pop()!;
    if (hardCut && nearest(p * 4) > HARD_CUT) hardCut = false;
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

  return { out, removed: removed / (w * h), hardCut: removed > 0 && hardCut };
}

/**
 * Soften the cut edge by one pixel: any surviving pixel that touches a
 * removed/empty one gets half alpha. For smooth art this hides the fringe of
 * backdrop-coloured pixels the tolerance left behind; for pixel art it would
 * blur the outline, so the importers skip it when the art detects as pixel art.
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
