import { frameAt, type ResolvedPack } from '@blerb/pack';
import { chance, rand, randRange, seedFrom, weightedPick } from './rng.js';
import { EPS, regionAt } from './geom.js';
import type {
  BehaviorId,
  PetEvent,
  PetSnapshot,
  PetState,
  Platform,
  RenderFrame,
  Wall,
  World,
} from './types.js';

/**
 * The pet's brain.
 *
 * Deterministic by construction: given (seed, dt sequence, world, events) it
 * produces byte-identical state every time. No clock, no Math.random, no DOM.
 *
 * Coordinates are GLOBAL — on a multi-monitor desktop the sim works in one
 * space spanning every screen, and hosts translate to their own window when
 * drawing. The sim does not know what a monitor is; it knows `regions`.
 */

/** Sim substep. Fixed so physics never depends on frame rate. */
const FIXED_DT_MS = 1000 / 60;

/**
 * Longest gap we will simulate in one call. Past this we stop integrating —
 * a laptop that slept for three hours should not produce a pet that has
 * "walked" 40km and teleported to a corner.
 */
const MAX_STEP_MS = 250;

/** Design contract rule 4: stationary >=70% of wall-clock. */
const MOTION_BUDGET = 0.3;

/**
 * How near a wall a hand-placed pet has to land to grab it, in world px.
 * Also the minimum drop below the cursor before a wall beats the ground.
 */
const WALL_GRAB = 24;

/** EMA time constant for motionEma, ms. ~30s of memory. */
const MOTION_TAU_MS = 30_000;

/** Movement bouts <=4s, also rule 4. */
const BEHAVIOR_DURATION_MS: Record<BehaviorId, readonly [number, number]> = {
  idle: [1500, 4500],
  walk: [900, 4000],
  sit: [3000, 10_000],
  sleep: [12_000, 30_000],
  stretch: [1200, 2000],
  climb: [1500, 5000],
  cling: [800, 2600],
  // Transient states; duration is decided by physics, not the picker.
  fall: [0, 0],
  land: [180, 180],
};

/** Behaviors the picker may choose on the ground. */
const PICKABLE: readonly BehaviorId[] = ['idle', 'walk', 'sit', 'sleep', 'stretch'];

/**
 * Reserved platform id for "resting on the bottom of a region with no real
 * platform underneath".
 *
 * `standingOn === null` must mean exactly one thing — not on the ground.
 * Overloading null to also mean "on the floor" produces a pet that lands, is
 * immediately judged to be falling again, and loops forever.
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

/**
 * Turn a PetState into a RenderFrame without a Sim instance.
 *
 * This is what lets the simulation live in one process and the drawing happen
 * in several — each overlay window derives its own frame from the broadcast
 * state, so a RenderFrame still never crosses a process boundary.
 */
export function deriveFrame(pack: ResolvedPack, s: PetState): RenderFrame {
  const anim = pack.animation(s.anim);

  // Phase-lock the walk cycle to distance travelled, not wall time, so the
  // feet don't skate when speed changes.
  const phaseMs =
    (s.behavior === 'walk' || s.behavior === 'climb') && anim.designSpeed
      ? (s.odometer / anim.designSpeed) * 1000
      : s.animT;

  // On a wall the sprite rotates so its feet meet the surface. `side` is the
  // direction from wall to pet, so +1 (wall on the pet's left) rotates "down"
  // into "left".
  const rotation = s.climbingOn !== null ? (s.climbSide * Math.PI) / 2 : 0;

  return {
    t: s.simT,
    cellId: frameAt(anim, phaseMs),
    x: s.x,
    y: s.y,
    facing: pack.facing === 'none' ? 1 : s.facing,
    scale: 1,
    opacity: s.hidden ? 0 : 1,
    rotation,
    squash: { sx: 1, sy: 1 },
    effects: [],
  };
}

