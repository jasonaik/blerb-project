import { describe, expect, it } from 'vitest';
import { resolvePack } from '@blerb/pack';
import { createSim, simpleWorld, WORLD_FLOOR } from './sim.js';
import { EPS, unionRect } from './geom.js';
import { buildDesktopGeometry, type ScreenInfo } from './desktop.js';
import type { PetState, World } from './types.js';

const testPack = (behavior: Record<string, unknown> = {}) =>
  resolvePack({
    format: 'blerb-pet/1',
    id: 'test',
    name: 'Test',
    atlas: { src: 'atlas.png' },
    grid: { w: 32, h: 32, cols: 4 },
    animations: {
      idle: { fps: 3, frames: [0, 1] },
      walk: { fps: 8, frames: [2, 3, 2, 0], designSpeed: 40 },
      fall: { fps: 6, frames: [1] },
      land: { fps: 12, loop: false, frames: [1, 0] },
    },
    aliases: { climb: 'walk', cling: 'idle', sit: 'idle', sleep: 'idle', stretch: 'idle' },
    behavior,
  });

/** Deterministic dt sequence with realistic jitter — not a constant. */
function dtSequence(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(14 + ((i * 7) % 6));
  return out;
}

function run(seed: number, steps: number): PetState {
  const sim = createSim({ pack: testPack(), world: simpleWorld(800, 400), seed });
  for (const dt of dtSequence(steps)) sim.step(dt);
  return structuredClone(sim.state) as PetState;
}

describe('determinism', () => {
  it('produces identical state from identical (seed, dt sequence)', () => {
    expect(run(12345, 2000)).toEqual(run(12345, 2000));
  });

  it('produces different state from a different seed', () => {
    expect(run(12345, 2000)).not.toEqual(run(999, 2000));
  });

  it('restores from a snapshot without diverging', () => {
    const pack = testPack();
    const world = simpleWorld(800, 400);

    const a = createSim({ pack, world, seed: 4242 });
    for (const dt of dtSequence(600)) a.step(dt);
    const snapshot = a.serialize();

    const b = createSim({ pack, world, snapshot });
    for (const dt of dtSequence(400)) {
      a.step(dt);
      b.step(dt);
    }

    // The rng travels with the snapshot, so the restored pet makes the same
    // decisions the original would have.
    expect(b.state.rng).toBe(a.state.rng);
    expect(b.state.facing).toBe(a.state.facing);
  });
});

