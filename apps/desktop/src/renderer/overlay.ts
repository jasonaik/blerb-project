import { loadPack, type Fetcher } from '@blerb/pack';
import { createSim, type PetSnapshot, type World } from '@blerb/core';
import { CanvasRenderer, type Ctx2D } from '@blerb/render-canvas';

/**
 * The overlay page: run the sim, paint the pet, report its bbox so main can
 * flip click-through, and let the user pick the pet up and drop it on things.
 *
 * The window covers the whole display and is click-through except over the
 * pet's pixels, so from the user's side this page *is* the pet.
 */

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const snapshotKey = (packId: string) => `blerb:snapshot:${packId}`;

async function main(): Promise<void> {
  const init = await window.blerb.init();

  // fetch() can't touch file: URLs from a file: page; all disk access goes
  // through the preload's read(), which main restricts to packs/.
  const fetcher: Fetcher = async (url) => {
    try {
      const bytes = await window.blerb.read(url);
      return { ok: true, status: 200, text: async () => new TextDecoder().decode(bytes) };
    } catch {
      return { ok: false, status: 404, text: async () => '' };
    }
  };

  const pack = await loadPack(fetcher, `${init.packDir}/pet.json`);
  const atlasBytes = await window.blerb.read(pack.atlasUrl);
  const atlas = await createImageBitmap(new Blob([atlasBytes as BlobPart]));

  let snapshot: PetSnapshot | undefined;
  try {
    const raw = localStorage.getItem(snapshotKey(pack.id));
    if (raw) snapshot = JSON.parse(raw) as PetSnapshot;
  } catch {
    /* fresh start */
  }

  const sim = createSim({
    pack,
    world: init.world,
    ...(snapshot ? { snapshot } : {}),
  });

  let world: World = init.world;
  let debug = init.settings.debugOverlay;
  let petScale = init.settings.petScale;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  const renderer = new CanvasRenderer({
    ctx: ctx as unknown as Ctx2D,
    pack,
    atlas,
    dpr: devicePixelRatio || 1,
  });

  function resize(): void {
    const dpr = devicePixelRatio || 1;
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    canvas.style.width = `${innerWidth}px`;
    canvas.style.height = `${innerHeight}px`;
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderer.setDpr(dpr);
  }
  resize();
  addEventListener('resize', resize);

  window.blerb.onWorld((w) => {
    world = w;
    sim.dispatch({ k: 'world', world: w });
  });
  window.blerb.onVisibility((v) => {
    sim.dispatch(v.hidden ? { k: 'hide', reason: v.reason } : { k: 'show' });
  });
  window.blerb.onSettings((s) => {
    debug = s.debugOverlay;
    petScale = s.petScale;
  });
  window.blerb.onCommand((c) => sim.dispatch({ k: 'command', name: c.name }));

  // ---- pick up & drop -----------------------------------------------------
  // Main only routes mouse events here while the cursor is over the pet, so a
  // pointerdown is by construction a grab. The drag latch keeps the window
  // interactive while the cursor is outside the (stale) bbox mid-drag.
  let dragging = false;
  addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    window.blerb.drag(true);
    sim.dispatch({ k: 'command', name: 'place', x: e.clientX, y: e.clientY });
  });
  addEventListener('pointermove', (e) => {
    if (dragging) sim.dispatch({ k: 'command', name: 'place', x: e.clientX, y: e.clientY });
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

  // ---- reporting ----------------------------------------------------------
  setInterval(() => {
    const f = sim.frame();
    const cell = pack.cells.get(f.cellId);
    if (!cell) return;
    window.blerb.bbox({
      x: f.x - cell.anchor[0] * petScale,
      y: f.y - cell.anchor[1] * petScale,
      w: cell.w * petScale,
      h: cell.h * petScale,
    });
  }, 100);

  setInterval(() => {
    try {
      localStorage.setItem(snapshotKey(pack.id), JSON.stringify(sim.serialize()));
    } catch {
      /* storage full — the pet just respawns next launch */
    }
  }, 5000);

  // ---- the loop -----------------------------------------------------------
  //
  // This window is the size of the display, so a naive "clear everything and
  // repaint" at 60fps costs ~54% of a core at idle — measured, not guessed.
  // Two fixes, both of which matter:
  //
  //   1. Skip frames that are visually identical. The pet idles at 2fps and
  //      spends >70% of its life stationary (design contract rule 4), so most
  //      frames genuinely have nothing to say.
  //   2. Clear only the union of where the pet was and where it now is, rather
  //      than 5.2 megapixels of mostly-empty canvas.

  interface Rect { x: number; y: number; w: number; h: number }

  /** Padding for rotation/squash overshoot, plus a safety margin. */
  const PAD = 12;

  function spriteRect(f: ReturnType<typeof sim.frame>): Rect | null {
    const cell = pack.cells.get(f.cellId);
    if (!cell) return null;
    const w = cell.w * f.scale;
    const h = cell.h * f.scale;
    return {
      x: f.x - cell.anchor[0] * f.scale - PAD,
      y: f.y - cell.anchor[1] * f.scale - PAD,
      w: w + PAD * 2,
      h: h + PAD * 2,
    };
  }

  const frameKey = (f: ReturnType<typeof sim.frame>) =>
    `${f.cellId}|${f.x.toFixed(1)}|${f.y.toFixed(1)}|${f.facing}|${f.scale}|` +
    `${f.opacity}|${f.rotation.toFixed(3)}|${f.squash.sx.toFixed(3)}|${f.squash.sy.toFixed(3)}`;

  let prevRect: Rect | null = null;
  let prevKey = '';
  let last = performance.now();
  let idleFrames = 0;
  let parked = false;

  /**
   * Consecutive unchanged frames before we stop asking for animation frames.
   * ~1/3 second: long enough not to thrash on the pause between walk cycles,
   * short enough that a sleeping pet parks almost immediately.
   */
  const PARK_AFTER = 20;
  /** Sim tick while parked. Coarse on purpose — nothing is being drawn. */
  const PARKED_MS = 100;

  function schedule(): void {
    if (parked) window.setTimeout(() => tick(performance.now()), PARKED_MS);
    else requestAnimationFrame(tick);
  }

  function tick(now: number): void {
    const dt = now - last;
    last = now;

    sim.step(dt);
    const frame = sim.frame();
    frame.scale *= petScale;

    const key = frameKey(frame);
    if (key === prevKey && !debug) {
      // Nothing to draw. After a while stop requesting animation frames
      // entirely — an idle pet should cost roughly nothing, and RAF at 60Hz
      // for a sprite that moves twice a second is most of the bill.
      if (++idleFrames >= PARK_AFTER) parked = true;
      schedule();
      return;
    }
    idleFrames = 0;
    parked = false;
    prevKey = key;

    const rect = spriteRect(frame);

    if (debug) {
      // Dev only — platform lines span the display, so partial clears don't help.
      renderer.clear(innerWidth, innerHeight);
      renderer.draw(frame);
      renderer.drawDebug(world, frame);
    } else {
      // Clear the union of old and new positions in one rect. Two clears would
      // also work, but a union is cheaper and the pet never moves far in 16ms.
      const u = prevRect && rect ? unionRect(prevRect, rect) : (rect ?? prevRect);
      if (u) ctx!.clearRect(u.x, u.y, u.w, u.h);
      renderer.draw(frame);
    }

    prevRect = rect;
    schedule();
  }

  function unionRect(a: Rect, b: Rect): Rect {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
  }

  // A resize invalidates the backing store, so the next frame must repaint
  // unconditionally rather than being skipped as "unchanged".
  addEventListener('resize', () => {
    prevKey = '';
    prevRect = null;
  });

  requestAnimationFrame(tick);
  console.log('[blerb] render loop up (parks when idle)');

  console.log(`[blerb] pet "${pack.name}" up at scale ${petScale}`);
}

main().catch((err) => console.error('[blerb overlay]', err));
