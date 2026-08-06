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

/**
 * How fast the desktop is resampled while a window is being dragged or
 * resized, and how long that lasts after the movement stops.
 *
 * The pet rides a window by having its surface move under it, so it can only
 * follow as often as the world is sampled — at the resting 300ms that reads as
 * the pet teleporting after the window in three steps a second. Measured cost
 * of a scan on this machine: 0.16ms mean / 0.28ms p95, plus 0.02ms to broadcast
 * the result, so 60/s is ~1.1% of one core and only while something is actually
 * moving. That is cheap enough to be the default.
 *
 * SETTLE_MS matters more than it looks: a drag has pauses in it, and dropping
 * back to 300ms the instant the mouse stops means every pause costs a visible
 * lurch when it resumes.
 */
const MOVING_MS = 8;
const SETTLE_MS = 400;

/** Below this a position delta is DIP rounding, not a window moving. */
const MOVE_EPS = 0.5;

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
  /**
   * Resample the desktop at MOVING_MS while a window is moving, instead of
   * staying at the resting interval. Off means the pet catches up to a dragged
   * window a few times a second.
   */
  setSmoothTracking(on: boolean): void;
  /**
   * Pin the pet inside one window: that window gets side walls, closing it
   * into a box the pet cannot walk out of. null clears it.
   */
  setTerrarium(id: string | null): void;
  /** The pinned window, or null. The scanner owns this; it clears it when the window goes. */
  terrarium(): string | null;
  /** Topmost window whose box contains a point, or null. Global DIP. */
  windowAt(x: number, y: number): string | null;
}