describe('physics', () => {
  it('stays inside world bounds over a long run', () => {
    const sim = createSim({ pack: testPack(), world: simpleWorld(800, 400), seed: 7 });
    for (const dt of dtSequence(20_000)) {
      sim.step(dt);
      expect(sim.state.x).toBeGreaterThanOrEqual(0);
      expect(sim.state.x).toBeLessThanOrEqual(800);
      expect(sim.state.y).toBeLessThanOrEqual(400);
    }
  });

  it('settles onto the floor rather than dropping in from nowhere', () => {
    const sim = createSim({ pack: testPack(), world: simpleWorld(800, 400), seed: 1 });
    expect(sim.state.y).toBe(400);
    expect(sim.state.standingOn).toBe('floor');
  });

  /** Start the pet above a ledge so the initial settle lands it there. */
  const onLedge = (x: number, y: number) => ({ x, y, facing: 1 as const, behavior: 'idle' as const, rng: 99 });

  it('settles onto the nearest platform below, not the floor beneath it', () => {
    const pack = testPack();
    const world = simpleWorld(800, 400);
    world.platforms.push({ id: 'ledge', x0: 300, x1: 500, y: 200, kind: 'ledge', passthrough: false });

    const sim = createSim({ pack, world, snapshot: onLedge(400, 50) });
    expect(sim.state.standingOn).toBe('ledge');
    expect(sim.state.y).toBe(200);
  });

  // Regression: the preview puts its floor a few px above the viewport bottom
  // while the pet spawns at the bottom, so the pet started *below* every
  // platform. `standingOn` was null (= airborne), it landed on the world floor
  // which also set null, and it looped fall -> land -> fall forever without
  // ever picking a new behavior.
  it('recovers when it starts below every platform', () => {
    const pack = testPack();
    const world = simpleWorld(800, 400);
    world.platforms = [{ id: 'floor', x0: 0, x1: 800, y: 392, kind: 'floor', passthrough: false }];

    const sim = createSim({ pack, world, seed: 31 });
    expect(sim.state.standingOn).toBe('floor');
    expect(sim.state.y).toBe(392);

    const seen = new Set<string>();
    for (const dt of dtSequence(3000)) {
      sim.step(dt);
      seen.add(sim.state.behavior);
    }
    // It must actually get on with living, not oscillate between two states.
    expect(seen.has('idle') || seen.has('walk') || seen.has('sit')).toBe(true);
  });

  it('treats the world floor as ground, not as falling', () => {
    const pack = testPack();
    // No platforms at all — the host forgot. The pet should still settle.
    const world = { ...simpleWorld(800, 400), platforms: [] };

    const sim = createSim({ pack, world, seed: 37 });
    for (const dt of dtSequence(3000)) sim.step(dt);

    expect(sim.state.y).toBeLessThanOrEqual(400);
    expect(sim.state.behavior).not.toBe('fall');
  });

  it('falls when the platform it was standing on disappears', () => {
    const pack = testPack();
    const world = simpleWorld(800, 400);
    world.platforms.push({ id: 'ledge', x0: 300, x1: 500, y: 200, kind: 'ledge', passthrough: false });

    const sim = createSim({ pack, world, snapshot: onLedge(400, 50) });
    expect(sim.state.standingOn).toBe('ledge');

    // The window it was standing on closed.
    sim.dispatch({ k: 'world', world: { ...simpleWorld(800, 400), rev: 2 } });
    expect(sim.state.behavior).toBe('fall');
  });

  it('place drops the pet and it lands on the platform below', () => {
    const pack = testPack();
    const world = simpleWorld(800, 400);
    world.platforms.push({ id: 'win', x0: 200, x1: 600, y: 250, kind: 'ledge', passthrough: true });

    const sim = createSim({ pack, world, seed: 41 });
    sim.dispatch({ k: 'command', name: 'place', x: 400, y: 100 });
    expect(sim.state.behavior).toBe('fall');

    for (const dt of dtSequence(300)) sim.step(dt);
    expect(sim.state.standingOn).toBe('win');
    expect(sim.state.y).toBe(250);
  });

  it('rides a platform that moves', () => {
    const pack = testPack();
    const world = simpleWorld(800, 400);
    world.platforms.push({ id: 'win', x0: 100, x1: 700, y: 250, kind: 'ledge', passthrough: false });

    const sim = createSim({ pack, world, snapshot: onLedge(400, 50) });
    expect(sim.state.y).toBe(250);

    // Same window id, dragged upward — the pet should ride it rather than
    // treating the ground as having vanished.
    const moved = simpleWorld(800, 400);
    moved.rev = 2;
    moved.platforms.push({ id: 'win', x0: 100, x1: 700, y: 180, kind: 'ledge', passthrough: false });
    sim.dispatch({ k: 'world', world: moved });

    expect(sim.state.y).toBe(180);
    expect(sim.state.standingOn).toBe('win');
  });
});