export function createSim(opts: SimOptions): Sim {
  const { pack } = opts;
  let world = opts.world;
  let accumulator = 0;

  const seed = opts.snapshot?.rng ?? opts.seed ?? seedFrom(pack.id);
  const start = firstRegion(world);

  const state: PetState = {
    x: opts.snapshot?.x ?? start.x + start.w / 2,
    y: opts.snapshot?.y ?? start.y + start.h,
    vx: 0,
    vy: 0,
    facing: opts.snapshot?.facing ?? 1,
    standingOn: null,
    climbingOn: null,
    climbSide: 1,
    climbDir: -1,
    behavior: opts.snapshot?.behavior ?? 'idle',
    behaviorT: 0,
    behaviorDur: 1500,
    anim: opts.snapshot?.behavior ?? 'idle',
    animT: 0,
    simT: 0,
    odometer: 0,
    motionEma: 0,
    rng: seed >>> 0,
    hidden: false,
    worldRev: world.rev,
  };

  settleOntoGround();

  function firstRegion(w: World) {
    return w.regions[0] ?? w.bounds;
  }

  function platformById(id: string | null): Platform | undefined {
    if (id === null) return undefined;
    return world.platforms.find((p) => p.id === id);
  }

  function wallById(id: string | null): Wall | undefined {
    if (id === null) return undefined;
    return world.walls.find((w) => w.id === id);
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

  /** Lowest platform spanning `x`, regardless of the pet's height. */
  function lowestPlatformAt(x: number): Platform | undefined {
    let best: Platform | undefined;
    for (const p of world.platforms) {
      if (x < p.x0 || x > p.x1) continue;
      if (best === undefined || p.y > best.y) best = p;
    }
    return best;
  }

  function settleOntoGround(): void {
    state.climbingOn = null;

    // Pull the pet onto real screen first. On a multi-monitor desktop the
    // union bounds contain dead space, so clamping to bounds is not enough.
    if (!regionAt(world.regions, state.x, state.y)) {
      const r = nearestRegion(state.x, state.y);
      state.x = Math.min(Math.max(state.x, r.x), r.x + r.w);
      state.y = Math.min(Math.max(state.y, r.y), r.y + r.h);
    }

    const p = platformUnder(state.x, state.y) ?? lowestPlatformAt(state.x);
    if (p) {
      state.y = p.y;
      state.standingOn = p.id;
    } else {
      const r = regionAt(world.regions, state.x, state.y) ?? firstRegion(world);
      state.y = r.y + r.h;
      state.standingOn = WORLD_FLOOR;
    }
    state.vy = 0;
    state.vx = 0;
  }

  function nearestRegion(x: number, y: number) {
    let best = firstRegion(world);
    let bestD = Infinity;
    for (const r of world.regions) {
      const dx = Math.max(r.x - x, 0, x - (r.x + r.w));
      const dy = Math.max(r.y - y, 0, y - (r.y + r.h));
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    return best;
  }

  function setBehavior(next: BehaviorId): void {
    state.behavior = next;
    state.anim = next;
    state.behaviorT = 0;
    state.animT = 0;

    const [lo, hi] = BEHAVIOR_DURATION_MS[next];
    const scale = 1.6 - pack.behavior.restlessness;
    state.behaviorDur = randRange(state, lo, hi) * scale;

    if (next === 'walk') state.vx = state.facing * pack.behavior.speed.walk;
    else if (next !== 'fall') state.vx = 0;
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

    // Turning while stationary reads as "deciding where to go", which is much
    // better than pivoting mid-stride.
    if (chosen === 'walk' && chance(state, 0.5)) {
      state.facing = state.facing === 1 ? -1 : 1;
    }
    setBehavior(chosen);
  }

  function startFalling(): void {
    state.standingOn = null;
    state.climbingOn = null;
    state.behavior = 'fall';
    state.anim = 'fall';
    state.behaviorT = 0;
    state.animT = 0;
  }

  function attachToWall(w: Wall, dir: -1 | 1): void {
    state.climbingOn = w.id;
    state.climbSide = w.side;
    state.climbDir = dir;
    state.standingOn = null;
    state.x = w.x;
    state.y = Math.min(Math.max(state.y, w.y0), w.y1);
    state.vx = 0;
    state.vy = 0;
    // Face along the direction of travel. The 90 degree rotation in
    // deriveFrame puts the feet against the surface, and `side` decides which
    // way round that rotation goes — so which mirror means "head up" flips
    // with it. `side * dir` is the product that keeps the pet climbing head
    // first on both edges of the desktop; `-dir` is right only on the right.
    state.facing = (w.side * dir) as -1 | 1;
  }

  function startClimb(w: Wall, dir: -1 | 1): void {
    attachToWall(w, dir);
    setBehavior('climb');
  }

  /**
   * The nearest wall the pet could grab from a point, if any.
   *
   * Used when the user drops the pet by hand. The radius is generous on
   * purpose — placing a pet on a 1px line with a mouse is not a game anyone
   * wants to play.
   */
  function wallNear(x: number, y: number): Wall | undefined {
    let best: Wall | undefined;
    let bestD = WALL_GRAB;
    for (const w of world.walls) {
      if (y < w.y0 - EPS || y > w.y1 + EPS) continue;
      const d = Math.abs(w.x - x);
      if (d <= bestD) {
        bestD = d;
        best = w;
      }
    }
    return best;
  }

  /** How far below a point the ground is, or Infinity if there is none. */
  function dropHeight(x: number, y: number): number {
    const p = platformUnder(x, y);
    if (p) return p.y - y;
    const r = regionAt(world.regions, x, y);
    return r ? r.y + r.h - y : Infinity;
  }

  /** A wall the pet would cross moving from `x` to `nextX` at height `y`. */
  function wallAhead(x: number, nextX: number, y: number): Wall | undefined {
    const dir = Math.sign(nextX - x);
    if (dir === 0) return undefined;
    for (const w of world.walls) {
      if (y < w.y0 - EPS || y > w.y1 + EPS) continue;
      // side === -1: pet is left of the wall, so it blocks rightward travel.
      if (dir > 0 && w.side === -1 && w.x >= x - EPS && w.x <= nextX + EPS) return w;
      if (dir < 0 && w.side === 1 && w.x <= x + EPS && w.x >= nextX - EPS) return w;
    }
    return undefined;
  }

  /**
   * A platform just above the top of `w` that the pet can haul itself onto.
   *
   * Two monitors rarely line up exactly: a screen sitting above and to the
   * side leaves its floor a short hop above the neighbouring screen's top
   * corner. Without this the pet climbs to the lip and is stuck there.
   */
  function mantleTarget(w: Wall): Platform | undefined {
    const MANTLE = 96;
    let best: Platform | undefined;
    for (const p of world.platforms) {
      if (w.x < p.x0 - EPS || w.x > p.x1 + EPS) continue;
      if (p.y > w.y0 + EPS || p.y < w.y0 - MANTLE) continue;
      if (best === undefined || p.y > best.y) best = p; // closest above the lip
    }
    return best;
  }

  /** A wall continuing from `w` in vertical direction `dir` (-1 up, +1 down). */
  function connectingWall(w: Wall, dir: -1 | 1): Wall | undefined {
    for (const o of world.walls) {
      if (o.id === w.id || o.side !== w.side) continue;
      if (Math.abs(o.x - w.x) > 2) continue;
      if (dir === -1 && Math.abs(o.y1 - w.y0) <= 4) return o;
      if (dir === 1 && Math.abs(o.y0 - w.y1) <= 4) return o;
    }
    return undefined;
  }

  function stepFixed(dtMs: number): void {
    const dt = dtMs / 1000;
    state.simT += dtMs;
    state.animT += dtMs;
    state.behaviorT += dtMs;

    const climbing = state.behavior === 'climb' || state.behavior === 'cling';

    if (!climbing && state.standingOn === null && state.behavior !== 'fall') {
      startFalling();
    }

    if (state.behavior === 'fall') {
      stepFall(dt);
    } else if (state.behavior === 'climb') {
      stepClimb(dt);
    } else if (state.behavior === 'cling') {
      stepCling();
    } else if (state.behavior === 'walk') {
      stepWalk(dt);
    } else {
      state.vx = 0;
    }

    // Motion budget bookkeeping.
    const moving =
      Math.abs(state.vx) > 0.5 || state.behavior === 'fall' || state.behavior === 'climb' ? 1 : 0;
    const alpha = 1 - Math.exp(-dtMs / MOTION_TAU_MS);
    state.motionEma += (moving - state.motionEma) * alpha;

    // Transitions out of the timed states.
    if (
      state.behavior !== 'fall' &&
      state.behavior !== 'climb' &&
      state.behavior !== 'cling' &&
      state.behaviorT >= state.behaviorDur
    ) {
      pickBehavior();
    }
  }

  function stepFall(dt: number): void {
    const prevY = state.y;
    state.vy += world.gravity * dt;
    state.y += state.vy * dt;
    state.x += state.vx * dt;

    if (state.vy <= 0) return;

    // Land on the first platform whose surface we crossed on the way down.
    let target: Platform | undefined;
    for (const p of world.platforms) {
      if (state.x < p.x0 || state.x > p.x1) continue;
      if (prevY <= p.y && state.y >= p.y) {
        if (target === undefined || p.y < target.y) target = p;
      }
    }
    if (target) {
      state.y = target.y;
      state.standingOn = target.id;
      state.vy = 0;
      state.vx = 0;
      setBehavior('land');
      return;
    }

    // No platform: stop at the bottom of whatever region we're falling
    // through. Zero slop deliberately — a pet that has just walked off the
    // edge of a screen is a fraction of a pixel into its neighbour, and the
    // standing tolerance would hand back the screen it just left, stopping it
    // dead on that screen's floor line in mid-air above the next one.
    const r = regionAt(world.regions, state.x, state.y, 0) ?? nearestRegion(state.x, state.y);
    const floorY = r.y + r.h;
    if (state.y >= floorY) {
      state.y = floorY;
      state.vy = 0;
      state.vx = 0;
      state.standingOn = WORLD_FLOOR;
      setBehavior('land');
    }
  }

  function stepClimb(dt: number): void {
    const w = wallById(state.climbingOn);
    if (!w) return startFalling(); // the screen it was clinging to went away

    state.y += state.climbDir * pack.behavior.speed.climb * dt;
    state.odometer += pack.behavior.speed.climb * dt;
    state.x = w.x;

    if (state.climbDir === -1 && state.y <= w.y0) {
      const up = connectingWall(w, -1);
      if (up) {
        // Contiguous wall on the screen above — keep going, which is how the
        // pet gets from one monitor to another when their edges line up.
        state.climbingOn = up.id;
        state.y = up.y1;
        return;
      }

      // Mantle: pull up over the lip onto a ledge just above the wall's top.
      // This is what gets the pet from a lower screen onto a higher one whose
      // edges *don't* line up — it climbs to the corner and hauls itself onto
      // the floor of the screen above.
      const ledge = mantleTarget(w);
      if (ledge) {
        state.climbingOn = null;
        state.standingOn = ledge.id;
        state.x = Math.min(Math.max(w.x, ledge.x0 + 1), ledge.x1 - 1);
        state.y = ledge.y;
        setBehavior('land');
        return;
      }

      state.y = w.y0;
      setBehavior('cling');
    } else if (state.climbDir === 1 && state.y >= w.y1) {
      const down = connectingWall(w, 1);
      if (down) {
        state.climbingOn = down.id;
        state.y = down.y0;
        return;
      }
      state.y = w.y1;
      // Reached the bottom of the wall: step off onto the ground if there is
      // any, otherwise cling.
      const p = platformUnder(state.x, state.y - 2);
      const r = regionAt(world.regions, state.x, state.y);
      if (p && Math.abs(p.y - state.y) < 24) {
        state.climbingOn = null;
        state.standingOn = p.id;
        state.y = p.y;
        setBehavior('land');
      } else if (r && Math.abs(r.y + r.h - state.y) < 24) {
        state.climbingOn = null;
        state.standingOn = WORLD_FLOOR;
        state.y = r.y + r.h;
        setBehavior('land');
      } else {
        setBehavior('cling');
      }
    }
  }

  function stepCling(): void {
    if (state.behaviorT < state.behaviorDur) return;
    const w = wallById(state.climbingOn);
    if (!w) return startFalling();

    // At a wall end the only way on is back the way we came; mid-wall the pet
    // may also simply let go, which is the cheapest way down and reads as
    // playful rather than broken.
    const atTop = state.y <= w.y0 + EPS;
    const atBottom = state.y >= w.y1 - EPS;

    if (pack.behavior.can.fall && chance(state, atTop ? 0.25 : 0.4)) {
      startFalling();
      return;
    }
    startClimb(w, atTop ? 1 : atBottom ? -1 : chance(state, 0.5) ? -1 : 1);
  }

  function stepWalk(dt: number): void {
    const platform = platformById(state.standingOn);
    const speed = pack.behavior.speed.walk;
    state.vx = state.facing * speed;
    const nextX = state.x + state.vx * dt;

    const turn = () => {
      state.facing = state.facing === 1 ? -1 : 1;
      state.vx = state.facing * speed;
    };

    // 1. A wall is a hard stop, and an opportunity.
    const wall = wallAhead(state.x, nextX, state.y);
    if (wall) {
      state.x = wall.x;
      if (pack.behavior.can.climb && chance(state, pack.behavior.climbiness)) {
        startClimb(wall, -1);
      } else {
        turn();
      }
      return;
    }

    // 2. Never walk off real screen. Where two monitors touch there is no
    //    wall, so this is what keeps the pet out of the dead space in an
    //    L-shaped desktop.
    if (!regionAt(world.regions, nextX, state.y)) {
      turn();
      return;
    }

    // 3. A ledge edge is a choice: mostly turn, occasionally step off.
    //    Deliberately biased — a pet that constantly falls looks broken.
    if (platform && platform.id !== WORLD_FLOOR && (nextX < platform.x0 || nextX > platform.x1)) {
      if (pack.behavior.can.fall && chance(state, 0.15)) {
        state.x = nextX;
        startFalling();
        return;
      }
      turn();
      return;
    }

    state.x = nextX;
    state.odometer += Math.abs(state.vx * dt);

    // Walking off the end of one screen's floor onto the next: re-acquire
    // whatever is underfoot now.
    if (state.standingOn === WORLD_FLOOR || platform === undefined) {
      const p = platformUnder(state.x, state.y - 2);
      if (p && Math.abs(p.y - state.y) < 2) state.standingOn = p.id;
    }
  }

  function reconcileWorld(next: World): void {
    const prev = world;
    world = next;
    if (next.rev === state.worldRev) return;
    state.worldRev = next.rev;

    if (state.climbingOn !== null) {
      const w = wallById(state.climbingOn);
      if (!w) return startFalling();
      state.x = w.x;
      state.y = Math.min(Math.max(state.y, w.y0), w.y1);
      return;
    }

    const standing = platformById(state.standingOn);
    if (standing) {
      // Ride it — the window this pet is sitting on may have been dragged.
      state.y = standing.y;
      if (state.x < standing.x0 || state.x > standing.x1) startFalling();
    } else if (state.standingOn === WORLD_FLOOR) {
      settleOntoGround();
    } else if (state.standingOn !== null) {
      startFalling(); // the window it was standing on closed
    } else if (prev.bounds.h !== next.bounds.h || prev.bounds.y !== next.bounds.y) {
      settleOntoGround();
    }

    // A monitor may have been unplugged out from under the pet.
    if (!regionAt(world.regions, state.x, state.y)) settleOntoGround();
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
      let guard = 0;
      while (accumulator >= FIXED_DT_MS && guard++ < 32) {
        stepFixed(FIXED_DT_MS);
        accumulator -= FIXED_DT_MS;
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
          // Deliberately do not fast-forward. Returning to the machine should
          // show a pet where you left it, not one that has visibly "lived"
          // through the gap.
          accumulator = 0;
          settleOntoGround();
          setBehavior('idle');
          break;

        case 'command':
          if (e.name === 'recenter') {
            const r = firstRegion(world);
            state.x = r.x + r.w / 2;
            state.y = r.y + r.h;
            settleOntoGround();
            setBehavior('idle');
          } else if (e.name === 'come-here' && e.x !== undefined) {
            if (state.climbingOn === null) {
              state.facing = e.x < state.x ? -1 : 1;
              setBehavior('walk');
            }
          } else if (e.name === 'sleep') {
            if (state.climbingOn === null) setBehavior('sleep');
          } else if (e.name === 'wake') {
            setBehavior('idle');
          } else if (e.name === 'place' && e.x !== undefined && e.y !== undefined) {
            // Drag-and-drop: put the pet's feet at a point and let physics
            // take over. This is how it gets onto a window — it can't jump,
            // so being carried is the way up.
            const r = regionAt(world.regions, e.x, e.y) ?? nearestRegion(e.x, e.y);
            state.x = Math.min(Math.max(e.x, r.x), r.x + r.w);
            state.y = Math.min(Math.max(e.y, r.y), r.y + r.h);
            state.vx = 0;
            state.vy = 0;
            state.climbingOn = null;

            // Dropped against a side edge: hang there. Without this the only
            // way onto a wall is to catch the pet mid-wander, since it can't
            // be aimed at one.
            //
            // Ground wins ties. Near the bottom corner of a screen every drop
            // is within grabbing distance of the wall, and silently pasting
            // the pet to the edge when the user clearly meant the floor is
            // worse than the occasional missed wall.
            const w = pack.behavior.can.climb ? wallNear(state.x, state.y) : undefined;
            if (w && dropHeight(state.x, state.y) > WALL_GRAB) {
              attachToWall(w, -1);
              setBehavior('cling');
            } else {
              startFalling();
            }
          }
          break;

        case 'pointer':
          // Shyness (rule 3 — the pet yields) lands with the game layer.
          break;
      }
    },

    frame(): RenderFrame {
      return deriveFrame(pack, state);
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
 * Convenience for hosts and tests: a single-screen world with a floor.
 * Walls run down both outer edges, so the pet can climb even here.
 */
export function simpleWorld(w: number, h: number, rev = 1): World {
  return {
    rev,
    bounds: { x: 0, y: 0, w, h },
    regions: [{ x: 0, y: 0, w, h }],
    platforms: [{ id: 'floor', x0: 0, x1: w, y: h, kind: 'floor', passthrough: false }],
    walls: [
      { id: 'wl', x: 0, y0: 0, y1: h, side: 1 },
      { id: 'wr', x: w, y0: 0, y1: h, side: -1 },
    ],
    gravity: 900,
    reducedMotion: false,
  };
}

export { rand, randRange, chance, seedFrom, weightedPick };
