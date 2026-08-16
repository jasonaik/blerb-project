import { describe, expect, it } from 'vitest';
import { erodeEdge, removeBackground } from './bgremove.js';
import { alphaAt, makeRaster, type Raster } from './raster.js';

function set(r: Raster, x: number, y: number, rgb: [number, number, number], a = 255): void {
  const i = (y * r.w + x) * 4;
  r.data[i] = rgb[0];
  r.data[i + 1] = rgb[1];
  r.data[i + 2] = rgb[2];
  r.data[i + 3] = a;
}

function fill(r: Raster, rgb: [number, number, number]): void {
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) set(r, x, y, rgb);
}

const WHITE: [number, number, number] = [250, 250, 250];
const RED: [number, number, number] = [200, 40, 40];

describe('removeBackground', () => {
  it('removes an edge-connected backdrop but keeps same-coloured interior', () => {
    // White backdrop, red character, WHITE eye inside the character. The eye
    // matches the backdrop colour exactly but is not reachable from the edge,
    // so it must survive — this is why it is a flood fill and not a chroma key.
    const r = makeRaster(20, 20);
    fill(r, WHITE);
    for (let y = 4; y < 17; y++) for (let x = 4; x < 16; x++) set(r, x, y, RED);
    set(r, 8, 8, WHITE);
    set(r, 9, 8, WHITE);

    const { out, removed } = removeBackground(r);
    expect(removed).toBeGreaterThan(0.4);
    expect(alphaAt(out, 0, 0)).toBe(0); // backdrop gone
    expect(alphaAt(out, 10, 10)).toBe(255); // body intact
    expect(alphaAt(out, 8, 8)).toBe(255); // interior white survives
  });

  it('forgives backdrop noise within the tolerance', () => {
    const r = makeRaster(12, 12);
    fill(r, WHITE);
    // Slightly off-white noise across the backdrop, as JPEG leaves behind.
    set(r, 3, 0, [240, 244, 246]);
    set(r, 0, 5, [244, 240, 241]);
    for (let y = 4; y < 10; y++) for (let x = 4; x < 9; x++) set(r, x, y, RED);
    const { out } = removeBackground(r);
    expect(alphaAt(out, 3, 0)).toBe(0);
    expect(alphaAt(out, 0, 5)).toBe(0);
    expect(alphaAt(out, 5, 5)).toBe(255);
  });

  it('a borderless character eats itself — which is why the docs demand a margin', () => {
    // Character fills the frame: the corners ARE the character, so the fill
    // consumes everything. from-image turns this into a hard error via its
    // nothing-left-after-removal check rather than emitting an empty pet.
    const r = makeRaster(10, 10);
    fill(r, RED);
    const { removed } = removeBackground(r);
    expect(removed).toBeGreaterThan(0.9);
  });

  it('leaves an image with a distinct character mostly intact', () => {
    const r = makeRaster(16, 16);
    fill(r, [30, 120, 200]); // blue backdrop
    for (let y = 3; y < 14; y++) for (let x = 3; x < 13; x++) set(r, x, y, RED);
    const { out } = removeBackground(r);
    let kept = 0;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (alphaAt(out, x, y) > 0) kept++;
    expect(kept).toBe(11 * 10);
  });
});

describe('erodeEdge', () => {
  it('halves alpha on the cut boundary only', () => {
    const r = makeRaster(10, 10);
    for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) set(r, x, y, RED);
    const out = erodeEdge(r);
    expect(alphaAt(out, 2, 2)).toBe(127); // boundary softened
    expect(alphaAt(out, 4, 4)).toBe(255); // interior untouched
    expect(alphaAt(out, 0, 0)).toBe(0); // outside untouched
  });
});
