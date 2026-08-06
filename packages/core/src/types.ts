import type { EffectId } from '@blerb/pack';

/**
 * UNITS AND CONVENTIONS — the thing to get right once.
 *
 *   world px   CSS px on the host surface. Origin top-left, +y DOWN.
 *   position   Always the pet's GROUND ANCHOR (its feet), never its top-left.
 *              Every transform in the renderer is about this point, which is
 *              why squash-and-stretch keeps the feet planted instead of
 *              sinking the pet into the floor.
 *
 * DIP vs physical-pixel conversion is the host adapter's problem. The sim only
 * ever sees one coordinate space and does not know what a monitor is.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Platform {
  /**
   * Stable across ticks. This is what lets the pet keep standing on the same
   * window while that window moves — without it, every world update would
   * look like the ground vanishing.
   */
  id: string;
  x0: number;
  x1: number;
  y: number;
  kind: 'floor' | 'ledge';
  /** Can the pet drop through it from above. */
  passthrough: boolean;
}

/**
 * An UNDERSIDE the pet can hang from, walking upside down.
 *
 * Deliberately a separate list rather than a flag on `Platform`. Half a dozen
 * places ask "what is under the pet" — where it lands, what it settles onto,
 * what it can mantle to — and every one of them would need to remember to
 * exclude ceilings. Forgetting one gives you a pet that falls upwards.
 *
 * `y` is the surface itself; the pet's anchor sits exactly on it and its body
 * hangs below, which is the mirror of how it stands on a Platform.
 */
export interface Ceiling {
  id: string;
  x0: number;
  x1: number;
  y: number;
}

/**
 * A vertical surface the pet can cling to and climb.
 *
 * Only exists where there is nothing to walk onto — the outer edge of the
 * desktop, not the seam between two adjacent monitors. That distinction is
 * the whole multi-monitor feature: where screens touch, the pet walks across;
 * where the desktop ends, it climbs.
 */
export interface Wall {
  id: string;
  /** The surface's x. The pet's anchor sits exactly here while clinging. */
  x: number;
  y0: number;
  y1: number;
  /**
   * Which side of the wall the pet is on: -1 = pet is to the left (a
   * right-hand wall), +1 = pet is to the right (a left-hand wall).
   */
  side: -1 | 1;
}

/**
 * Everything the sim knows about the outside. Flat and diffable on purpose:
 * on the desktop this is built in the Electron main process from a Win32
 * window walk and shipped over IPC ~3x/second, so it has to survive
 * structured clone and stay small.
 */
export interface World {
  /** Monotonic. Bumped whenever bounds/platforms change; the sim re-clamps on change. */
  rev: number;
  /**
   * Bounding box of every region. On a multi-monitor desktop this is the union
   * and may contain dead space — bounds alone is NOT a valid walkable area.
   * Use `regions` for containment.
   */
  bounds: Rect;
  /**
   * The actual screens, in global coordinates. The pet must always be inside
   * one of these. Two monitors of different heights, or offset vertically,
   * leave L-shaped gaps in `bounds` that are not real screen — walking into
   * them would put the pet somewhere the user cannot see.
   */
  regions: Rect[];
  /** Sorted by y ascending. The host guarantees the ordering; the sim relies on it. */
  platforms: Platform[];
  /** Climbable vertical surfaces. Empty is fine; the pet just turns around. */
  walls: Wall[];
  /** Undersides the pet can hang from. Empty is fine; it just never hangs. */
  ceilings: Ceiling[];
  gravity: number;
  reducedMotion: boolean;
}

export type HideReason = 'reduced-motion' | 'fullscreen' | 'presenting' | 'manual';

export type BehaviorId =
  | 'idle'
  | 'walk'
  | 'sit'
  | 'sleep'
  | 'fall'
  | 'land'
  | 'stretch'
  /** Moving along a wall, up or down. */
  | 'climb'
  /** Attached to a wall but stationary — deciding, or resting. */
  | 'cling'
  /** Upside down on the underside of something, walking along it. */
  | 'hang';

export type PetEvent =
  | { k: 'world'; world: World }
  | { k: 'pointer'; x: number; y: number; kind: 'move' | 'down' | 'up' }
  | { k: 'hide'; reason: HideReason }
  | { k: 'show' }
  | { k: 'command'; name: 'come-here' | 'sleep' | 'wake' | 'recenter' | 'place'; x?: number; y?: number }
  /** Emitted after a long gap (sleep, backgrounded tab) instead of fast-forwarding. */
  | { k: 'resume'; gapMs: number };

/**
 * Fully serializable — no object references, no closures, no Map. This is what
 * makes the sim snapshot-testable and what lets a host persist the pet mid-walk
 * and restore it without a visible jump.
 */
export interface PetState {
  /** Ground anchor (feet), world px. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: -1 | 1;
  /** Platform.id, or null while airborne or climbing. */
  standingOn: string | null;
  /** Wall.id while clinging/climbing, else null. Mutually exclusive with standingOn. */
  climbingOn: string | null;
  /** Cached Wall.side, so a frame can be derived without the World. */
  climbSide: -1 | 1;
  /** Vertical direction while climbing: -1 up, +1 down. */
  climbDir: -1 | 1;
  /**
   * Ceiling.id while hanging upside down, else null. Mutually exclusive with
   * both standingOn and climbingOn.
   */
  hangingOn: string | null;

  behavior: BehaviorId;
  /** ms spent in the current behavior. */
  behaviorT: number;
  /** ms the current behavior intends to last. */
  behaviorDur: number;

  /** Currently playing animation name; resolved against the pack at draw time. */
  anim: string;
  /** ms into the current animation. */
  animT: number;
  /** Total simulated time, ms. Carried in state so any process can derive a frame. */
  simT: number;

  /**
   * Distance travelled, world px. Drives the walk cycle's phase so the feet
   * stay locked to the ground rather than skating when speed changes.
   */
  odometer: number;

  /**
   * Exponential moving average of "is moving", 0..1.
   * Design contract rule 4 — stationary >=70% of wall-clock — is enforced from
   * this, in code, rather than left as an aspiration in a doc.
   */
  motionEma: number;

  /** mulberry32 state. The sim's only source of randomness. */
  rng: number;

  hidden: boolean;
  /** World.rev the state was last reconciled against. */
  worldRev: number;
}

export interface EffectSprite {
  id: EffectId;
  /** Offset from the pet's anchor, world px. */
  dx: number;
  dy: number;
  opacity: number;
  scale: number;
}

/**
 * THE boundary between simulation and rendering. Nothing else crosses it, and
 * it never crosses a process boundary — `World` and `PetEvent` go over IPC,
 * this does not.
 */
export interface RenderFrame {
  /** Sim time, ms. */
  t: number;
  /** Exact atlas cell to draw. */
  cellId: string;
  /** Ground anchor, sub-pixel. */
  x: number;
  y: number;
  facing: -1 | 1;
  scale: number;
  opacity: number;
  /** Radians, about the anchor. */
  rotation: number;
  /** About the anchor. Volume-preserving when the procedural rig drives it. */
  squash: { sx: number; sy: number };
  effects: EffectSprite[];
}

/** Persisted pet position/pose. Ephemeral per host — never part of the save file. */
export interface PetSnapshot {
  x: number;
  y: number;
  facing: -1 | 1;
  behavior: BehaviorId;
  rng: number;
}
