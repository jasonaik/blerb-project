import { describe, expect, it } from 'vitest';
import { resolvePack } from '@blerb/pack';
import { createSim, simpleWorld } from './sim.js';
import type { PetState } from './types.js';

const testPack = () =>
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