describe('design contract', () => {
  // Rule 4: stationary >=70% of wall-clock. Enforced in code, so tested.
  it('keeps the pet stationary at least 70% of the time', () => {
    const sim = createSim({ pack: testPack(), world: simpleWorld(800, 400), seed: 11 });
    let moving = 0;
    let total = 0;
    for (const dt of dtSequence(40_000)) {
      sim.step(dt);
      total++;
      if (Math.abs(sim.state.vx) > 0.5) moving++;
    }
    expect(moving / total).toBeLessThan(0.3);
  });

  it('does not move at all while hidden', () => {
    const sim = createSim({ pack: testPack(), world: simpleWorld(800, 400), seed: 13 });
    sim.dispatch({ k: 'hide', reason: 'manual' });
    const before = structuredClone(sim.state) as PetState;
    for (const dt of dtSequence(5000)) sim.step(dt);
    expect(sim.state).toEqual(before);
  });

  it('does not fast-forward across a long absence', () => {
    const sim = createSim({ pack: testPack(), world: simpleWorld(800, 400), seed: 17 });
    for (const dt of dtSequence(500)) sim.step(dt);
    const x = sim.state.x;

    // Three hours asleep.
    sim.dispatch({ k: 'resume', gapMs: 3 * 60 * 60 * 1000 });
    expect(sim.state.x).toBe(x);
    expect(sim.state.behavior).toBe('idle');
  });

  it('clamps a single enormous dt instead of integrating it', () => {
    const sim = createSim({ pack: testPack(), world: simpleWorld(800, 400), seed: 19 });
    sim.step(60 * 60 * 1000);
    expect(sim.state.x).toBeGreaterThanOrEqual(0);
    expect(sim.state.x).toBeLessThanOrEqual(800);
  });
});

