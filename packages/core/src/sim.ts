import { frameAt, type ResolvedPack } from '@blerb/pack';
import { chance, rand, randRange, seedFrom, weightedPick } from './rng.js';
import type {
  BehaviorId,
  PetEvent,
  PetSnapshot,
  PetState,
  Platform,
  RenderFrame,
  World,
} from './types.js';

/**
 * The pet's brain.
 *
 * Deterministic by construction: given (seed, dt sequence, world, events) it
 * produces byte-identical state every time. No clock, no Math.random, no DOM.
 * That is what makes it snapshot-testable and what will make a "the pet did
 * something weird" bug reproducible instead of folklore.
 */

/** Sim substep. Fixed so physics never depends on frame rate. */
const FIXED_DT_MS = 1000 / 60;

/**
 * Longest gap we will simulate in one call. Past this we stop integrating and
 * emit nothing — a laptop that slept for three hours should not produce a pet
 * that has "walked" 40km and teleported to a corner.
 */
const MAX_STEP_MS = 250;

/** Design contract rule 4: stationary >=70% of wall-clock. */
const MOTION_BUDGET = 0.3;

/** EMA time constant for motionEma, ms. ~30s of memory. */
const MOTION_TAU_MS = 30_000;

/** Movement bouts <=4s, also rule 4. */
const BEHAVIOR_DURATION_MS: Record<BehaviorId, readonly [number, number]> = {
  idle: [1500, 4500],
  walk: [900, 4000],
  sit: [3000, 10_000],
  sleep: [12_000, 30_000],
  stretch: [1200, 2000],
  // Transient states; duration is decided by physics/animation, not the picker.
  fall: [0, 0],
  land: [180, 180],
};

/** Behaviors the picker may choose. `fall`/`land` are physics-driven only. */
const PICKABLE: readonly BehaviorId[] = ['idle', 'walk', 'sit', 'sleep', 'stretch'];

/**
 * Reserved platform id for "resting on the bottom of the world with no real
 * platform underneath".
 *
 * This exists because `standingOn === null` must mean exactly one thing —
 * airborne. Overloading null to also mean "on the floor" produces a pet that
 * lands, is immediately judged to be falling again, and loops forever without
 * ever picking a new behavior. Hosts always supply a floor platform in
 * practice, so this is a safety net rather than a normal state, but it has to
 * be a *distinguishable* state.
 */
export const WORLD_FLOOR = '__world_floor__';

export interface SimOptions {
  pack: ResolvedPack;
  world: World;
  seed?: number;
  snapshot?: PetSnapshot;
}

export interface Sim {
  readonly state: Readonly<PetState>;
  readonly world: Readonly<World>;
  step(dtMs: number): void;
  dispatch(e: PetEvent): void;
  frame(): RenderFrame;
  serialize(): PetSnapshot;
}

