import { screen } from 'electron';
import { buildDesktopGeometry, unionRect, type ScreenInfo, type World } from '@blerb/core';
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
    const { platforms, walls } = buildDesktopGeometry(list);

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
  const { platforms, walls } = buildDesktopGeometry(list);
  return { rev: 0, bounds: unionRect(regions), regions, platforms, walls, gravity: 900, reducedMotion: false };
}
