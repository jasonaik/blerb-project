import { screen } from 'electron';
import { buildDesktopGeometry, subtractSpans, unionRect, type ScreenInfo, type World } from '@blerb/core';
import * as win32 from './win32';

/**
 * Samples the real desktop into a `World`, in GLOBAL DIP coordinates spanning
 * every monitor. The sim works in this one space; each overlay window
 * subtracts its own display origin when drawing.
 *
 * The geometry rules — which edges are ground, which are climbable — live in
 * `buildDesktopGeometry` in @blerb/core, so they can be tested against real
 * monitor layouts without an electron import. This file only samples the OS
 * and converts coordinates.
 *
 * Coordinate discipline (CLAUDE.md §2): win32.ts hands us PHYSICAL px,
 * Electron displays speak DIP. Convert exactly once, here.
 */

/** Two edges within this many DIP count as touching. */
const TOUCH = 2;

/** Narrower than this and a window is a tooltip or a sliver, not furniture. */
const MIN_WINDOW_W = 140;

/** A window must extend this far below its top edge to be worth hanging under. */
const MIN_HANG_ROOM = 40;

/**
 * Clearance above a window's top edge before the pet can STAND on it. Roughly
 * the sprite's height at 2x, so a pet on the ledge is fully visible rather
 * than sliced off by the top of the screen.
 */
const MIN_LEDGE_Y = 72;

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

function screens(): ScreenInfo[] {
  return screen.getAllDisplays().map((d) => ({
    id: d.id,
    region: { x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height },
    // Standing ON the taskbar is the charm, so the floor is its top edge.
    floorY: Math.min(d.bounds.y + d.bounds.height, d.workArea.y + d.workArea.height),
  }));
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
    const { platforms, walls, ceilings } = buildDesktopGeometry(list);

    let fullscreen = false;

    if (win32.available) {
      // Windows arrive topmost-first, so everything already seen is ABOVE the
      // current one and hides the part of it they overlap. Without this the
      // pet stands on, and hangs from, the edges of windows buried behind
      // whatever you are actually looking at — a line that isn't on screen.
      const above: { x0: number; x1: number; y0: number; y1: number }[] = [];

      for (const w of win32.scanWindows()) {
        if (selfHwnds.includes(w.id)) continue; // our overlays are transparent

        const tl = screen.screenToDipPoint({ x: w.left, y: w.top });
        const br = screen.screenToDipPoint({ x: w.right, y: w.bottom });
        const wDip = br.x - tl.x;
        const hDip = br.y - tl.y;

        // Record it as an occluder before any of the "is it useful" filters —
        // a window too narrow to carry a pet still covers what is behind it.
        const occluders = above.slice();
        above.push({ x0: tl.x, x1: br.x, y0: tl.y, y1: br.y });

        if (wDip < MIN_WINDOW_W) continue;

        // The window's top edge has to be on a screen, above that screen's
        // ground, with enough window below the edge to hang under.
        const host = list.find(
          (s) =>
            tl.y >= s.region.y - TOUCH &&
            tl.y < s.floorY - MIN_HANG_ROOM &&
            br.y > tl.y + MIN_HANG_ROOM &&
            br.x > s.region.x &&
            tl.x < s.region.x + s.region.w,
        );
        if (!host) continue;

        // Only the stretches of this window's top edge that something above
        // isn't covering. A window whose title bar is entirely hidden offers
        // nothing at all, which is the point.
        const hidden = occluders
          .filter((o) => o.y0 <= tl.y + TOUCH && o.y1 >= tl.y - TOUCH)
          .map((o) => ({ a: o.x0, b: o.x1 }));
        const visible = subtractSpans(
          {
            a: Math.max(tl.x, host.region.x),
            b: Math.min(br.x, host.region.x + host.region.w),
          },
          hidden,
        );

        // A ledge on top needs room ABOVE for the pet to be visible standing
        // there, which a maximized window simply does not have — its top edge
        // is the screen edge. That is why this test is stricter than the one
        // for the ceiling, not a duplicate of it.
        const roomAbove = tl.y > host.region.y + MIN_LEDGE_Y;
        const fillsScreen = wDip >= host.region.w * 0.96 && hDip >= host.region.h * 0.96;

        for (const [i, span] of visible.entries()) {
          // A ceiling under EVERY window's top edge, maximized ones included.
          // This is the surface that works regardless of window size: there is
          // always room below an edge, never necessarily any above it.
          // Skipped only where it would sit on the screen's own roof.
          if (tl.y > host.region.y + TOUCH) {
            ceilings.push({ id: `wc${w.id}:${i}`, x0: span.a, x1: span.b, y: tl.y });
          }
          if (roomAbove && !fillsScreen) {
            platforms.push({
              id: `w${w.id}:${i}`,
              x0: span.a,
              x1: span.b,
              y: tl.y,
              kind: 'ledge',
              passthrough: true,
            });
          }
        }
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

    const sig = JSON.stringify([bounds, regions, platforms, walls, ceilings]);
    if (sig !== lastSig) {
      lastSig = sig;
      rev++;
      if (process.env.BLERB_DEBUG) {
        console.log(
          `[scan] rev=${rev} koffi=${win32.available} screens=${list.length} ` +
            `fullscreen=${fullscreen} platforms=${platforms.length} walls=${walls.length} ceilings=${ceilings.length}`,
        );
        for (const p of platforms) console.log(`   floor ${p.id} y=${Math.round(p.y)} x=${Math.round(p.x0)}..${Math.round(p.x1)}`);
        for (const c of ceilings) console.log(`   roof  ${c.id} y=${Math.round(c.y)} x=${Math.round(c.x0)}..${Math.round(c.x1)}`);
        for (const w of walls) console.log(`   wall  ${w.id} x=${Math.round(w.x)} y=${Math.round(w.y0)}..${Math.round(w.y1)} side=${w.side}`);
      }
      events.onWorld({ rev, bounds, regions, platforms, walls, ceilings, gravity: 900, reducedMotion: false });
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
  const { platforms, walls, ceilings } = buildDesktopGeometry(list);
  return { rev: 0, bounds: unionRect(regions), regions, platforms, walls, ceilings, gravity: 900, reducedMotion: false };
}
