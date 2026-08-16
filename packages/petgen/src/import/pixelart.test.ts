import { describe, expect, it } from 'vitest';
import { detectForImport, detectPixelArt, downscaleBy } from './pixelart.js';
import { makeRaster, sameRaster, type Raster } from './raster.js';

function set(r: Raster, x: number, y: number, rgb: [number, number, number], a = 255): void {
  const i = (y * r.w + x) * 4;
  r.data[i] = rgb[0];
  r.data[i + 1] = rgb[1];
  r.data[i + 2] = rgb[2];
  r.data[i + 3] = a;
}

/** A little 8x8 two-colour sprite with an irregular outline. */
function nativeSprite(): Raster {
  const r = makeRaster(8, 8);
  for (let y = 2; y < 8; y++) {
    for (let x = 1; x < 7; x++) {
      if ((x + y) % 5 === 0) continue; // ragged edge, so runs vary
      set(r, x, y, y < 5 ? [200, 40, 40] : [40, 40, 200]);
    }
  }
  return r;
}

/** Nearest-neighbour upscale, the thing detection has to undo. */
function upscale(r: Raster, k: number): Raster {
  const out = makeRaster(r.w * k, r.h * k);
  for (let y = 0; y < out.h; y++) {
    for (let x = 0; x < out.w; x++) {
      const s = ((Math.floor(y / k) * r.w) + Math.floor(x / k)) * 4;
      const d = (y * out.w + x) * 4;
      out.data[d] = r.data[s]!;
      out.data[d + 1] = r.data[s + 1]!;
      out.data[d + 2] = r.data[s + 2]!;
      out.data[d + 3] = r.data[s + 3]!;
    }
  }
  return out;
}

describe('detectPixelArt', () => {
  it('detects a 3x nearest-neighbour upscale and recovers the native image', () => {
    const native = nativeSprite();
    const up = upscale(native, 3);
    const v = detectPixelArt(up);
    expect(v.pixelArt).toBe(true);
    expect(v.scale).toBe(3);
    expect(sameRaster(downscaleBy(up, v.scale), native)).toBe(true);
  });

  it('calls native-resolution pixel art pixel art, without a downscale', () => {
    const v = detectPixelArt(nativeSprite());
    expect(v.pixelArt).toBe(true);
    expect(v.scale).toBe(1);
  });

  it('does not call smooth gradient content pixel art', () => {
    const r = makeRaster(64, 64);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        // Hundreds of unique colours, soft alpha edge — photographic-ish.
        set(r, x, y, [x * 4, y * 4, (x ^ y) & 255], Math.min(255, 40 + x * 3 + (y % 7)));
      }
    }
    const v = detectPixelArt(r);
    expect(v.pixelArt).toBe(false);
    expect(v.scale).toBe(1);
  });
});

describe('detectPixelArt on white sprites', () => {
  it('does not fold opaque white into the transparent sentinel', () => {
    // Opaque white packs to 0xFFFFFFFF, which is -1 in signed 32-bit — the
    // same value as the transparent sentinel. Before the unsigned fix, white
    // runs merged with the background: a native-res white sprite lost its odd
    // run boundaries, read as a 2x upscale, and was destructively downscaled.
    const mk = (rgb: [number, number, number]) => {
      const r = makeRaster(32, 32);
      for (let y = 4; y < 29; y++) for (let x = 5; x < 26; x++) set(r, x, y, rgb); // 21x25 body
      set(r, 14, 10, [0, 0, 0]);
      set(r, 15, 10, [0, 0, 0]);
      set(r, 14, 11, [0, 0, 0]);
      set(r, 15, 11, [0, 0, 0]); // 2x2 eye
      return r;
    };
    const red = detectPixelArt(mk([200, 40, 40]));
    const white = detectPixelArt(mk([255, 255, 255]));
    expect(white.scale).toBe(red.scale);
    expect(white.scale).toBe(1);
  });
});

