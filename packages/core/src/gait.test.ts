import { describe, expect, it } from 'vitest';
import { resolvePack } from '@blerb/pack';
import { deriveFrame } from './sim.js';
import type { PetState } from './types.js';

/**
 * The procedural gait is pure deformation of a derived frame. These tests pin
 * the properties that make it read as WEIGHT rather than as a stretched
 * picture — and that keep it deterministic, like everything else in the sim.
 */

const STRIDE = 20;

const pack = resolvePack({
  format: 'blerb-pet/1',
  id: 'rigged',
  name: 'Rigged',
  atlas: { src: 'atlas.png' },
  grid: { w: 32, h: 32, cols: 1 },
  animations: { idle: { frames: [0], fps: 1 } },
  rig: {
    type: 'procedural',
    gaits: { walk: { strideLength: STRIDE } },
  },
});

function state(over: Partial<PetState>): PetState {
  return {
    x: 100,
    y: 100,
    vx: 0,
    vy: 0,
    facing: 1,
    standingOn: 'floor:0',
    climbingOn: null,
    climbSide: 1,
    climbDir: -1,
    hangingOn: null,
    behavior: 'idle',
    // Past the ease-in window, so tests see full deformation unless a test
    // is specifically about the ramp.
    behaviorT: 500,
    behaviorDur: 1000,
    anim: 'idle',
    animT: 0,
    simT: 0,
    odometer: 0,
    motionEma: 0,
    rng: 1,
    hidden: false,
    worldRev: 0,
    ...over,
  };
}

