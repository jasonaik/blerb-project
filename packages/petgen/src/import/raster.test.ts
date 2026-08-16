import { describe, expect, it } from 'vitest';
import {
  alphaAt,
  blit,
  collapseDuplicates,
  compositeAlpha,
  crop,
  deriveAnchor,
  hasAlphaChannel,
  makeRaster,
  transparentFraction,
  sameRaster,
  trimBox,
  unionBox,
  type Raster,
} from './raster.js';

/** Set an opaque white pixel. */
function px(r: Raster, x: number, y: number, a = 255): void {
  const i = (y * r.w + x) * 4;
  r.data[i] = 255;
  r.data[i + 1] = 255;
  r.data[i + 2] = 255;
  r.data[i + 3] = a;
}

function rect(r: Raster, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) px(r, x, y);
}

describe('trimBox', () => {
  it('finds tight bounds', () => {
    const r = makeRaster(10, 10);
    rect(r, 2, 3, 5, 7);
    expect(trimBox(r)).toEqual({ x0: 2, y0: 3, x1: 5, y1: 7 });
  });

  it('is null for an empty image', () => {
    expect(trimBox(makeRaster(4, 4))).toBeNull();
  });

  it('ignores near-zero alpha noise', () => {
    const r = makeRaster(10, 10);
    px(r, 0, 0, 4); // below threshold
    px(r, 5, 5);
    expect(trimBox(r)).toEqual({ x0: 5, y0: 5, x1: 5, y1: 5 });
  });
});

describe('unionBox', () => {
  it('unions', () => {
    expect(unionBox({ x0: 1, y0: 1, x1: 3, y1: 3 }, { x0: 2, y0: 0, x1: 5, y1: 2 })).toEqual({
      x0: 1,
      y0: 0,
      x1: 5,
      y1: 3,
    });
  });
});

describe('deriveAnchor', () => {
  it('centres on a single foot column mass', () => {
    const r = makeRaster(21, 20);
    rect(r, 5, 4, 15, 19); // symmetric body, feet on the bottom row
    const box = trimBox(r)!;
    const a = deriveAnchor(compositeAlpha([r]), box);
    expect(a.ay).toBe(19);
    expect(a.ax).toBeCloseTo(10, 5);
  });

  it('uses the feet band, not the whole silhouette', () => {
    // Body mass leans hard right, but the feet are on the left.
    const r = makeRaster(30, 30);
    rect(r, 10, 0, 29, 25); // big body, right side
    rect(r, 2, 26, 6, 29); // little feet, bottom left
    const a = deriveAnchor(compositeAlpha([r]), trimBox(r)!);
    // Anchored at the feet (x≈4), not the body centroid (x≈19).
    expect(a.ax).toBeGreaterThan(2);
    expect(a.ax).toBeLessThan(7);
  });

  it('takes the midpoint of two disjoint feet', () => {
    const r = makeRaster(40, 40);
    rect(r, 5, 0, 35, 35); // body, stopping above the feet band
    rect(r, 6, 37, 10, 39); // left foot
    rect(r, 28, 37, 32, 39); // right foot, slightly narrower placement
    const a = deriveAnchor(compositeAlpha([r]), trimBox(r)!);
    expect(a.ax).toBeCloseTo((8 + 30) / 2, 5);
    expect(a.ay).toBe(39);
  });

  it('ignores sub-threshold alpha in the feet band, matching trimBox', () => {
    // One alpha=4 pixel — invisible, and below the threshold trimBox uses —
    // used to register as a phantom disjoint foot and drag the anchor to the
    // midpoint between it and the real feet: a 2.5px shift from nothing.
    const mk = (noise: boolean) => {
      const r = makeRaster(20, 20);
      rect(r, 5, 4, 15, 16); // body
      rect(r, 9, 17, 11, 19); // feet
      if (noise) px(r, 5, 19, 4);
      return r;
    };
    const clean = deriveAnchor(compositeAlpha([mk(false)]), trimBox(mk(false))!);
    const noisy = deriveAnchor(compositeAlpha([mk(true)]), trimBox(mk(true))!);
    expect(noisy.ax).toBe(clean.ax);
  });

  it('does not list toward the heavier leg', () => {
    const r = makeRaster(40, 40);
    rect(r, 5, 0, 35, 35);
    rect(r, 4, 37, 14, 39); // big front leg
    rect(r, 30, 37, 32, 39); // small trailing leg
    const a = deriveAnchor(compositeAlpha([r]), trimBox(r)!);
    // Midpoint of leg centroids (9 and 31) = 20, not the weighted 12-ish.
    expect(a.ax).toBeCloseTo(20, 5);
  });
});