describe('detectForImport', () => {
  /** A 24x24 frame whose every run length is even — an accidental "2x". */
  function blockyFrame(): Raster {
    const r = makeRaster(24, 24);
    for (let y = 12; y < 22; y += 2) {
      for (let x = 4; x < 20; x += 4) {
        set(r, x, y, [200, 40, 40]);
        set(r, x + 1, y, [200, 40, 40]);
        set(r, x, y + 1, [200, 40, 40]);
        set(r, x + 1, y + 1, [200, 40, 40]);
      }
    }
    return r;
  }

  it('one blocky frame alone reads as a false 2x upscale — the ambiguity is real', () => {
    // Not an assertion about desired behavior: it documents WHY stacking
    // exists. A 2px feature at native res is pixel-identical to 1px at 2x.
    expect(detectPixelArt(blockyFrame()).scale).toBe(2);
  });

  it('a second frame with an odd-length feature breaks the false GCD', () => {
    const odd = makeRaster(24, 24);
    for (let x = 5; x < 14; x++) set(odd, x, 21, [40, 40, 200]); // a 9px bar
    for (let x = 5; x < 14; x++) for (let y = 13; y < 21; y++) set(odd, x, y, [40, 40, 200]);
    const v = detectForImport([blockyFrame(), odd]);
    expect(v.scale).toBe(1);
  });

  it('combines evidence across mixed-width frames instead of trusting frame 0', () => {
    // The blocky frame alone reads as 2x. A differently-SIZED frame with an
    // odd feature must still break the false GCD — falling back to frame 0
    // when stacking is impossible reinstated the one-frame failure.
    const odd = makeRaster(34, 30);
    for (let x = 5; x < 14; x++) for (let y = 12; y < 27; y++) set(odd, x, y, [40, 40, 200]);
    for (let x = 5; x < 14; x++) set(odd, x, 27, [40, 40, 200]); // 9px bar
    const v = detectForImport([blockyFrame(), odd]);
    expect(v.scale).toBe(1);
  });

  it('a genuine upscale survives mixed-width combination', () => {
    const a = makeRaster(20, 20);
    const b = makeRaster(24, 18);
    for (let y = 2; y < 19; y++)
      for (let x = 2; x < 18; x++) if ((x * 3 + y) % 7 !== 0) set(a, x, y, [200, 40, 40]);
    for (let y = 2; y < 17; y++)
      for (let x = 2; x < 22; x++) if ((x * 5 + y) % 6 !== 0) set(b, x, y, [40, 40, 200]);
    const v = detectForImport([upscale(a, 2), upscale(b, 2)]);
    expect(v.scale).toBe(2);
  });

  it('suppresses the binary-alpha vote when the alpha was synthesized', () => {
    // Flood-fill removal writes alpha as exactly 0/255, so binary alpha is
    // true by construction and carries no evidence. Flat-colour smooth art
    // (few colours + synthetic binary alpha) must NOT reach two votes.
    const flat = makeRaster(64, 64);
    for (let y = 10; y < 54; y++)
      for (let x = 10; x < 54; x++)
        if ((x * 3 + y) % 11 !== 0) set(flat, x, y, [90, 150, 210]); // one colour, ragged
    expect(detectForImport([flat]).pixelArt).toBe(true); // authored alpha: pixel-arty
    expect(detectForImport([flat], { alphaSynthetic: true }).pixelArt).toBe(false);
  });

  it('refuses a downscale that would leave the sprite under 8px', () => {
    // All-even runs AND a plausible k, but the "native" sprite would be 5x4.
    const tiny = makeRaster(16, 16);
    for (let y = 6; y < 14; y++) for (let x = 2; x < 12; x++) set(tiny, x, y, [90, 200, 90]);
    const v = detectForImport([tiny]);
    expect(v.scale).toBe(1);
  });

  it('a genuine upscale of a detailed sprite still comes through', () => {
    // Big enough that the recovered native content clears the 8px guard.
    const native = makeRaster(20, 20);
    for (let y = 2; y < 19; y++) {
      for (let x = 2; x < 18; x++) {
        if ((x * 3 + y) % 7 === 0) continue; // ragged: run lengths hit odd values
        set(native, x, y, y < 10 ? [200, 40, 40] : [40, 40, 200]);
      }
    }
    const up2 = upscale(native, 2);
    const v = detectForImport([up2, up2]);
    expect(v.pixelArt).toBe(true);
    expect(v.scale).toBe(2);
    expect(sameRaster(downscaleBy(up2, 2), native)).toBe(true);
  });
});
