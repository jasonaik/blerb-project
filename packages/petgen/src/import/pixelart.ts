/**
 * Is this pixel art, and was it upscaled?
 *
 * Majority vote of three independent signals, per the plan:
 *   1. few unique colours (≤64 among visible pixels)
 *   2. near-binary alpha (pixel art has hard edges, not antialiased ones)
 *   3. run-length GCD ≥ 2 — art upscaled k× nearest-neighbour has every run of
 *      identical pixels a multiple of k, which photographic content never does
 *
 * Signal 3 doubles as the downscale factor: if the GCD is k ≥ 2, the source
 * was upscaled and we take every k-th pixel to recover the native resolution.
 * Pixel art must ship at native resolution or `pixelArt: true` rendering
 * (integer scaling, no smoothing) magnifies the upscale artifacts.
 */

import { makeRaster, trimBox, type Raster } from './raster.js';

export interface PixelArtVerdict {
  pixelArt: boolean;
  /** Nearest-neighbour upscale factor detected; 1 = native. */
  scale: number;
  votes: { fewColours: boolean; binaryAlpha: boolean; gridRuns: boolean };
}

const MAX_COLOURS = 64;
const BINARY_ALPHA_FRACTION = 0.95;
/** Enough runs to be statistically meaningful without scanning a 4K image forever. */
const MAX_RUNS = 20_000;

function uniqueColourVote(r: Raster): boolean {
  const seen = new Set<number>();
  for (let i = 0; i < r.data.length; i += 4) {
    if (r.data[i + 3]! < 8) continue;
    seen.add((r.data[i]! << 16) | (r.data[i + 1]! << 8) | r.data[i + 2]!);
    if (seen.size > MAX_COLOURS) return false;
  }
  return seen.size > 0;
}