export function createSim(opts: SimOptions): Sim {
  const { pack } = opts;
  let world = opts.world;
  let simTime = 0;
  let accumulator = 0;

  const seed = opts.snapshot?.rng ?? opts.seed ?? seedFrom(pack.id);

  const state: PetState = {
    x: opts.snapshot?.x ?? world.bounds.x + world.bounds.w / 2,
    y: opts.snapshot?.y ?? world.bounds.y + world.bounds.h,
    vx: 0,
    vy: 0,
    facing: opts.snapshot?.facing ?? 1,
    standingOn: null,
    behavior: opts.snapshot?.behavior ?? 'idle',
    behaviorT: 0,
    behaviorDur: 1500,
    anim: opts.snapshot?.behavior ?? 'idle',
    animT: 0,
    odometer: 0,
    motionEma: 0,
    rng: seed >>> 0,
    hidden: false,
    worldRev: world.rev,
  };

  // Put the pet on the ground it is actually standing on, rather than waiting
  // for it to fall there — a pet that drops in from nowhere on every launch
  // reads as a bug.
  settleOntoGround();

  function platformById(id: string | null): Platform | undefined {
    if (id === null) return undefined;
    return world.platforms.find((p) => p.id === id);
  }

  /** Highest platform at or below `y` that spans `x`. */
  function platformUnder(x: number, y: number): Platform | undefined {
    let best: Platform | undefined;
    for (const p of world.platforms) {
      if (x < p.x0 || x > p.x1) continue;
      if (p.y < y - 0.5) continue;
      if (best === undefined || p.y < best.y) best = p;
    }
    return best;
  }

  /** Lowest platform spanning `x`, regardless of the pet's current height. */
  function lowestPlatformAt(x: number): Platform | undefined {
    let best: Platform | undefined;
    for (const p of world.platforms) {
      if (x < p.x0 || x > p.x1) continue;
      if (best === undefined || p.y > best.y) best = p;
    }
    return best;
  }

  function settleOntoGround(): void {
    const b = world.bounds;
    state.x = Math.min(Math.max(state.x, b.x), b.x + b.w);
    state.y = Math.min(Math.max(state.y, b.y), b.y + b.h);

    // Prefer the nearest ground below. Failing that — which happens when the
    // pet starts *below* every platform, e.g. spawned at the window bottom
    // while the floor sits a few px higher — pull it up to the lowest one
    // rather than declaring it airborne underneath the world.
    const p = platformUnder(state.x, state.y) ?? lowestPlatformAt(state.x);
    if (p) {
      state.y = p.y;
      state.standingOn = p.id;
    } else {
      state.y = b.y + b.h;
      state.standingOn = WORLD_FLOOR;
    }
    state.vy = 0;
  }

  function setBehavior(next: BehaviorId): void {
    state.behavior = next;
    state.anim = next;
    state.behaviorT = 0;
    state.animT = 0;

    const [lo, hi] = BEHAVIOR_DURATION_MS[next];
    // restlessness 0 -> long bouts, 1 -> short ones.
    const restless = pack.behavior.restlessness;
    const scale = 1.6 - restless;
    state.behaviorDur = randRange(state, lo, hi) * scale;

    if (next === 'walk') {
      state.vx = state.facing * pack.behavior.speed.walk;
    } else if (next !== 'fall') {
      state.vx = 0;
    }
  }

  function pickBehavior(): void {
    // Rule 4, enforced rather than aspired to: if the pet has been moving more
    // than its budget lately, walking is simply not on the menu.
    const mayWalk = state.motionEma < MOTION_BUDGET;

    const weights = PICKABLE.filter((b) => b !== 'walk' || mayWalk)
      .filter((b) => (b === 'sleep' ? pack.behavior.can.sleep : true))
      .filter((b) => (b === 'sit' ? pack.behavior.can.sit : true))
      .map((b) => [b, pack.behavior.idleWeights[b] ?? 0] as const);

    const chosen = weightedPick(state, weights) ?? 'idle';

    // Turning around while standing still reads as "deciding where to go",
    // which is much better than pivoting mid-stride.
    if (chosen === 'walk' && chance(state, 0.5)) {
      state.facing = state.facing === 1 ? -1 : 1;
    }
    setBehavior(chosen);
  }

  function startFalling(): void {
    state.standingOn = null;
    state.behavior = 'fall';
    state.anim = 'fall';
    state.behaviorT = 0;
    state.animT = 0;
  }

  function stepFixed(dtMs: number): void {
    const dt = dtMs / 1000;
    state.animT += dtMs;
    state.behaviorT += dtMs;

    if (state.standingOn === null && state.behavior !== 'fall') {
      startFalling();
    }

    if (state.behavior === 'fall') {
      const prevY = state.y;
      state.vy += world.gravity * dt;
      state.y += state.vy * dt;
      state.x += state.vx * dt;

      // Land on the first platform whose surface we crossed on the way down.
      if (state.vy > 0) {
        let target: Platform | undefined;
        for (const p of world.platforms) {
          if (state.x < p.x0 || state.x > p.x1) continue;
          if (prevY <= p.y && state.y >= p.y) {
            if (target === undefined || p.y < target.y) target = p;
          }
        }
        const floorY = world.bounds.y + world.bounds.h;
        if (target) {
          state.y = target.y;
          state.standingOn = target.id;
          state.vy = 0;
          state.vx = 0;
          setBehavior('land');
        } else if (state.y >= floorY) {
          state.y = floorY;
          state.vy = 0;
          state.vx = 0;
          state.standingOn = WORLD_FLOOR;
          setBehavior('land');
        }
      }
    } else if (state.behavior === 'walk') {
      const platform = platformById(state.standingOn);
      const speed = pack.behavior.speed.walk;
      state.vx = state.facing * speed;

      const nextX = state.x + state.vx * dt;
      const worldMin = world.bounds.x;
      const worldMax = world.bounds.x + world.bounds.w;

      // The world edge is a hard wall — always turn, never leave.
      if (nextX <= worldMin || nextX >= worldMax) {
        state.facing = state.facing === 1 ? -1 : 1;
        state.vx = state.facing * speed;
        state.x = Math.min(Math.max(state.x, worldMin), worldMax);
      } else if (platform && (nextX < platform.x0 || nextX > platform.x1)) {
        // A platform edge is a choice. Mostly turn around — deliberately
        // biased, because a pet that constantly falls off things looks broken
        // rather than playful.
        if (pack.behavior.can.fall && chance(state, 0.15)) {
          state.x = nextX;
          startFalling();
          return;
        }
        state.facing = state.facing === 1 ? -1 : 1;
        state.vx = state.facing * speed;
      } else {
        state.x = nextX;
        state.odometer += Math.abs(state.vx * dt);
      }
    } else {
      state.vx = 0;
    }

    // Motion budget bookkeeping.
    const moving = Math.abs(state.vx) > 0.5 || state.behavior === 'fall' ? 1 : 0;
    const alpha = 1 - Math.exp(-dtMs / MOTION_TAU_MS);
    state.motionEma += (moving - state.motionEma) * alpha;

    // Transitions out of the transient states.
    if (state.behavior === 'land' && state.behaviorT >= state.behaviorDur) {
      pickBehavior();
    } else if (
      state.behavior !== 'fall' &&
      state.behavior !== 'land' &&
      state.behaviorT >= state.behaviorDur
    ) {
      pickBehavior();
    }
  }

  function reconcileWorld(next: World): void {
    const prev = world;
    world = next;
    if (next.rev === state.worldRev) return;
    state.worldRev = next.rev;

    // Keep the pet inside the new bounds. A monitor being unplugged should
    // move the pet, not strand it at coordinates nobody can see.
    const b = next.bounds;
    state.x = Math.min(Math.max(state.x, b.x), b.x + b.w);
    state.y = Math.min(Math.max(state.y, b.y), b.y + b.h);

    const standing = platformById(state.standingOn);
    if (standing) {
      // Ride it. The window this pet is sitting on may have been dragged.
      state.y = standing.y;
      if (state.x < standing.x0 || state.x > standing.x1) startFalling();
    } else if (state.standingOn === WORLD_FLOOR) {
      // Re-settle: the viewport may have resized, or a real platform may have
      // appeared underneath in the meantime.
      settleOntoGround();
    } else if (state.standingOn !== null) {
      // The window it was standing on closed.
      startFalling();
    } else if (prev.bounds.h !== b.h || prev.bounds.y !== b.y) {
      settleOntoGround();
    }
  }

  return {
    state,
    get world() {
      return world;
    },

    step(dtMs: number): void {
      if (state.hidden) return;
      if (!Number.isFinite(dtMs) || dtMs <= 0) return;

      accumulator += Math.min(dtMs, MAX_STEP_MS);
      // Bound the catch-up work so a stalled frame can't spiral.
      let guard = 0;
      while (accumulator >= FIXED_DT_MS && guard++ < 32) {
        stepFixed(FIXED_DT_MS);
        accumulator -= FIXED_DT_MS;
        simTime += FIXED_DT_MS;
      }
      if (guard >= 32) accumulator = 0;
    },

    dispatch(e: PetEvent): void {
      switch (e.k) {
        case 'world':
          reconcileWorld(e.world);
          break;

        case 'hide':
          state.hidden = true;
          break;

        case 'show':
          state.hidden = false;
          break;

        case 'resume':
          // Deliberately do not fast-forward. Re-settle and start fresh, so
          // returning to the machine shows a pet where you left it rather than
          // one that has visibly "lived" through the gap.
          accumulator = 0;
          settleOntoGround();
          setBehavior('idle');
          break;

        case 'command':
          if (e.name === 'recenter') {
            state.x = world.bounds.x + world.bounds.w / 2;
            settleOntoGround();
            setBehavior('idle');
          } else if (e.name === 'come-here' && e.x !== undefined) {
            state.facing = e.x < state.x ? -1 : 1;
            setBehavior('walk');
          } else if (e.name === 'sleep') {
            setBehavior('sleep');
          } else if (e.name === 'wake') {
            setBehavior('idle');
          } else if (e.name === 'place' && e.x !== undefined && e.y !== undefined) {
            // Drag-and-drop: the host puts the pet's feet at a point and lets
            // physics take over. This is how the pet gets ON TOP of a window,
            // since it can't jump — the user lifts it there.
            const b = world.bounds;
            state.x = Math.min(Math.max(e.x, b.x), b.x + b.w);
            state.y = Math.min(Math.max(e.y, b.y), b.y + b.h);
            state.vx = 0;
            state.vy = 0;
            startFalling();
          }
          break;

        case 'pointer':
          // Shyness (rule 3 — the pet yields) lands with the game layer.
          break;
      }
    },

    frame(): RenderFrame {
      const anim = pack.animation(state.anim);

      // Phase-lock the walk cycle to distance travelled, not to wall time, so
      // the feet don't skate when speed changes. Falls back to time for
      // animations that never declared a design speed.
      const phaseMs =
        state.behavior === 'walk' && anim.designSpeed
          ? (state.odometer / anim.designSpeed) * 1000
          : state.animT;

      return {
        t: simTime,
        cellId: frameAt(anim, phaseMs),
        x: state.x,
        y: state.y,
        facing: pack.facing === 'none' ? 1 : state.facing,
        scale: 1,
        opacity: state.hidden ? 0 : 1,
        rotation: 0,
        squash: { sx: 1, sy: 1 },
        effects: [],
      };
    },

    serialize(): PetSnapshot {
      return {
        x: state.x,
        y: state.y,
        facing: state.facing,
        behavior: state.behavior,
        rng: state.rng,
      };
    },
  };
}

/**
 * Convenience for hosts: a world that is just a rectangle with a floor.
 * The Electron app replaces the platform list with real window edges; the
 * preview page and most tests only ever need this.
 */
export function simpleWorld(w: number, h: number, rev = 1): World {
  return {
    rev,
    bounds: { x: 0, y: 0, w, h },
    platforms: [{ id: 'floor', x0: 0, x1: w, y: h, kind: 'floor', passthrough: false }],
    gravity: 900,
    reducedMotion: false,
  };
}

export { rand, randRange, chance, seedFrom, weightedPick };
