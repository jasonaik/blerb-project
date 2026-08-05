import { screen } from 'electron';
import { subtractSpans, unionRect, type Platform, type Rect, type Span, type Wall, type World } from '@blerb/core';
import * as win32 from './win32';

/**
 * Samples the real desktop into a `World`, in GLOBAL DIP coordinates spanning
 * every monitor. The sim works in this one space; each overlay window
 * subtracts its own display origin when drawing.
 *
 * The interesting part is deciding where the desktop *ends*:
 *
 *   - Every screen's bottom edge is ground. Where another screen lies directly
 *     below, that stretch is a `seam` — still solid, but the way down to the
 *     screen beneath, reachable by walking off either end of it.
 *   - A wall exists along a screen's left/right edge only where no other
 *     screen sits alongside at that height. Where one does, the pet walks
 *     across the seam.
 *
 * That gives all the multi-monitor behaviour: climb the outer edge of the
 * desktop, walk between adjacent screens, descend from an upper screen to a
 * lower one — and never step into the dead space that an L-shaped two-monitor
 * layout leaves inside the bounding box.
 *
 * The seam used to be a *hole* — no platform at all, so the pet fell straight
 * through the upper screen. That reads as broken: put the pet on your big
 * monitor and it vanishes to the bottom of the laptop. A screen's bottom edge
 * is somewhere the pet should be able to stand.
 *
 * Coordinate discipline (CLAUDE.md §2): win32.ts hands us PHYSICAL px,
 * Electron displays speak DIP. Convert exactly once, here.
 */

/** How close two edges must be (DIP) to count as touching. */
const TOUCH = 2;

export interface Scanner {
  start(intervalMs?: number): void;
  stop(): void;
  force(): void;
  setSelfHwnds(ids: readonly string[]): void;
}

export interface ScannerEvents {
  onWorld(world: World): void;
  onFullscreen(fullscreen: boolean): void;
}

interface ScreenInfo {
  id: number;
  /** Full display bounds — the pet may walk over the taskbar's screen area. */
  region: Rect;
  /** Where the ground is: the taskbar's top edge, or the screen bottom. */
  floorY: number;
}

function screens(): ScreenInfo[] {
  return screen.getAllDisplays().map((d) => ({
    id: d.id,
    region: { x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height },
    // Standing ON the taskbar is the charm, so the floor is its top edge.
    floorY: Math.min(d.bounds.y + d.bounds.height, d.workArea.y + d.workArea.height),
  }));
}

function buildGeometry(list: ScreenInfo[]): { platforms: Platform[]; walls: Wall[] } {
  const platforms: Platform[] = [];
  const walls: Wall[] = [];

  for (const s of list) {
    const r = s.region;
    const right = r.x + r.w;
    const bottom = r.y + r.h;

    // ---- ground: the whole bottom edge, split at any screen below ---------
    // Both halves are solid and at the same y, so they read as one continuous
    // line the pet walks along. The split exists only to mark which stretch
    // has somewhere to go underneath it.
    const edge: Span = { a: r.x, b: right };
    const below: Span[] = list
      .filter((o) => o.id !== s.id && Math.abs(o.region.y - bottom) <= TOUCH)
      .map((o) => ({ a: o.region.x, b: o.region.x + o.region.w }));

    const outer = subtractSpans(edge, below);
    // Whatever the outer spans left behind is exactly the covered stretch.
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
        // There is a screen under this one. Stepping off either end drops the
        // pet onto it, which is how it gets downstairs.
        passthrough: true,
      });
    }

    // ---- walls: side edges, minus any screen alongside --------------------
    for (const edge of [
      { x: r.x, side: 1 as const, key: 'l', neighbourEdge: (o: Rect) => o.x + o.w },
      { x: right, side: -1 as const, key: 'r', neighbourEdge: (o: Rect) => o.x },
    ]) {
      const covered: Span[] = list
        .filter((o) => o.id !== s.id && Math.abs(edge.neighbourEdge(o.region) - edge.x) <= TOUCH)
        .map((o) => ({ a: o.region.y, b: o.region.y + o.region.h }));

      for (const [i, span] of subtractSpans({ a: r.y, b: bottom }, covered).entries()) {
        walls.push({ id: `wall:${s.id}:${edge.key}:${i}`, x: edge.x, y0: span.a, y1: span.b, side: edge.side });
      }
    }
  }

  return { platforms, walls };
}

