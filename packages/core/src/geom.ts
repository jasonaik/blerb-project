import type { Rect } from './types.js';

/**
 * Small geometry helpers shared by the sim and by hosts building a World.
 *
 * The multi-monitor case is the reason these exist: a two-screen desktop's
 * bounding box contains dead space that is not screen, so "inside bounds" and
 * "somewhere the user can see" are different questions.
 */

/** Tolerance for a pet standing exactly on a boundary. */
export const EPS = 1.5;

export function rectContains(r: Rect, x: number, y: number, eps = EPS): boolean {
  return x >= r.x - eps && x <= r.x + r.w + eps && y >= r.y - eps && y <= r.y + r.h + eps;
}

/**
 * The region containing (x, y), or undefined if that point is off-desktop.
 *
 * `eps` defaults to the standing tolerance. Pass 0 when the answer decides
 * where the pet *falls*: with slop, a pet a fraction past a screen's edge
 * still matches the screen it just left, and gets planted on that screen's
 * floor in mid-air above the one below.
 */
export function regionAt(
  regions: readonly Rect[],
  x: number,
  y: number,
  eps = EPS,
): Rect | undefined {
  for (const r of regions) if (rectContains(r, x, y, eps)) return r;
  return undefined;
}

export function unionRect(rects: readonly Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export interface Span {
  a: number;
  b: number;
}

/**
 * `base` minus every span in `cuts`. Used to answer "along this screen edge,
 * which parts have no neighbouring screen?" — those parts get a wall or a
 * floor, and the rest stays open so the pet can cross.
 */
export function subtractSpans(base: Span, cuts: readonly Span[]): Span[] {
  let out: Span[] = [base];
  for (const cut of cuts) {
    const next: Span[] = [];
    for (const s of out) {
      if (cut.b <= s.a || cut.a >= s.b) {
        next.push(s);
        continue;
      }
      if (cut.a > s.a) next.push({ a: s.a, b: cut.a });
      if (cut.b < s.b) next.push({ a: cut.b, b: s.b });
    }
    out = next;
  }
  // Drop slivers — a 2px gap between monitors is a rounding artifact, not a
  // place the pet should try to squeeze through or cling to.
  return out.filter((s) => s.b - s.a > 4);
}
