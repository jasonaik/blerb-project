import { screen } from 'electron';
import type { Platform, World } from '@blerb/core';
import * as win32 from './win32';

/**
 * Samples the real desktop into a `World` for the sim: window top edges become
 * ledges, the taskbar's top edge becomes the floor. Runs at 300ms — cheap
 * syscalls, and the sim rides platform moves by id so this rate is plenty.
 *
 * Coordinate discipline (CLAUDE.md §2): win32.ts hands us PHYSICAL px,
 * Electron displays speak DIP. Convert exactly once, here, with
 * screen.screenToDipPoint. The sim then lives in overlay-local CSS px.
 */

export interface Scanner {
  start(intervalMs?: number): void;
  stop(): void;
  /** Drop the memoized signature so the next tick re-emits unconditionally. */
  force(): void;
  /** Our own overlay's HWND, so the pet doesn't stand on itself. */
  setSelfHwnd(id: string): void;
}

export interface ScannerEvents {
  onWorld(world: World): void;
  onFullscreen(fullscreen: boolean): void;
}

/**
 * Minimum DIP height above a ledge for the pet to be visible standing on it.
 * A window whose title bar sits at y=0 is a real edge, but a pet standing
 * there renders entirely off the top of the screen — so it's not a *useful*
 * ledge. Sized for a 32px sprite at scale 2, with headroom.
 */
const MIN_LEDGE_Y = 72;

export function createScanner(events: ScannerEvents): Scanner {
  let timer: ReturnType<typeof setInterval> | null = null;
  let rev = 0;
  let lastSig = '';
  let selfHwnd = '';

  function tick(): void {
    const display = screen.getPrimaryDisplay();
    const b = display.bounds; // DIP

    const platforms: Platform[] = [];

    // Floor = taskbar top edge (workArea bottom), so the pet walks ON the
    // taskbar. The window itself spans display.bounds — deliberately not
    // workArea — which is what lets the sprite overlay the taskbar at all.
    const floorY = Math.min(b.height, display.workArea.y + display.workArea.height - b.y);
    platforms.push({ id: 'taskbar', x0: 0, x1: b.width, y: floorY, kind: 'floor', passthrough: false });

    let fullscreen = false;

    if (win32.available) {
      for (const w of win32.scanWindows()) {
        if (w.id === selfHwnd) continue; // don't let the pet stand on its own overlay

        const tl = screen.screenToDipPoint({ x: w.left, y: w.top });
        const br = screen.screenToDipPoint({ x: w.right, y: w.bottom });

        const x0 = Math.max(0, tl.x - b.x);
        const x1 = Math.min(b.width, br.x - b.x);
        const y = tl.y - b.y;
        const wDip = x1 - x0;
        const hDip = br.y - tl.y;

        if (wDip < 140) continue; // off-display or too narrow to stand on
        // Below MIN_LEDGE_Y the pet would render off the top of the screen;
        // near the floor it would overlap the taskbar ledge it already has.
        if (y < MIN_LEDGE_Y || y > floorY - 24) continue;
        if (wDip >= b.width * 0.96 && hDip >= b.height * 0.96) continue; // desktop-sized surfaces

        platforms.push({ id: `w${w.id}`, x0, x1, y, kind: 'ledge', passthrough: true });
      }

      // Exclusive/borderless fullscreen: the foreground window covers the whole
      // display *bounds* (a maximized window only covers workArea, so it does
      // not trip this). Nothing can draw over exclusive fullscreen anyway —
      // hiding is honest rather than pretending.
      const fg = win32.foregroundRect();
      if (fg) {
        const tl = screen.screenToDipPoint({ x: fg.left, y: fg.top });
        const br = screen.screenToDipPoint({ x: fg.right, y: fg.bottom });
        fullscreen =
          tl.x <= b.x + 2 &&
          tl.y <= b.y + 2 &&
          br.x >= b.x + b.width - 2 &&
          br.y >= b.y + b.height - 2;
      }
    }

    platforms.sort((a, z) => a.y - z.y);
    events.onFullscreen(fullscreen);

    const sig = JSON.stringify([b, platforms]);
    if (sig !== lastSig) {
      lastSig = sig;
      rev++;
      if (process.env.BLERB_DEBUG) {
        console.log(
          `[scan] rev=${rev} koffi=${win32.available} fullscreen=${fullscreen} ` +
            `floor=${floorY} platforms=${platforms.length}`,
          platforms.map((p) => `${p.id}@y${Math.round(p.y)}[${Math.round(p.x0)}..${Math.round(p.x1)}]`),
        );
      }
      events.onWorld({
        rev,
        bounds: { x: 0, y: 0, w: b.width, h: b.height },
        platforms,
        gravity: 900,
        reducedMotion: false,
      });
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
    setSelfHwnd(id: string) {
      selfHwnd = id;
    },
  };
}

/** Floor-only fallback for overlay:init before the first scan lands. */
export function fallbackWorld(): World {
  const b = screen.getPrimaryDisplay().bounds;
  return {
    rev: 0,
    bounds: { x: 0, y: 0, w: b.width, h: b.height },
    platforms: [{ id: 'taskbar', x0: 0, x1: b.width, y: b.height, kind: 'floor', passthrough: false }],
    gravity: 900,
    reducedMotion: false,
  };
}