describe('applyGait via deriveFrame', () => {
  it('is deterministic: same state, same frame, always', () => {
    const s = state({ behavior: 'walk', odometer: 13.7, simT: 4321 });
    expect(deriveFrame(pack, s)).toEqual(deriveFrame(pack, s));
  });

  it('preserves volume: sx * sy === 1 through the whole stride', () => {
    for (let d = 0; d <= STRIDE * 2; d += 0.5) {
      const f = deriveFrame(pack, state({ behavior: 'walk', odometer: d }));
      expect(f.squash.sx * f.squash.sy).toBeCloseTo(1, 10);
    }
  });

  it('keeps the feet planted at contact and lifts mid-stride', () => {
    // theta = 0 (contact): no bob. theta = pi/2 (apex): max lift.
    const contact = deriveFrame(pack, state({ behavior: 'walk', odometer: 0 }));
    const apex = deriveFrame(pack, state({ behavior: 'walk', odometer: STRIDE / 4 }));
    expect(contact.y).toBe(100);
    expect(apex.y).toBeLessThan(100);
  });

  it('squashes AT CONTACT and stretches at the apex — weight, not a trampoline', () => {
    // The first cut had this inverted (tallest at footfall). Squash-and-
    // stretch reads as impact only if the compression lands with the feet.
    const contact = deriveFrame(pack, state({ behavior: 'walk', odometer: 0 }));
    const apex = deriveFrame(pack, state({ behavior: 'walk', odometer: STRIDE / 4 }));
    expect(contact.squash.sy).toBeLessThan(1);
    expect(apex.squash.sy).toBeGreaterThan(1);
  });

  it('eases in over the first 150ms of a behavior instead of teleporting the pose', () => {
    const early = deriveFrame(pack, state({ behavior: 'walk', odometer: STRIDE / 4, behaviorT: 0 }));
    const half = deriveFrame(pack, state({ behavior: 'walk', odometer: STRIDE / 4, behaviorT: 75 }));
    const full = deriveFrame(pack, state({ behavior: 'walk', odometer: STRIDE / 4, behaviorT: 500 }));
    expect(early.y).toBe(100); // neutral at the transition instant
    expect(early.squash.sy).toBeCloseTo(1, 5);
    expect(100 - half.y).toBeCloseTo((100 - full.y) / 2, 5);
  });

  it('scales the bob with the host pet-size setting', () => {
    const s = state({ behavior: 'walk', odometer: STRIDE / 4 });
    const at1 = deriveFrame(pack, s, 1);
    const at2 = deriveFrame(pack, s, 2);
    expect(100 - at2.y).toBeCloseTo((100 - at1.y) * 2, 8);
    // Squash and lean are relative and must NOT change with pet size.
    expect(at2.squash).toEqual(at1.squash);
    expect(at2.rotation).toBe(at1.rotation);
  });

  it('phase comes from distance, not time — stopping freezes the pose', () => {
    const a = deriveFrame(pack, state({ behavior: 'walk', odometer: 7, simT: 1000 }));
    const b = deriveFrame(pack, state({ behavior: 'walk', odometer: 7, simT: 9000 }));
    expect(b.y).toBe(a.y);
    expect(b.squash).toEqual(a.squash);
  });

  it('leans into the direction of travel', () => {
    const right = deriveFrame(pack, state({ behavior: 'walk', odometer: 3, facing: 1 }));
    const left = deriveFrame(pack, state({ behavior: 'walk', odometer: 3, facing: -1 }));
    expect(right.rotation).toBeGreaterThan(0);
    expect(left.rotation).toBeLessThan(0);
  });

  it('breathes while idle, on simT', () => {
    // breatheHz 0.35 → period ~2857ms. Quarter period from a zero crossing
    // gives max stretch.
    const rest = deriveFrame(pack, state({ simT: 0 }));
    const inhale = deriveFrame(pack, state({ simT: 714 }));
    expect(rest.squash.sy).toBeCloseTo(1, 5);
    expect(inhale.squash.sy).toBeGreaterThan(1);
  });

  it('sleep breathing is slower and deeper than idle breathing', () => {
    // Compare peak amplitude over a sampled cycle.
    const peak = (behavior: 'idle' | 'sleep') => {
      let m = 0;
      for (let t = 0; t < 10_000; t += 50) {
        const f = deriveFrame(pack, state({ behavior, anim: behavior, simT: t }));
        m = Math.max(m, Math.abs(f.squash.sy - 1));
      }
      return m;
    };
    expect(peak('sleep')).toBeGreaterThan(peak('idle') * 1.5);
  });

  it('squashes on landing, then RAMPS back up instead of stepping', () => {
    const impact = deriveFrame(pack, state({ behavior: 'land', behaviorT: 30 }));
    const rising = deriveFrame(pack, state({ behavior: 'land', behaviorT: 90 }));
    const done = deriveFrame(pack, state({ behavior: 'land', behaviorT: 200 }));
    expect(impact.squash.sy).toBe(0.75);
    expect(rising.squash.sy).toBeCloseTo(0.875, 5); // halfway up the ramp
    expect(done.squash.sy).toBeCloseTo(1, 3);
  });

  it('never emits a non-positive or non-finite scale, even at the schema maxima', () => {
    const extreme = resolvePack({
      format: 'blerb-pet/1',
      id: 'extreme',
      name: 'Extreme',
      atlas: { src: 'atlas.png' },
      grid: { w: 32, h: 32, cols: 1 },
      animations: { idle: { frames: [0], fps: 1 } },
      rig: {
        type: 'procedural',
        gaits: { walk: { squash: 0.5 }, sleep: { breatheAmp: 0.2 }, idle: { breatheAmp: 0.2 } },
      },
    });
    for (let d = 0; d < 60; d += 1) {
      const f = deriveFrame(extreme, state({ behavior: 'walk', odometer: d }));
      expect(f.squash.sy).toBeGreaterThan(0);
      expect(Number.isFinite(f.squash.sx)).toBe(true);
    }
    for (let t = 0; t < 8000; t += 100) {
      const f = deriveFrame(extreme, state({ behavior: 'sleep', anim: 'sleep', simT: t }));
      expect(f.squash.sy).toBeGreaterThan(0);
      expect(Number.isFinite(f.squash.sx)).toBe(true);
    }
    // And the schema refuses amplitudes that could reach zero at all.
    expect(() =>
      resolvePack({
        format: 'blerb-pet/1',
        id: 'x',
        name: 'X',
        atlas: { src: 'atlas.png' },
        grid: { w: 32, h: 32, cols: 1 },
        animations: { idle: { frames: [0] } },
        rig: { type: 'procedural', gaits: { walk: { squash: 1 } } },
      }),
    ).toThrow();
  });

  it('a rig with an empty gaits record walks on the schema defaults', () => {
    // resolvePack synthesizes the walk entry from the schema itself, so core
    // carries no hand-copied default table that could drift from a retune.
    const bare = resolvePack({
      format: 'blerb-pet/1',
      id: 'bare',
      name: 'Bare',
      atlas: { src: 'atlas.png' },
      grid: { w: 32, h: 32, cols: 1 },
      animations: { idle: { frames: [0], fps: 1 } },
      rig: { type: 'procedural', gaits: {} },
    });
    // Default stride is 22: quarter-stride is the bob apex.
    const apex = deriveFrame(bare, state({ behavior: 'walk', odometer: 22 / 4 }));
    expect(apex.y).toBeLessThan(100);
  });

  it('a walk-less rig does not borrow another gait for walking', () => {
    const mk = (gaits: Record<string, { strideLength?: number }>) =>
      resolvePack({
        format: 'blerb-pet/1',
        id: 'w',
        name: 'W',
        atlas: { src: 'atlas.png' },
        grid: { w: 32, h: 32, cols: 1 },
        animations: { idle: { frames: [0], fps: 1 } },
        rig: { type: 'procedural', gaits },
      });
    // sleep declared first must not become the walk gait by insertion order.
    const a = mk({ sleep: { strideLength: 90 } });
    const b = mk({ idle: { strideLength: 90 } });
    const fa = deriveFrame(a, state({ behavior: 'walk', odometer: 22 / 4 }));
    const fb = deriveFrame(b, state({ behavior: 'walk', odometer: 22 / 4 }));
    expect(fa.y).toEqual(fb.y); // both use the synthesized default walk (stride 22)
    expect(fa.y).toBeLessThan(100);
  });

  it('never applies the walk deformation while attached to a wall', () => {
    const f = deriveFrame(
      pack,
      state({ behavior: 'climb', anim: 'climb', climbingOn: 'w:0', standingOn: null, odometer: 5 }),
    );
    // Rotated a quarter turn by the climb, breathing at most — no bob, no lean
    // on top of the climb rotation beyond breathing's none.
    expect(f.y).toBe(100);
    expect(f.rotation).toBeCloseTo(Math.PI / 2, 10);
  });

  it('bobs by DISPLAYED height: hi-res art with atlas.scale moves like small art', () => {
    const hires = resolvePack({
      format: 'blerb-pet/1',
      id: 'hires',
      name: 'HiRes',
      atlas: { src: 'atlas.png', scale: 4 }, // 128px cell drawn at 32px
      grid: { w: 128, h: 128, cols: 1 },
      animations: { idle: { frames: [0], fps: 1 } },
      rig: { type: 'procedural', gaits: { walk: { strideLength: STRIDE } } },
    });
    const apexSmall = deriveFrame(pack, state({ behavior: 'walk', odometer: STRIDE / 4 }));
    const apexBig = deriveFrame(hires, state({ behavior: 'walk', odometer: STRIDE / 4 }));
    // 128/4 = 32 displayed = the small pack's cell height: identical bob.
    expect(apexBig.y).toBeCloseTo(apexSmall.y, 10);
  });

  it('does nothing to a pack without a rig', () => {
    const plain = resolvePack({
      format: 'blerb-pet/1',
      id: 'plain',
      name: 'Plain',
      atlas: { src: 'atlas.png' },
      grid: { w: 32, h: 32, cols: 1 },
      animations: { idle: { frames: [0], fps: 1 } },
    });
    const f = deriveFrame(plain, state({ behavior: 'walk', odometer: 7 }));
    expect(f.squash).toEqual({ sx: 1, sy: 1 });
    expect(f.y).toBe(100);
  });
});