interface WindowBox {
  id: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
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

/**
 * Did a window we already knew about change position or size?
 *
 * Deliberately ignores windows that have just appeared or vanished. Opening a
 * window is a one-off change the resting scan handles perfectly well; only a
 * drag or a resize produces the continuous motion the pet needs to follow.
 */
function windowMoving(before: readonly WindowBox[], now: readonly WindowBox[]): boolean {
  for (const b of now) {
    const was = before.find((o) => o.id === b.id);
    if (!was) continue;
    if (
      Math.abs(was.x0 - b.x0) > MOVE_EPS ||
      Math.abs(was.y0 - b.y0) > MOVE_EPS ||
      Math.abs(was.x1 - b.x1) > MOVE_EPS ||
      Math.abs(was.y1 - b.y1) > MOVE_EPS
    ) {
      return true;
    }
  }
  return false;
}

export function createScanner(events: ScannerEvents): Scanner {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let restMs = 300;
  let smooth = true;
  /** Timestamp of the last observed window movement; 0 = never. */
  let movedAt = 0;
  let rev = 0;
  let lastSig = '';
  let selfHwnds: readonly string[] = [];
  let terrariumId: string | null = null;
  let boxes: WindowBox[] = []; // z-order, topmost first

  function tick(): void {
    const seenBoxes: WindowBox[] = [];
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
      const above: WindowBox[] = [];

      /** The stretches of a horizontal edge at `y` that nothing above covers. */
      const visibleAt = (y: number, a: number, b: number) =>
        subtractSpans(
          { a, b },
          above
            .filter((o) => o.y0 <= y + TOUCH && o.y1 >= y - TOUCH)
            .map((o) => ({ a: o.x0, b: o.x1 })),
        );

      for (const w of win32.scanWindows()) {
        if (selfHwnds.includes(w.id)) continue; // our overlays are transparent

        const tl = screen.screenToDipPoint({ x: w.left, y: w.top });
        const br = screen.screenToDipPoint({ x: w.right, y: w.bottom });
        const wDip = br.x - tl.x;
        const hDip = br.y - tl.y;

        // Occlusion has to be evaluated against everything above BEFORE this
        // window is added to the list, and this window has to be added even if
        // it is then filtered out — a window too narrow to carry a pet still
        // covers what is behind it.
        const box: WindowBox = { id: w.id, x0: tl.x, x1: br.x, y0: tl.y, y1: br.y };
        const topSpans = visibleAt(tl.y, Math.max(tl.x, 0), br.x);
        const bottomSpans = visibleAt(br.y, tl.x, br.x);
        above.push(box);
        seenBoxes.push(box);

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

        const clip = (s: { a: number; b: number }) => ({
          a: Math.max(s.a, host.region.x),
          b: Math.min(s.b, host.region.x + host.region.w),
        });
        const visible = topSpans.map(clip).filter((s) => s.b - s.a > 4);

        // A ledge on top needs room ABOVE for the pet to be visible standing
        // there, which a maximized window simply does not have — its top edge
        // is the screen edge. That is why this test is stricter than the one
        // for the ceiling, not a duplicate of it.
        const roomAbove = tl.y > host.region.y + MIN_LEDGE_Y;
        const fillsScreen = wDip >= host.region.w * 0.96 && hDip >= host.region.h * 0.96;

        // The INSIDE of the window's bottom edge: this is what makes a window
        // somewhere the pet can be, rather than just an edge it perches on.
        // Drop it into a floating window and it settles here. Its ends hang
        // over open air, so the pet can still wander out — soft containment.
        // `terrarium` closes those ends off with walls.
        const insideRoom = hDip > MIN_LEDGE_Y && br.y < host.floorY - TOUCH;
        if (insideRoom) {
          for (const [i, span] of bottomSpans.map(clip).entries()) {
            if (span.b - span.a <= 4) continue;
            platforms.push({
              id: `wf${w.id}:${i}`,
              x0: span.a,
              x1: span.b,
              y: br.y,
              kind: 'ledge',
              passthrough: true,
              ownerX: tl.x,
            });
          }
        }

        if (terrariumId === w.id && insideRoom) {
          // Close the box. The sim needs no notion of "inside a window" — a
          // pet surrounded by walls, floor and ceiling simply cannot leave.
          walls.push(
            { id: `wt${w.id}:l`, x: tl.x, y0: tl.y, y1: br.y, side: 1 },
            { id: `wt${w.id}:r`, x: br.x, y0: tl.y, y1: br.y, side: -1 },
          );
        }

        for (const [i, span] of visible.entries()) {
          // A ceiling under EVERY window's top edge, maximized ones included.
          // This is the surface that works regardless of window size: there is
          // always room below an edge, never necessarily any above it.
          // Skipped only where it would sit on the screen's own roof.
          if (tl.y > host.region.y + TOUCH) {
            ceilings.push({ id: `wc${w.id}:${i}`, x0: span.a, x1: span.b, y: tl.y, ownerX: tl.x });
          }
          if (roomAbove && !fillsScreen) {
            platforms.push({
              id: `w${w.id}:${i}`,
              x0: span.a,
              x1: span.b,
              y: tl.y,
              kind: 'ledge',
              passthrough: true,
              ownerX: tl.x,
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

    if (windowMoving(boxes, seenBoxes)) movedAt = Date.now();
    boxes = seenBoxes;
    // The window the pet was pinned inside has gone. Let it out rather than
    // leaving invisible walls standing where a window used to be.
    if (terrariumId !== null && !boxes.some((b) => b.id === terrariumId)) terrariumId = null;

    platforms.sort((a, z) => a.y - z.y);
    events.onFullscreen(fullscreen);

    const sig = JSON.stringify([bounds, regions, platforms, walls, ceilings]);
    if (sig !== lastSig) {
      lastSig = sig;
      rev++;
      if (process.env.BLERB_DEBUG) {
        console.log(
          `[scan] rev=${rev} koffi=${win32.available} screens=${list.length} ` +
            `terrarium=${terrariumId ?? '-'} platforms=${platforms.length} walls=${walls.length} ceilings=${ceilings.length}`,
        );
        for (const p of platforms) console.log(`   floor ${p.id} y=${Math.round(p.y)} x=${Math.round(p.x0)}..${Math.round(p.x1)}`);
        for (const c of ceilings) console.log(`   roof  ${c.id} y=${Math.round(c.y)} x=${Math.round(c.x0)}..${Math.round(c.x1)}`);
        for (const w of walls) console.log(`   wall  ${w.id} x=${Math.round(w.x)} y=${Math.round(w.y0)}..${Math.round(w.y1)} side=${w.side}`);
      }
      events.onWorld({ rev, bounds, regions, platforms, walls, ceilings, gravity: 900, reducedMotion: false });
    }
  }

  /**
   * Self-scheduling rather than setInterval, because the interval is not
   * constant — it collapses to MOVING_MS while a window is in motion.
   */
  function loop(): void {
    tick();
    if (!running) return;
    const fast = smooth && Date.now() - movedAt < SETTLE_MS;
    timer = setTimeout(loop, fast ? MOVING_MS : restMs);
  }

  return {
    start(intervalMs = 300) {
      restMs = intervalMs;
      running = true;
      loop();
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    force() {
      lastSig = '';
      tick();
    },
    setSelfHwnds(ids) {
      selfHwnds = ids;
    },
    setSmoothTracking(on) {
      smooth = on;
    },
    setTerrarium(id) {
      terrariumId = id;
    },
    terrarium() {
      return terrariumId;
    },
    windowAt(x, y) {
      // boxes is z-order, topmost first, so the first hit is the visible one.
      const hit = boxes.find((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
      return hit?.id ?? null;
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
