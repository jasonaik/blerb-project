import { subtractSpans, type Span } from './geom.js';
import type { Ceiling, Platform, Rect, Wall } from './types.js';

/**
 * Turns a list of screens into the surfaces the pet can use.
 *
 * This lives in `@blerb/core` rather than in the Electron app for one reason:
 * it is the hardest-to-get-right part of the multi-monitor behaviour, and it
 * needs to be testable against real layouts without an `electron` import. It
 * used to live in apps/desktop/src/main/scanner.ts, where the tests could not
 * reach it — so the sim tests hand-wrote Worlds instead, and quietly omitted
 * the walls the real scanner emits. Two of them certified a descent route that
 * does not exist on actual hardware. Derive the geometry here; let the host do
 * nothing but sample the OS and convert coordinates.
 *
 * The rules:
 *
 *   - A screen's WHOLE bottom edge is ground, at `floorY` (the taskbar's top
 *     edge, so the pet stands on the taskbar). It is split where another screen
 *     lies directly below: that stretch is `passthrough`, meaning there is
 *     somewhere to go if the pet drops through it.
 *   - A wall exists along a screen's left/right edge only where no other screen
 *     sits alongside at that height. Where one does, the pet walks the seam.
 *   - A wall stops at `floorY`, not at the screen's bottom. Below the taskbar's
 *     top edge there is nothing to cling to, and a wall that ran past the floor
 *     let a descending pet slide behind the taskbar.
 */

/** How close two edges must be (world px) to count as touching. */
const TOUCH = 2;

export interface ScreenInfo {
  /** Stable per display. Never an array index — display order is not stable. */
  id: number | string;
  /** Full display bounds. The pet is allowed over the taskbar's area. */
  region: Rect;
  /** Where the ground is: the taskbar's top edge, or the screen bottom. */
  floorY: number;
}

export function buildDesktopGeometry(list: readonly ScreenInfo[]): {
  platforms: Platform[];
  walls: Wall[];
  ceilings: Ceiling[];
} {
  const platforms: Platform[] = [];
  const walls: Wall[] = [];
  const ceilings: Ceiling[] = [];

  for (const s of list) {
    const r = s.region;
    const right = r.x + r.w;
    const bottom = r.y + r.h;
    const edge: Span = { a: r.x, b: right };

    // ---- ground: the whole bottom edge, split at any screen below ----------
    const below: Span[] = list
      .filter((o) => o.id !== s.id && Math.abs(o.region.y - bottom) <= TOUCH)
      .map((o) => ({ a: o.region.x, b: o.region.x + o.region.w }));

    const outer = subtractSpans(edge, below);
    // Whatever `outer` left behind is exactly the covered stretch. Note this is
    // not a strict complement: subtractSpans drops slivers, so a <=4px gap
    // between monitors ends up inside the seam rather than becoming its own
    // 4px platform. Solid is the safe way to round.
    const seam = subtractSpans(edge, outer);

    for (const [i, span] of outer.entries()) {
      platforms.push({
        id: `floor:${s.id}:${i}`,
        x0: span.a,
        x1: span.b,
        y: s.floorY,
        kind: 'floor',
        passthrough: false,
      });
    }
    for (const [i, span] of seam.entries()) {
      platforms.push({
        id: `seam:${s.id}:${i}`,
        x0: span.a,
        x1: span.b,
        y: s.floorY,
        kind: 'floor',
        // There is a screen under this stretch, so dropping through it lands
        // the pet somewhere real. This is the route downstairs.
        passthrough: true,
      });
    }

    // ---- ceiling: the top edge, minus any screen directly above ------------
    // The mirror of the ground rule. Where a screen sits above, that stretch
    // is its floor's underside and belongs to it, not here.
    const above: Span[] = list
      .filter((o) => o.id !== s.id && Math.abs(o.region.y + o.region.h - r.y) <= TOUCH)
      .map((o) => ({ a: o.region.x, b: o.region.x + o.region.w }));

    for (const [i, span] of subtractSpans(edge, above).entries()) {
      ceilings.push({ id: `roof:${s.id}:${i}`, x0: span.a, x1: span.b, y: r.y });
    }

    // ---- walls: side edges, minus any screen alongside ---------------------
    for (const side of [
      { x: r.x, dir: 1 as const, key: 'l', neighbourEdge: (o: Rect) => o.x + o.w },
      { x: right, dir: -1 as const, key: 'r', neighbourEdge: (o: Rect) => o.x },
    ]) {
      const covered: Span[] = list
        .filter((o) => o.id !== s.id && Math.abs(side.neighbourEdge(o.region) - side.x) <= TOUCH)
        .map((o) => ({ a: o.region.y, b: o.region.y + o.region.h }));

      for (const [i, span] of subtractSpans({ a: r.y, b: s.floorY }, covered).entries()) {
        walls.push({
          id: `wall:${s.id}:${side.key}:${i}`,
          x: side.x,
          y0: span.a,
          y1: span.b,
          side: side.dir,
        });
      }
    }
  }

  return { platforms, walls, ceilings };
}