export function createScanner(events: ScannerEvents): Scanner {
  let timer: ReturnType<typeof setInterval> | null = null;
  let rev = 0;
  let lastSig = '';
  let selfHwnds: readonly string[] = [];

  function tick(): void {
    const list = screens();
    const regions = list.map((s) => s.region);
    const bounds = unionRect(regions);
    const { platforms, walls } = buildGeometry(list);

    let fullscreen = false;

    if (win32.available) {
      for (const w of win32.scanWindows()) {
        if (selfHwnds.includes(w.id)) continue; // don't stand on our own overlays

        const tl = screen.screenToDipPoint({ x: w.left, y: w.top });
        const br = screen.screenToDipPoint({ x: w.right, y: w.bottom });
        const wDip = br.x - tl.x;
        const hDip = br.y - tl.y;
        if (wDip < 140) continue;

        // The ledge must sit on a screen, with room above for the pet to be
        // visible standing on it and clear of the ground it already has.
        const host = list.find(
          (s) =>
            tl.y > s.region.y + 72 &&
            tl.y < s.floorY - 24 &&
            br.x > s.region.x &&
            tl.x < s.region.x + s.region.w,
        );
        if (!host) continue;
        if (wDip >= host.region.w * 0.96 && hDip >= host.region.h * 0.96) continue;

        platforms.push({
          id: `w${w.id}`,
          x0: Math.max(tl.x, host.region.x),
          x1: Math.min(br.x, host.region.x + host.region.w),
          y: tl.y,
          kind: 'ledge',
          passthrough: true,
        });
      }

      // Exclusive/borderless fullscreen: the foreground window covers a whole
      // display's *bounds* (a maximized window only covers workArea). Nothing
      // can draw over exclusive fullscreen, so hiding is honest.
      const fg = win32.foregroundRect();
      if (fg) {
        const tl = screen.screenToDipPoint({ x: fg.left, y: fg.top });
        const br = screen.screenToDipPoint({ x: fg.right, y: fg.bottom });
        fullscreen = list.some(
          (s) =>
            tl.x <= s.region.x + 2 &&
            tl.y <= s.region.y + 2 &&
            br.x >= s.region.x + s.region.w - 2 &&
            br.y >= s.region.y + s.region.h - 2,
        );
      }
    }

    platforms.sort((a, z) => a.y - z.y);
    events.onFullscreen(fullscreen);

    const sig = JSON.stringify([bounds, regions, platforms, walls]);
    if (sig !== lastSig) {
      lastSig = sig;
      rev++;
      if (process.env.BLERB_DEBUG) {
        console.log(
          `[scan] rev=${rev} koffi=${win32.available} screens=${list.length} ` +
            `fullscreen=${fullscreen} platforms=${platforms.length} walls=${walls.length}`,
        );
        for (const p of platforms) console.log(`   floor ${p.id} y=${Math.round(p.y)} x=${Math.round(p.x0)}..${Math.round(p.x1)}`);
        for (const w of walls) console.log(`   wall  ${w.id} x=${Math.round(w.x)} y=${Math.round(w.y0)}..${Math.round(w.y1)} side=${w.side}`);
      }
      events.onWorld({ rev, bounds, regions, platforms, walls, gravity: 900, reducedMotion: false });
    }
  }

  return {
    start(intervalMs = 300) {
      tick();
      timer = setInterval(tick, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    force() {
      lastSig = '';
      tick();
    },
    setSelfHwnds(ids) {
      selfHwnds = ids;
    },
  };
}

/** Floor-only fallback for overlay:init before the first scan lands. */
export function fallbackWorld(): World {
  const list = screens();
  const regions = list.map((s) => s.region);
  const { platforms, walls } = buildGeometry(list);
  return { rev: 0, bounds: unionRect(regions), regions, platforms, walls, gravity: 900, reducedMotion: false };
}