function binaryAlphaVote(r: Raster): boolean {
  let binary = 0,
    total = 0;
  for (let i = 3; i < r.data.length; i += 4) {
    total++;
    const a = r.data[i]!;
    if (a <= 8 || a >= 247) binary++;
  }
  return total > 0 && binary / total >= BINARY_ALPHA_FRACTION;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * GCD of horizontal and vertical run lengths of identical RGBA values,
 * plus the image dimensions themselves (an upscaled image's dimensions are
 * multiples of the factor too).
 */
function runGcd(r: Raster): number {
  let g = gcd(r.w, r.h);
  let runs = 0;

  const px = (x: number, y: number): number => {
    const i = (y * r.w + x) * 4;
    // Fold fully-transparent pixels to one value regardless of their RGB.
    if (r.data[i + 3]! < 8) return -1;
    // >>> 0 keeps the packed value unsigned: opaque white would otherwise be
    // 0xFFFFFFFF === -1, colliding with the sentinel above — which merged
    // white runs with the background and got white sprites falsely detected
    // as upscaled, then destructively downscaled.
    return ((r.data[i]! << 24) | (r.data[i + 1]! << 16) | (r.data[i + 2]! << 8) | r.data[i + 3]!) >>> 0;
  };

  for (let y = 0; y < r.h && runs < MAX_RUNS && g > 1; y++) {
    let start = 0;
    let value = px(0, y);
    for (let x = 1; x <= r.w; x++) {
      const v = x < r.w ? px(x, y) : NaN;
      if (v !== value) {
        g = gcd(g, x - start);
        runs++;
        start = x;
        value = v;
      }
    }
  }
  for (let x = 0; x < r.w && runs < MAX_RUNS && g > 1; x++) {
    let start = 0;
    let value = px(x, 0);
    for (let y = 1; y <= r.h; y++) {
      const v = y < r.h ? px(x, y) : NaN;
      if (v !== value) {
        g = gcd(g, y - start);
        runs++;
        start = y;
        value = v;
      }
    }
  }
  return g;
}

export function detectPixelArt(r: Raster): PixelArtVerdict {
  const votes = {
    fewColours: uniqueColourVote(r),
    binaryAlpha: binaryAlphaVote(r),
    gridRuns: false,
  };
  const k = runGcd(r);
  votes.gridRuns = k >= 2;

  const count = (votes.fewColours ? 1 : 0) + (votes.binaryAlpha ? 1 : 0) + (votes.gridRuns ? 1 : 0);
  const pixelArt = count >= 2;
  return { pixelArt, scale: pixelArt && k >= 2 ? k : 1, votes };
}

/**
 * Detection as the import commands should call it: over EVERY frame at once,
 * with a plausibility guard on the result.
 *
 * Two failure modes this exists to prevent, both found by test:
 *   - one blocky frame alone can have all-even run lengths by coincidence
 *     (a 2px bar at native resolution is pixel-for-pixel identical to a 1px
 *     bar at 2x — the ambiguity is inherent). Stacking every frame into one
 *     image lets any frame with an odd-length feature break the false GCD.
 *   - if the "native" image implied by the GCD would be tiny, the sprite
 *     really was just small and blocky — refuse the downscale. No real
 *     character is drawn 7px tall.
 */
export function detectForImport(frames: readonly Raster[]): PixelArtVerdict {
  const first = frames[0];
  if (!first) return { pixelArt: false, scale: 1, votes: { fewColours: false, binaryAlpha: false, gridRuns: false } };

  if (frames.every((f) => f.w === first.w)) {
    // Same width: stack into one image and detect in a single pass.
    let sample = first;
    if (frames.length > 1) {
      const h = frames.reduce((sum, f) => sum + f.h, 0);
      sample = makeRaster(first.w, h);
      let y = 0;
      for (const f of frames) {
        sample.data.set(f.data, y * first.w * 4);
        y += f.h;
      }
    }
    const v = detectPixelArt(sample);
    if (v.scale >= 2) {
      const box = trimBox(sample);
      const nativeW = box ? (box.x1 - box.x0 + 1) / v.scale : 0;
      const nativeH = box ? (box.y1 - box.y0 + 1) / v.scale : 0;
      if (nativeW < 8 || nativeH < 8) return { ...v, scale: 1 };
    }
    return v;
  }

  // Mixed canvas sizes can't stack, but per-frame combination is equivalent:
  // a genuine kx upscale keeps every frame's run GCD a multiple of k, and any
  // single frame with an odd-length feature collapses a false factor to 1 —
  // exactly what it would have done inside the stack. Falling back to frame 0
  // alone (the old behavior) reinstated the one-frame coincidence failure.
  const votes = {
    fewColours: frames.every(uniqueColourVote),
    binaryAlpha: frames.every(binaryAlphaVote),
    gridRuns: false,
  };
  let k = 0;
  for (const f of frames) k = gcd(k, runGcd(f));
  votes.gridRuns = k >= 2;
  const count = (votes.fewColours ? 1 : 0) + (votes.binaryAlpha ? 1 : 0) + (votes.gridRuns ? 1 : 0);
  const pixelArt = count >= 2;
  let scale = pixelArt && k >= 2 ? k : 1;

  if (scale >= 2) {
    // Stricter than the stacked guard, per frame — refusing is the safe
    // direction when a downscale could destroy legitimate art.
    for (const f of frames) {
      const box = trimBox(f);
      if (!box) continue;
      if ((box.x1 - box.x0 + 1) / scale < 8 || (box.y1 - box.y0 + 1) / scale < 8) {
        scale = 1;
        break;
      }
    }
  }
  return { pixelArt, scale, votes };
}

/** Take every k-th pixel — exact inverse of a nearest-neighbour upscale. */
export function downscaleBy(r: Raster, k: number): Raster {
  const out = makeRaster(Math.floor(r.w / k), Math.floor(r.h / k));
  for (let y = 0; y < out.h; y++) {
    for (let x = 0; x < out.w; x++) {
      const s = (y * k * r.w + x * k) * 4;
      const d = (y * out.w + x) * 4;
      out.data[d] = r.data[s]!;
      out.data[d + 1] = r.data[s + 1]!;
      out.data[d + 2] = r.data[s + 2]!;
      out.data[d + 3] = r.data[s + 3]!;
    }
  }
  return out;
}
