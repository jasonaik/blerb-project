import { loadPack } from '@blerb/pack';
import { createSim, type Platform, type World } from '@blerb/core';
import { CanvasRenderer, type Ctx2D } from '@blerb/render-canvas';

/**
 * Phase 0 gate, and the inner loop for everything after it.
 *
 * World coordinates are CSS pixels with the origin at the top-left of the
 * viewport, which is exactly the page's own coordinate space. That means the
 * ledges below can be plain DOM elements positioned by the same numbers the
 * sim is given — so if the pet looks like it's standing on one, it genuinely
 * is, rather than both happening to be painted in the same place.
 */

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLElement;
const errBox = document.getElementById('err') as HTMLElement;
const ledgeHost = document.getElementById('ledges') as HTMLElement;

function fail(e: unknown): never {
  errBox.style.display = 'block';
  errBox.textContent = e instanceof Error ? `${e.name}: ${e.message}\n\n${e.stack ?? ''}` : String(e);
  throw e;
}

/** Ledges as fractions of the viewport, so they survive a resize sensibly. */
const LEDGE_SPEC = [
  { fx: 0.12, fy: 0.55, fw: 0.22 },
  { fx: 0.46, fy: 0.38, fw: 0.18 },
  { fx: 0.72, fy: 0.62, fw: 0.2 },
];

let worldRev = 1;

function buildWorld(w: number, h: number): World {
  const platforms: Platform[] = [{ id: 'floor', x0: 0, x1: w, y: h - 8, kind: 'floor', passthrough: false }];

  LEDGE_SPEC.forEach((s, i) => {
    platforms.push({
      id: `ledge${i}`,
      x0: Math.round(s.fx * w),
      x1: Math.round((s.fx + s.fw) * w),
      y: Math.round(s.fy * h),
      kind: 'ledge',
      passthrough: true,
    });
  });

  platforms.sort((a, b) => a.y - b.y);

  return {
    rev: worldRev,
    bounds: { x: 0, y: 0, w, h },
    platforms,
    gravity: 900,
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  };
}

function syncLedgeDom(world: World): void {
  ledgeHost.replaceChildren(
    ...world.platforms
      .filter((p) => p.kind === 'ledge')
      .map((p) => {
        const el = document.createElement('div');
        el.className = 'ledge';
        el.style.left = `${p.x0}px`;
        el.style.top = `${p.y}px`;
        el.style.width = `${p.x1 - p.x0}px`;
        el.style.height = '8px';
        return el;
      }),
  );
}

async function main(): Promise<void> {
  const pack = await loadPack((url) => fetch(url), '/pack/pet.json');

  const atlasBlob = await fetch(pack.atlasUrl).then((r) => {
    if (!r.ok) throw new Error(`atlas ${pack.atlasUrl}: HTTP ${r.status}`);
    return r.blob();
  });
  const atlas = await createImageBitmap(atlasBlob);

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');

  let world = buildWorld(window.innerWidth, window.innerHeight);
  syncLedgeDom(world);

  const sim = createSim({ pack, world, seed: 20260805 });
  const renderer = new CanvasRenderer({
    ctx: ctx as unknown as Ctx2D,
    pack,
    atlas,
    dpr: window.devicePixelRatio || 1,
  });

  let lastW = -1;
  let lastH = -1;

  function resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w === lastW && h === lastH) return;
    if (w === 0 || h === 0) return; // Hidden pane; wait for a real size.
    lastW = w;
    lastH = h;

    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    // World px == CSS px from here on; the backing store scale is invisible
    // to everything above this line.
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

    worldRev++;
    world = buildWorld(w, h);
    syncLedgeDom(world);
    sim.dispatch({ k: 'world', world });
    renderer.setDpr(dpr);
  }

  resize();
  window.addEventListener('resize', resize);
  // A `resize` event isn't guaranteed when the page starts at zero size (a
  // hidden pane, a devtools-docked window). Observing the element covers the
  // case where the page only gets a real size some time after load.
  new ResizeObserver(resize).observe(document.documentElement);

  let debug = false;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'd') debug = !debug;
    if (e.key === 'r') sim.dispatch({ k: 'command', name: 'recenter' });
    if (e.key === 'q') window.close();
  });
  window.addEventListener('pointerdown', (e) => {
    sim.dispatch({ k: 'command', name: 'come-here', x: e.clientX, y: e.clientY });
  });

  let last = performance.now();
  let virtualNow = last;
  let fpsEma = 60;

  /** One frame: advance the sim, draw, update the HUD. Schedules nothing. */
  function renderFrame(now: number): void {
    const dt = now - last;
    last = now;
    if (dt > 0) fpsEma += (1000 / dt - fpsEma) * 0.05;

    sim.step(dt);
    const frame = sim.frame();

    renderer.clear(window.innerWidth, window.innerHeight);
    renderer.draw(frame);
    if (debug) renderer.drawDebug(world, frame);

    const s = sim.state;
    hud.textContent = [
      `${pack.name}  (${pack.id})`,
      `fps      ${fpsEma.toFixed(0)}`,
      `behavior ${s.behavior}  ${(s.behaviorT / 1000).toFixed(1)}/${(s.behaviorDur / 1000).toFixed(1)}s`,
      `anim     ${s.anim} -> ${frame.cellId}`,
      `pos      ${s.x.toFixed(1)}, ${s.y.toFixed(1)}  facing ${s.facing > 0 ? '>' : '<'}`,
      `on       ${s.standingOn ?? '(air)'}`,
      `moving   ${(s.motionEma * 100).toFixed(0)}%  budget 30%`,
      `odometer ${s.odometer.toFixed(0)}px`,
      debug ? 'debug    on' : 'debug    off  (press d)',
    ].join('\n');
  }

  function tick(now: number): void {
    renderFrame(now);
    requestAnimationFrame(tick);
  }

  /**
   * Debug handle. `requestAnimationFrame` does not fire in a page that isn't
   * compositing (a hidden pane, a background window), which makes the preview
   * impossible to inspect from automation. This lets frames be driven by hand:
   *
   *   __blerb.resize(); __blerb.advance(2000);   // 2s of sim, drawn
   */
  (window as unknown as Record<string, unknown>).__blerb = {
    sim,
    renderer,
    resize,
    get world() {
      return world;
    },
    /**
     * Run `ms` of simulation in realistic 16ms slices and draw the result.
     *
     * Uses its own monotonic clock rather than `performance.now()`: consecutive
     * calls in a tight loop would otherwise be separated by microseconds of
     * real time, so every slice would advance the sim by ~0ms and the pet
     * would appear frozen. That is a property of the harness, not the pet.
     */
    advance(ms: number) {
      for (let t = 0; t < ms; t += 16) {
        virtualNow += 16;
        renderFrame(virtualNow);
      }
      return sim.state;
    },
  };

  requestAnimationFrame(tick);
}

main().catch(fail);