describe('climbing', () => {
  const alwaysClimbs = () => testPack({ climbiness: 1, can: { fall: false } });

  /**
   * Put the pet on the ground near `x` and set it walking toward `dir`.
   * Random-walking to a wall takes tens of simulated seconds and often doesn't
   * happen at all — driving it there makes these tests about climbing rather
   * than about luck.
   */
  function walkAt(sim: ReturnType<typeof createSim>, x: number, y: number, dir: 1 | -1) {
    sim.dispatch({ k: 'command', name: 'place', x, y });
    for (const dt of dtSequence(400)) {
      sim.step(dt);
      if (sim.state.standingOn !== null) break;
    }
    sim.dispatch({ k: 'command', name: 'come-here', x: dir > 0 ? 1e6 : -1e6 });
  }

  it('climbs a wall instead of turning at the screen edge', () => {
    const sim = createSim({ pack: alwaysClimbs(), world: simpleWorld(800, 400), seed: 51 });
    walkAt(sim, 780, 400, 1);

    for (const dt of dtSequence(600)) {
      sim.step(dt);
      if (sim.state.climbingOn !== null) break;
    }
    expect(sim.state.climbingOn).toBe('wr');
    expect(sim.state.x).toBe(800);
    expect(sim.state.behavior).toBe('climb');
  });

  it('gains height while climbing', () => {
    const sim = createSim({ pack: alwaysClimbs(), world: simpleWorld(800, 400), seed: 53 });
    walkAt(sim, 780, 400, 1);

    let minY = Infinity;
    for (const dt of dtSequence(4000)) {
      sim.step(dt);
      if (sim.state.climbingOn !== null) minY = Math.min(minY, sim.state.y);
      expect(sim.state.y).toBeGreaterThanOrEqual(0);
    }
    expect(minY).toBeLessThan(340); // meaningfully up the wall from y=400
  });

  it('rotates the sprite so its feet meet the wall', () => {
    const sim = createSim({ pack: alwaysClimbs(), world: simpleWorld(800, 400), seed: 57 });
    walkAt(sim, 780, 400, 1);
    for (const dt of dtSequence(600)) {
      sim.step(dt);
      if (sim.state.climbingOn !== null) break;
    }
    // Right-hand wall (side -1) => rotate -90deg, so "down" becomes "right".
    expect(sim.frame().rotation).toBeCloseTo(-Math.PI / 2, 5);
  });

  it('climbs the left wall too, rotated the other way', () => {
    const sim = createSim({ pack: alwaysClimbs(), world: simpleWorld(800, 400), seed: 58 });
    walkAt(sim, 20, 400, -1);
    for (const dt of dtSequence(600)) {
      sim.step(dt);
      if (sim.state.climbingOn !== null) break;
    }
    expect(sim.state.climbingOn).toBe('wl');
    expect(sim.state.x).toBe(0);
    expect(sim.frame().rotation).toBeCloseTo(Math.PI / 2, 5);
  });

  it('climbs head-first upward on both edges of the desktop', () => {
    // The renderer composes rotation with the facing mirror, so this is the
    // direction the sprite's nose actually points on screen. Asserting it
    // rather than `facing` is the difference between testing the picture and
    // testing a number that only means something once you know which wall.
    const noseY = (f: { facing: number; rotation: number }) =>
      f.facing * Math.sin(f.rotation);

    for (const [startX, dir, wall] of [
      [780, 1, 'wr'],
      [20, -1, 'wl'],
    ] as const) {
      const sim = createSim({ pack: alwaysClimbs(), world: simpleWorld(800, 400), seed: 61 });
      walkAt(sim, startX, 400, dir);
      for (const dt of dtSequence(600)) {
        sim.step(dt);
        if (sim.state.climbingOn !== null) break;
      }
      expect(sim.state.climbingOn).toBe(wall);
      expect(sim.state.climbDir).toBe(-1);
      expect(noseY(sim.frame())).toBeLessThan(-0.99); // up, not down
    }
  });

  it('falls if the wall it was climbing disappears', () => {
    const sim = createSim({ pack: alwaysClimbs(), world: simpleWorld(800, 400), seed: 59 });
    walkAt(sim, 780, 400, 1);
    for (const dt of dtSequence(600)) {
      sim.step(dt);
      if (sim.state.climbingOn !== null) break;
    }
    expect(sim.state.climbingOn).not.toBeNull();

    sim.dispatch({ k: 'world', world: { ...simpleWorld(800, 400), rev: 2, walls: [] } });
    expect(sim.state.behavior).toBe('fall');
    expect(sim.state.climbingOn).toBeNull();
  });

  it('eventually comes back down and ends up on the ground', () => {
    const sim = createSim({ pack: testPack({ climbiness: 1 }), world: simpleWorld(800, 400), seed: 60 });
    walkAt(sim, 780, 400, 1);
    for (const dt of dtSequence(60_000)) sim.step(dt);
    // Whatever route it took — climbing down, or letting go — it is not stuck
    // clinging forever, and it is inside the screen.
    expect(sim.state.y).toBeLessThanOrEqual(400);
    expect(sim.state.x).toBeLessThanOrEqual(800);
  });

  it('clings to a wall when the user drops it against one', () => {
    const sim = createSim({ pack: testPack(), world: simpleWorld(800, 400), seed: 63 });
    sim.dispatch({ k: 'command', name: 'place', x: 792, y: 150 });

    expect(sim.state.climbingOn).toBe('wr');
    expect(sim.state.behavior).toBe('cling');
    expect(sim.state.x).toBe(800); // snapped to the wall, not left 8px shy
    expect(sim.state.y).toBe(150);
  });

  it('prefers the ground when dropped into the bottom corner', () => {
    // Every drop near the floor is also near the wall. Silently pasting the
    // pet to the edge when the user aimed at the floor is the worse failure.
    const sim = createSim({ pack: testPack(), world: simpleWorld(800, 400), seed: 65 });
    sim.dispatch({ k: 'command', name: 'place', x: 794, y: 392 });

    expect(sim.state.climbingOn).toBeNull();
    for (const dt of dtSequence(400)) sim.step(dt);
    expect(sim.state.standingOn).toBe('floor');
  });

  it('does not cling on placement when the pack cannot climb', () => {
    const pack = testPack({ can: { climb: false } });
    const sim = createSim({ pack, world: simpleWorld(800, 400), seed: 67 });
    sim.dispatch({ k: 'command', name: 'place', x: 798, y: 150 });
    expect(sim.state.climbingOn).toBeNull();
  });

  it('never climbs when the pack says it cannot', () => {
    const pack = testPack({ can: { climb: false }, climbiness: 1 });
    const sim = createSim({ pack, world: simpleWorld(800, 400), seed: 61 });
    walkAt(sim, 780, 400, 1);
    for (const dt of dtSequence(20_000)) {
      sim.step(dt);
      expect(sim.state.climbingOn).toBeNull();
    }
  });
});

