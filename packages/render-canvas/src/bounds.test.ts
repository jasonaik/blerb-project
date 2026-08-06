import { describe, expect, it } from 'vitest';
import { frameBounds } from './CanvasRenderer.js';
import type { RenderFrame } from '@blerb/core';

/**
 * These exist because the click-through hit test in the Electron app used to
 * derive the pet's box straight from the cell, as though the sprite were
 * always upright. It is rotated a quarter turn on a wall and a half turn under
 * a ceiling, so the box sat a whole sprite away from where the pet was drawn —
 * and a hanging pet was nearly impossible to pick up.
 */

/** 32x32, anchor at bottom-centre, like every pack the project ships. */
const cell = { id: 'c', x: 0, y: 0, w: 32, h: 32, anchor: [16, 31] as const };

const frame = (over: Partial<RenderFrame> = {}): RenderFrame => ({
  t: 0,
  cellId: 'c',
  x: 100,
  y: 200,
  facing: 1,
  scale: 1,
  opacity: 1,
  rotation: 0,
  squash: { sx: 1, sy: 1 },
  effects: [],
  ...over,
});

const round = (r: { x: number; y: number; w: number; h: number }) => ({
  x: Math.round(r.x),
  y: Math.round(r.y),
  w: Math.round(r.w),
  h: Math.round(r.h),
});

describe('frameBounds', () => {
  it('puts an upright sprite above its anchor', () => {
    // Feet at y=200, so the body occupies the 31px above it.
    expect(round(frameBounds(cell, frame()))).toEqual({ x: 84, y: 169, w: 32, h: 32 });
  });

  it('puts a hanging sprite BELOW its anchor', () => {
    // Half turn: the pet's feet are on the ceiling and it dangles underneath.
    const b = round(frameBounds(cell, frame({ rotation: Math.PI, facing: -1 })));
    expect(b).toEqual({ x: 84, y: 199, w: 32, h: 32 });
    expect(b.y).toBeGreaterThanOrEqual(200 - 2); // below the anchor, not above
  });

  it('puts a climbing sprite beside its anchor', () => {
    // Right-hand wall: rotate -90deg, so the body extends to the LEFT.
    const b = round(frameBounds(cell, frame({ rotation: -Math.PI / 2 })));
    expect(b).toEqual({ x: 69, y: 184, w: 32, h: 32 });
    expect(b.x + b.w).toBeLessThanOrEqual(100 + 2); // left of the wall it clings to
  });

  it('scales about the anchor', () => {
    const b = frameBounds(cell, frame({ scale: 2 }));
    expect(round(b)).toEqual({ x: 68, y: 138, w: 64, h: 64 });
  });

  it('is unchanged by the mirror, which only flips within the box', () => {
    const a = round(frameBounds(cell, frame({ facing: 1 })));
    const b = round(frameBounds(cell, frame({ facing: -1 })));
    // anchor x is 16 of 32 — dead centre, so mirroring is symmetric here.
    expect(b).toEqual(a);
  });

  it('always contains the anchor itself', () => {
    for (const rotation of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      for (const facing of [1, -1] as const) {
        const b = frameBounds(cell, frame({ rotation, facing }));
        expect(b.x).toBeLessThanOrEqual(100 + 1e-9);
        expect(b.x + b.w).toBeGreaterThanOrEqual(100 - 1e-9);
        expect(b.y).toBeLessThanOrEqual(200 + 1e-9);
        expect(b.y + b.h).toBeGreaterThanOrEqual(200 - 1e-9);
      }
    }
  });
});