describe('compositeAlpha', () => {
  it('is the max across frames', () => {
    const a = makeRaster(4, 4);
    const b = makeRaster(4, 4);
    px(a, 1, 1, 100);
    px(b, 1, 1, 200);
    px(b, 2, 2, 50);
    const c = compositeAlpha([a, b]);
    expect(c(1, 1)).toBe(200);
    expect(c(2, 2)).toBe(50);
    expect(c(0, 0)).toBe(0);
  });
});

describe('blit / crop / sameRaster', () => {
  it('round-trips through crop', () => {
    const r = makeRaster(10, 10);
    rect(r, 2, 2, 7, 7);
    const c = crop(r, 2, 2, 6, 6);
    expect(c.w).toBe(6);
    expect(alphaAt(c, 0, 0)).toBe(255);
    expect(alphaAt(c, 5, 5)).toBe(255);
  });

  it('clips at destination edges without throwing', () => {
    const dest = makeRaster(4, 4);
    const src = makeRaster(4, 4);
    rect(src, 0, 0, 3, 3);
    blit(dest, src, { x0: 0, y0: 0, x1: 3, y1: 3 }, -2, -2);
    expect(alphaAt(dest, 0, 0)).toBe(255);
    expect(alphaAt(dest, 1, 1)).toBe(255);
  });

  it('sameRaster is exact', () => {
    const a = makeRaster(3, 3);
    const b = makeRaster(3, 3);
    expect(sameRaster(a, b)).toBe(true);
    px(b, 1, 1, 200);
    expect(sameRaster(a, b)).toBe(false);
  });
});

describe('hasAlphaChannel', () => {
  it('is false for a fully opaque image', () => {
    const r = makeRaster(3, 3);
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) px(r, x, y);
    expect(hasAlphaChannel(r)).toBe(false);
  });

  it('is true the moment any pixel is not fully opaque', () => {
    const r = makeRaster(3, 3);
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) px(r, x, y);
    px(r, 1, 1, 254);
    expect(hasAlphaChannel(r)).toBe(true);
  });

  it('transparentFraction counts genuinely transparent pixels, not near-opaque ones', () => {
    const r = makeRaster(10, 10);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) px(r, x, y);
    px(r, 0, 0, 254); // not transparent — must not count
    expect(transparentFraction(r)).toBe(0);
    px(r, 1, 0, 0);
    px(r, 2, 0, 3);
    expect(transparentFraction(r)).toBeCloseTo(0.02, 10);
  });
});

describe('collapseDuplicates', () => {
  it('stores a repeated frame once but keeps its timing as a repeated index', () => {
    const a = makeRaster(4, 4);
    px(a, 0, 0);
    const a2 = makeRaster(4, 4);
    px(a2, 0, 0); // byte-identical to a, different object
    const b = makeRaster(4, 4);
    px(b, 1, 1);
    const { unique, play } = collapseDuplicates([a, a2, b, b, a]);
    // Only CONSECUTIVE duplicates collapse — the trailing `a` is a new cell,
    // because frames play forward and the atlas is ordered by first use.
    expect(unique).toHaveLength(3);
    expect(play).toEqual([0, 0, 1, 1, 2]);
  });

  it('passes distinct frames through untouched', () => {
    const frames = [1, 2, 3].map((n) => {
      const r = makeRaster(4, 4);
      px(r, n, n);
      return r;
    });
    const { unique, play } = collapseDuplicates(frames);
    expect(unique).toHaveLength(3);
    expect(play).toEqual([0, 1, 2]);
  });
});
