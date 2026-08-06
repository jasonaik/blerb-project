import { loadPack, type Fetcher, type ResolvedPack } from '@blerb/pack';
import { deriveFrame, type PetState, type RenderFrame, type World } from '@blerb/core';
import { CanvasRenderer, frameBounds, type Ctx2D } from '@blerb/render-canvas';

/**
 * One overlay window's view of the pet.
 *
 * The sim lives in main and broadcasts `PetState` in GLOBAL desktop
 * coordinates; this page derives its own `RenderFrame` and subtracts its
 * display origin to draw. Two consequences worth knowing:
 *
 *   - a pet straddling two monitors is drawn by both windows, each clipping
 *     it naturally at the screen edge, so it crosses seamlessly
 *   - there is no render loop. Frames arrive when something changes, so an
 *     idle pet costs this process nothing at all.
 */

const canvas = document.getElementById('stage') as HTMLCanvasElement;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Padding for rotation overshoot — the sprite rotates 90° when climbing. */
const PAD = 24;

async function main(): Promise<void> {
  let init = await window.blerb.init();
  let origin = init.origin;

  const fetcher: Fetcher = async (url) => {
    try {
      const bytes = await window.blerb.read(url);
      return { ok: true, status: 200, text: async () => new TextDecoder().decode(bytes) };
    } catch {
      return { ok: false, status: 404, text: async () => '' };
    }
  };

  const pack: ResolvedPack = await loadPack(fetcher, `${init.packDir}/pet.json`);
  const atlasBytes = await window.blerb.read(pack.atlasUrl);
  const atlas = await createImageBitmap(new Blob([atlasBytes as BlobPart]));

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  const renderer = new CanvasRenderer({ ctx: ctx as unknown as Ctx2D, pack, atlas, dpr: devicePixelRatio || 1 });

  let world: World = init.world;
  let debug = init.settings.debugOverlay;
  let petScale = init.settings.petScale;
  let state: PetState | null = init.state;
  let prevRect: Rect | null = null;

  function resize(): void {
    const dpr = devicePixelRatio || 1;
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    canvas.style.width = `${innerWidth}px`;
    canvas.style.height = `${innerHeight}px`;
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderer.setDpr(dpr);
    prevRect = null;
    paint();
  }
  resize();
  addEventListener('resize', resize);
  new ResizeObserver(resize).observe(document.documentElement);

  /** Global desktop coords → this window's local CSS px. */
  function toLocal(f: RenderFrame): RenderFrame {
    return { ...f, x: f.x - origin.x, y: f.y - origin.y, scale: f.scale * petScale };
  }

  function spriteRect(f: RenderFrame): Rect | null {
    const cell = pack.cells.get(f.cellId);
    if (!cell) return null;
    // Exact footprint through the same transform the renderer uses, plus a
    // pixel or two for the pixel-art snap.
    const b = frameBounds(cell, f, pack.atlasScale);
    return { x: b.x - PAD, y: b.y - PAD, w: b.w + PAD * 2, h: b.h + PAD * 2 };
  }

  function union(a: Rect, b: Rect): Rect {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
  }

  function paint(): void {
    if (!state) return;
    const f = toLocal(deriveFrame(pack, state));
    const rect = spriteRect(f);

    if (debug) {
      renderer.clear(innerWidth, innerHeight);
      renderer.draw(f);
      renderer.drawDebug(localWorld(), f);
    } else {
      const u = prevRect && rect ? union(prevRect, rect) : (rect ?? prevRect);
      if (u) ctx!.clearRect(u.x, u.y, u.w, u.h);
      renderer.draw(f);
    }
    prevRect = rect;
  }

  /** Debug lines are drawn in window-local space too. */
  function localWorld(): World {
    return {
      ...world,
      platforms: world.platforms.map((p) => ({ ...p, x0: p.x0 - origin.x, x1: p.x1 - origin.x, y: p.y - origin.y })),
      walls: world.walls.map((w) => ({ ...w, x: w.x - origin.x, y0: w.y0 - origin.y, y1: w.y1 - origin.y })),
    };
  }

  window.blerb.onInit((next) => {
    // Sent when displays are rearranged: this window may now be a different
    // monitor, so its origin changes.
    init = next;
    origin = next.origin;
    world = next.world;
    prevRect = null;
    renderer.clear(innerWidth, innerHeight);
    paint();
  });
  window.blerb.onPetState((s) => {
    state = s;
    paint();
  });
  window.blerb.onWorld((w) => {
    world = w;
    if (debug) paint();
  });
  window.blerb.onVisibility(() => {
    renderer.clear(innerWidth, innerHeight);
    prevRect = null;
  });
  window.blerb.onSettings((s) => {
    debug = s.debugOverlay;
    petScale = s.petScale;
    prevRect = null;
    renderer.clear(innerWidth, innerHeight);
    paint();
  });

  // ---- pick up & drop -----------------------------------------------------
  // Main only routes mouse events here while the cursor is over the pet, so a
  // pointerdown is by construction a grab. Coordinates go back out as GLOBAL
  // so the pet can be carried from one monitor to another.
  let dragging = false;
  const place = (e: PointerEvent) =>
    window.blerb.place({ x: e.clientX + origin.x, y: e.clientY + origin.y });

  addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    window.blerb.drag(true);
    place(e);
  });
  addEventListener('pointermove', (e) => {
    if (dragging) place(e);
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    window.blerb.drag(false);
  };
  addEventListener('pointerup', endDrag);
  addEventListener('pointercancel', endDrag);
  addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.blerb.menu();
  });

  paint();
  console.log(`[blerb] view up at origin ${origin.x},${origin.y}`);
}

main().catch((err) => console.error('[blerb overlay]', err));
