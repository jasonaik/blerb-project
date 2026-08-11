import { describe, expect, it } from 'vitest';
import { alignGroup, buildAtlas } from './layout.js';
import { alphaAt, crop, makeRaster, trimBox, type Raster } from './raster.js';

function px(r: Raster, x: number, y: number): void {
  const i = (y * r.w + x) * 4;
  r.data[i] = 255;
  r.data[i + 1] = 255;
  r.data[i + 2] = 255;
  r.data[i + 3] = 255;
}

function rect(r: Raster, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) px(r, x, y);
}

/** Cell rect for atlas index i under the emitted grid layout. */
function cellRect(l: ReturnType<typeof buildAtlas>, i: number) {
  const col = i % l.cols;
  const row = Math.floor(i / l.cols);
  return {
    x: l.margin + col * (l.cellW + l.spacing),
    y: l.margin + row * (l.cellH + l.spacing),
  };
}

describe('alignGroup', () => {
  it('shares one box and one anchor across registered frames', () => {
    const a = makeRaster(20, 20);
    const b = makeRaster(20, 20);
    rect(a, 8, 10, 11, 19);
    rect(b, 8, 8, 11, 17); // same shape, drawn 2px higher (mid-bob)
    const [fa, fb] = alignGroup([a, b]);
    expect(fa!.box).toEqual(fb!.box);
    expect(fa!.box).toEqual({ x0: 8, y0: 8, x1: 11, y1: 19 });
    expect(fa!.ax).toBe(fb!.ax);
    expect(fa!.ay).toBe(19); // the contact row, from the composite
  });

  it('rejects mixed canvas sizes', () => {
    expect(() => alignGroup([makeRaster(10, 10), makeRaster(12, 10)])).toThrow(/share a canvas/);
  });

  it('rejects all-transparent input', () => {
    expect(() => alignGroup([makeRaster(10, 10)])).toThrow(/transparent/);
  });
});

describe('buildAtlas', () => {
  it('preserves the bob: registration survives import', () => {
    // THE test for this module. Three frames off one canvas; the square rides
    // 1px up in the middle frame. If import tight-trimmed each frame
    // individually, all three cells would come out identical and the walk
    // cycle would be a statue.
    const mk = (top: number) => {
      const r = makeRaster(20, 20);
      rect(r, 8, top, 11, top + 4);
      return r;
    };
    const frames = [mk(14), mk(13), mk(14)]; // bottoms at 18, 17, 18
    const layout = buildAtlas(alignGroup(frames));

    const bottoms = frames.map((_, i) => {
      const { x, y } = cellRect(layout, i);
      const content = trimBox(crop(layout.atlas, x, y, layout.cellW, layout.cellH))!;
      return content.y1;
    });
    expect(bottoms[0]).toBe(layout.cellH - 1); // contact frame sits ON the anchor row
    expect(bottoms[1]).toBe(layout.cellH - 2); // mid-bob frame is 1px up
    expect(bottoms[2]).toBe(layout.cellH - 1);
  });

  it('puts the anchor at bottom-centre of every cell', () => {
    const r = makeRaster(30, 30);
    rect(r, 4, 10, 25, 29); // wide, offset content
    const layout = buildAtlas(alignGroup([r]));
    // The default grid anchor is [w/2, h-1]. Content must reach the anchor
    // row exactly (no bottom padding) and be centred about w/2.
    const { x, y } = cellRect(layout, 0);
    const content = trimBox(crop(layout.atlas, x, y, layout.cellW, layout.cellH))!;
    expect(content.y1).toBe(layout.cellH - 1);
    const mid = (content.x0 + content.x1) / 2;
    expect(Math.abs(mid - layout.cellW / 2)).toBeLessThanOrEqual(1);
  });

  it('never clips content', () => {
    // An asymmetric character: 3px left of anchor, 14px right.
    const r = makeRaster(40, 40);
    rect(r, 10, 20, 27, 39);
    rect(r, 13, 36, 16, 39); // feet near the left edge of the body
    const src = trimBox(r)!;
    const srcCount = countAlpha(r, src.x0, src.y0, src.x1, src.y1);

    const layout = buildAtlas(alignGroup([r]));
    const { x, y } = cellRect(layout, 0);
    const cellCount = countAlpha(layout.atlas, x, y, x + layout.cellW - 1, y + layout.cellH - 1);
    expect(cellCount).toBe(srcCount);
  });

  it('unifies cell size across differently-sized groups in anchor space', () => {
    const small = makeRaster(10, 10);
    rect(small, 3, 4, 6, 9);
    const tall = makeRaster(12, 30);
    rect(tall, 4, 2, 8, 29);
    const layout = buildAtlas([...alignGroup([small]), ...alignGroup([tall])]);

    // Both must fit; the cell is sized by the tall one.
    for (const i of [0, 1]) {
      const { x, y } = cellRect(layout, i);
      const content = trimBox(crop(layout.atlas, x, y, layout.cellW, layout.cellH))!;
      expect(content.y1).toBe(layout.cellH - 1); // both stand on the anchor row
    }
    expect(layout.cellH).toBeGreaterThanOrEqual(28);
  });

  it('lays out a near-square grid', () => {
    const frames = Array.from({ length: 5 }, () => {
      const r = makeRaster(8, 8);
      rect(r, 2, 2, 5, 7);
      return r;
    });
    const layout = buildAtlas(alignGroup(frames));
    expect(layout.cols).toBe(3);
    expect(layout.count).toBe(5);
    expect(layout.atlas.w).toBe(layout.margin * 2 + 3 * layout.cellW + 2 * layout.spacing);
  });
});

function countAlpha(r: Raster, x0: number, y0: number, x1: number, y1: number): number {
  let n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (alphaAt(r, x, y) >= 8) n++;
  return n;
}