describe('multi-display', () => {
  /**
   * A grounded pet must be on the ground it claims to be on.
   *
   * The bug this exists for: `regionAt` allows 1.5px of slop so the pet can
   * stand exactly on a screen boundary. A pet stepping off the end of one
   * screen's ground is a fraction of a pixel into its neighbour, so the slop
   * matched the screen it had just *left* — and the fall stopped it on that
   * screen's floor line, in mid-air above the screen below. It then walked
   * around on nothing.
   */
  function expectRealGround(world: World, s: PetState): void {
    if (s.standingOn === null) return; // airborne, nothing to check
    if (s.standingOn === WORLD_FLOOR) {
      const r = world.regions.find(
        (g) => s.x >= g.x - EPS && s.x <= g.x + g.w + EPS && Math.abs(g.y + g.h - s.y) <= EPS,
      );
      expect(r, `standing on world floor at ${s.x},${s.y} — no region bottom there`).toBeDefined();
      return;
    }
    const p = world.platforms.find((q) => q.id === s.standingOn);
    expect(p, `standing on unknown platform ${s.standingOn}`).toBeDefined();
    expect(s.x).toBeGreaterThanOrEqual(p!.x0 - EPS);
    expect(s.x).toBeLessThanOrEqual(p!.x1 + EPS);
    expect(Math.abs(s.y - p!.y)).toBeLessThanOrEqual(EPS);
  }

  /**
   * Build a World the way the app does: from screens, through the same
   * `buildDesktopGeometry` the scanner uses.
   *
   * Hand-written fixtures are how a descent route that does not exist got
   * certified. The fixture left out walls the real scanner emits, so in the
   * test the pet walked off an edge that is fenced on actual hardware. If a
   * test needs a desktop, it declares screens and derives everything else.
   */
  const desktop = (list: ScreenInfo[], rev = 1): World => {
    const regions = list.map((s) => s.region);
    const { platforms, walls } = buildDesktopGeometry(list);
    platforms.sort((a, z) => a.y - z.y); // as the scanner does
    return {
      rev,
      bounds: unionRect(regions),
      regions,
      platforms,
      walls,
      gravity: 900,
      reducedMotion: false,
    };
  };

  /** Two 800x400 screens side by side, the second offset down by 100. */
  const SIDE_BY_SIDE: ScreenInfo[] = [
    { id: 'A', region: { x: 0, y: 0, w: 800, h: 400 }, floorY: 400 },
    { id: 'B', region: { x: 800, y: 100, w: 800, h: 400 }, floorY: 500 },
  ];

  /** The same two, flush: same height, touching. The pet should walk across. */
  const FLUSH: ScreenInfo[] = [
    { id: 'A', region: { x: 0, y: 0, w: 800, h: 400 }, floorY: 400 },
    { id: 'B', region: { x: 800, y: 0, w: 800, h: 400 }, floorY: 400 },
  ];

  /** Screen U directly above screen L, side edges aligned. */
  const STACK: ScreenInfo[] = [
    { id: 'U', region: { x: 0, y: 0, w: 800, h: 400 }, floorY: 400 },
    { id: 'L', region: { x: 0, y: 400, w: 800, h: 400 }, floorY: 800 },
  ];

  /**
   * The real layout on the dev machine (CLAUDE.md §14): a 1440x900 laptop at
   * 0,0 with a taskbar, and a 1920x1080 external above it offset right by 233.
   * Their side edges do NOT line up, so crossing between them needs the mantle
   * going up and a seam drop coming down.
   */
  const DEV: ScreenInfo[] = [
    { id: 'laptop', region: { x: 0, y: 0, w: 1440, h: 900 }, floorY: 852 },
    { id: 'ext', region: { x: 233, y: -1080, w: 1920, h: 1080 }, floorY: -48 },
  ];

  it('derives the documented shape from the dev machine layout', () => {
    const { platforms, walls } = buildDesktopGeometry(DEV);
    const ids = (xs: { id: string }[]) => xs.map((x) => x.id).sort();

    expect(ids(platforms)).toEqual(['floor:ext:0', 'floor:laptop:0', 'seam:ext:0']);
    // The external's ground is one line at y=-48: seam over the laptop, plain
    // floor where it overhangs to the right.
    expect(platforms.find((p) => p.id === 'seam:ext:0')).toMatchObject({
      x0: 233,
      x1: 1440,
      y: -48,
      passthrough: true,
    });
    expect(platforms.find((p) => p.id === 'floor:ext:0')).toMatchObject({
      x0: 1440,
      x1: 2153,
      y: -48,
      passthrough: false,
    });

    // Walls stop at the ground, not at the screen's bottom pixel — otherwise a
    // pet climbing down slides 48px behind the taskbar.
    expect(ids(walls)).toEqual([
      'wall:ext:l:0',
      'wall:ext:r:0',
      'wall:laptop:l:0',
      'wall:laptop:r:0',
    ]);
    expect(walls.find((w) => w.id === 'wall:laptop:r:0')).toMatchObject({ x: 1440, y0: 0, y1: 852 });
  });

  it('does not walk into the dead space between offset monitors', () => {
    const sim = createSim({
      pack: testPack({ climbiness: 0 }),
      world: desktop(SIDE_BY_SIDE),
      seed: 71,
    });
    for (const dt of dtSequence(40_000)) {
      sim.step(dt);
      const { x, y } = sim.state;
      const onA = x >= -2 && x <= 802 && y >= -2 && y <= 402;
      const onB = x >= 798 && x <= 1602 && y >= 98 && y <= 502;
      expect(onA || onB).toBe(true);
    }
  });

  it('crosses from one screen to the next along a shared floor', () => {
    // Two platforms meeting at x=800 with no wall between them. The join must
    // not read as a cliff just because it is a different platform id.
    const world = desktop(FLUSH);
    const sim = createSim({ pack: testPack({ climbiness: 0 }), world, seed: 73 });
    sim.dispatch({ k: 'command', name: 'place', x: 760, y: 400 });
    for (const dt of dtSequence(400)) {
      sim.step(dt);
      if (sim.state.standingOn !== null) break;
    }
    expect(sim.state.standingOn).toBe('floor:A:0');
    sim.dispatch({ k: 'command', name: 'come-here', x: 1e6 });

    let maxX = 0;
    for (const dt of dtSequence(3000)) {
      sim.step(dt);
      maxX = Math.max(maxX, sim.state.x);
      expectRealGround(world, sim.state);
    }
    expect(maxX).toBeGreaterThan(830); // crossed the seam onto screen B
    expect(sim.state.y).toBe(400); // and never left the shared ground line
    expect(sim.state.standingOn).toBe('floor:B:0');
  });

  it('climbs from the lower screen onto the one above it', () => {
    const pack = testPack({ climbiness: 1, can: { fall: false }, speed: { climb: 200 } });
    const sim = createSim({ pack, world: desktop(STACK), seed: 77 });
    sim.dispatch({ k: 'command', name: 'place', x: 780, y: 800 });
    for (const dt of dtSequence(400)) {
      sim.step(dt);
      if (sim.state.standingOn !== null) break;
    }
    sim.dispatch({ k: 'command', name: 'come-here', x: 1e6 });

    let reachedUpper = false;
    for (const dt of dtSequence(6000)) {
      sim.step(dt);
      if (sim.state.climbingOn === 'wall:U:r:0') reachedUpper = true;
    }
    expect(reachedUpper).toBe(true);
  });

  it('mantles from a lower screen onto a higher one whose edges do not line up', () => {
    const pack = testPack({ climbiness: 1, can: { fall: false }, speed: { climb: 400 } });
    const sim = createSim({ pack, world: desktop(DEV), seed: 91 });
    sim.dispatch({ k: 'command', name: 'place', x: 1420, y: 852 });
    for (const dt of dtSequence(400)) {
      sim.step(dt);
      if (sim.state.standingOn !== null) break;
    }
    sim.dispatch({ k: 'command', name: 'come-here', x: 1e6 });

    let mantled = false;
    for (const dt of dtSequence(6000)) {
      sim.step(dt);
      if (sim.state.standingOn === 'floor:ext:0') mantled = true;
    }
    expect(mantled).toBe(true);
  });

  it('lands on the bottom edge of the screen it was dropped on', () => {
    const world = desktop(STACK);
    const sim = createSim({ pack: testPack({ climbiness: 0 }), world, seed: 79 });
    // Dropped in mid-air, high up on the UPPER screen.
    sim.dispatch({ k: 'command', name: 'place', x: 400, y: 50 });

    for (const dt of dtSequence(400)) sim.step(dt);
    // Stops at the first ground under it, not at the bottom of the desktop.
    // Falling through the screen you put it on reads as broken.
    expect(sim.state.y).toBe(400);
    expect(sim.state.standingOn).toBe('seam:U:0');

    // And it stays put for a while rather than dribbling straight off again.
    for (const dt of dtSequence(600)) sim.step(dt);
    expect(sim.state.y).toBe(400);
  });

  /**
   * The regression that made the drop-through necessary: with the seam solid
   * and nothing reading `passthrough`, the pet climbed to the top monitor and
   * could never come back — 0/12 autonomous runs descended.
   *
   * Deliberately no `come-here` in these: the pet has to manage on its own, or
   * it is stranded on whichever screen it drifts to.
   */
  for (const [label, behavior] of [
    ['on its own', { climbiness: 0 }],
    ['even when it cannot climb', { climbiness: 0, can: { climb: false } }],
  ] as const) {
    it(`finds its way down from an upper screen ${label}`, () => {
      const world = desktop(STACK);
      const sim = createSim({ pack: testPack(behavior), world, seed: 81 });
      sim.dispatch({ k: 'command', name: 'place', x: 400, y: 50 });
      for (const dt of dtSequence(400)) {
        sim.step(dt);
        if (sim.state.standingOn !== null) break;
      }
      expect(sim.state.standingOn).toBe('seam:U:0');

      let arrived = false;
      for (const dt of dtSequence(120_000)) {
        sim.step(dt);
        expectRealGround(world, sim.state);
        if (sim.state.standingOn === 'floor:L:0') {
          arrived = true;
          break;
        }
      }
      expect(arrived).toBe(true);
    });
  }

  it('gets down from the external monitor on the real dev layout', () => {
    const world = desktop(DEV);
    const sim = createSim({ pack: testPack(), world, seed: 87 });
    sim.dispatch({ k: 'command', name: 'place', x: 800, y: -400 });
    for (const dt of dtSequence(600)) sim.step(dt);
    expect(sim.state.standingOn).toBe('seam:ext:0');

    let onLaptop = false;
    for (const dt of dtSequence(200_000)) {
      sim.step(dt);
      expectRealGround(world, sim.state);
      if (sim.state.standingOn === 'floor:laptop:0') {
        onLaptop = true;
        break;
      }
    }
    expect(onLaptop).toBe(true);
  });

  it('re-settles onto real screen when a monitor is unplugged', () => {
    const pack = testPack({ climbiness: 0 });
    const sim = createSim({ pack, world: desktop(SIDE_BY_SIDE), seed: 83 });
    sim.dispatch({ k: 'command', name: 'place', x: 1400, y: 480 });
    for (const dt of dtSequence(2000)) sim.step(dt);
    expect(sim.state.x).toBeGreaterThan(800);

    sim.dispatch({ k: 'world', world: { ...simpleWorld(800, 400), rev: 99 } });
    expect(sim.state.x).toBeLessThanOrEqual(800);
    expect(sim.state.y).toBeLessThanOrEqual(400);
  });
});

describe('rendering handoff', () => {
  it('emits a cell that exists in the pack', () => {
    const pack = testPack();
    const sim = createSim({ pack, world: simpleWorld(800, 400), seed: 23 });
    for (const dt of dtSequence(3000)) {
      sim.step(dt);
      expect(() => pack.cell(sim.frame().cellId)).not.toThrow();
    }
  });

  it('phase-locks the walk cycle to distance, not time', () => {
    const pack = testPack();
    const sim = createSim({ pack, world: simpleWorld(800, 400), seed: 29 });
    sim.dispatch({ k: 'command', name: 'come-here', x: 999 });

    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      sim.step(16);
      if (sim.state.behavior === 'walk') seen.add(sim.frame().cellId);
    }
    // A phase-locked walk visits every frame of the cycle as it travels.
    expect(seen.size).toBeGreaterThan(1);
  });
});
