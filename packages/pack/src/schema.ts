import { z } from 'zod';

/**
 * THE PET PACK FORMAT — single source of truth.
 *
 * Every type in the project that describes a pet is inferred from this file,
 * and `petgen doctor` is essentially `PetManifest.safeParse` plus the semantic
 * checks in ./resolve.ts. If you are tempted to hand-write a `Pet` interface
 * somewhere else, don't — infer it from here.
 *
 * Design goal, in tension and deliberately resolved toward the second:
 *   - rich enough to describe a Shimeji-grade mascot
 *   - simple enough that a human can hand-write a working pet in 12 lines
 *
 * The 12-line version (see packs/blob/pet.json) is the one that must never
 * regress. Every field below either has a default or is derivable.
 */

export const FORMAT = 'blerb-pet/1';

/** [x, y] within the cell, in cell-local px. The pet's feet. See ./resolve.ts. */
const Anchor = z.tuple([z.number(), z.number()]);

const Cell = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  /** Defaults to bottom-centre — [w/2, h-1] — applied during resolution. */
  anchor: Anchor.optional(),
});

/**
 * Shorthand: lay the atlas out as a uniform grid and refer to frames by index.
 * `cells` (explicit, named) wins over `grid` where both define the same name.
 */
const Grid = z.object({
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  cols: z.number().int().positive(),
  /** Transparent gutter between cells, if the atlas has one. */
  spacing: z.number().int().nonnegative().default(0),
  /** Transparent border around the whole sheet. */
  margin: z.number().int().nonnegative().default(0),
  /** Defaults to "as many as fit in the atlas" during resolution. */
  count: z.number().int().positive().optional(),
});

const Animation = z.object({
  /** Frames are either grid indices (numbers) or explicit cell names (strings). */
  frames: z.array(z.union([z.number().int().nonnegative(), z.string()])).min(1),
  fps: z.number().positive().default(8),
  loop: z.boolean().default(true),
  /** For loop:false — what to play when this finishes. */
  next: z.string().optional(),
  /**
   * The travel speed (world px/s) this art was drawn to read correctly at.
   * The sim uses it to keep the walk cycle phase-locked to actual distance
   * travelled, so the feet don't skate. Optional; falls back to behavior.speed.
   */
  designSpeed: z.number().positive().optional(),
});

/**
 * Procedural gait (Phase 4). Lets a pack with a single static image produce a
 * convincing walk by deforming that image about the ground anchor, rather than
 * needing hand-drawn frames.
 *
 * The slot exists in v1 of the format so adding it later is not a version bump.
 */
/**
 * One gait's tuning. Amplitude caps are correctness, not taste: the renderer
 * derives sx = 1/sy, so a squash that can reach 1 divides by zero at the
 * stride apex, and sleep doubles breatheAmp — the caps keep sy well clear of
 * zero in every branch.
 */
export const RigGait = z.object({
  strideLength: z.number().positive().default(22),
  bobAmp: z.number().min(0).max(0.3).default(0.06),
  squash: z.number().min(0).max(0.5).default(0.08),
  tiltDeg: z.number().min(-30).max(30).default(4),
  scuff: z.number().nonnegative().default(0.4),
  breatheHz: z.number().positive().default(0.35),
  breatheAmp: z.number().min(0).max(0.2).default(0.03),
});

const Rig = z.object({
  type: z.literal('procedural'),
  gaits: z.record(z.string(), RigGait),
});

const Behavior = z.object({
  speed: z
    .object({
      walk: z.number().positive().default(40),
      run: z.number().positive().default(85),
      /** Vertical px/s while on a wall. Slower than walking reads as effort. */
      climb: z.number().positive().default(28),
    })
    .default({}),
  gravity: z.number().nonnegative().default(900),
  jump: z.number().nonnegative().default(260),
  can: z
    .object({
      fall: z.boolean().default(true),
      sit: z.boolean().default(true),
      sleep: z.boolean().default(true),
      drag: z.boolean().default(true),
      /** Cling to and climb the outer edges of the desktop. */
      climb: z.boolean().default(true),
      /** Hang upside down from undersides — window top edges, the screen top. */
      hang: z.boolean().default(true),
    })
    .default({}),
  /** 0..1 — how readily the pet climbs a wall instead of turning around. */
  climbiness: z.number().min(0).max(1).default(0.45),
  /** Relative weights for picking the next idle behavior. Keys are animation names. */
  idleWeights: z.record(z.string(), z.number().nonnegative()).default({
    idle: 6,
    walk: 4,
    sit: 3,
    sleep: 1,
  }),
  /** 0..1 — how often the pet changes its mind. */
  restlessness: z.number().min(0).max(1).default(0.4),
  /**
   * 0..1 — how wide a berth the pet gives the cursor.
   * Design contract rule 3: the pet yields. This is the knob that implements it.
   */
  shyness: z.number().min(0).max(1).default(0.5),
});

export const PetManifest = z.object({
  format: z.literal(FORMAT),
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]*$/, 'lowercase slug: a-z 0-9 _ -'),
  name: z.string().min(1),
  author: z.string().default('unknown'),
  license: z.string().default('unknown'),
  /** Where the art came from. Informational; surfaced in the pack picker. */
  source: z.string().optional(),

  /**
   * Hard-edged art. Turns off image smoothing and forces integer display
   * scaling, which is the difference between crisp and mush at 2x.
   */
  pixelArt: z.boolean().default(false),

  atlas: z.object({
    src: z.string().min(1),
    /** If the atlas was authored at 2x, set 2 and it renders at half size. */
    scale: z.number().positive().default(1),
  }),

  grid: Grid.optional(),
  cells: z.record(z.string(), Cell).default({}),

  /**
   * 'mirror'  — flip horizontally via the render matrix (the common case)
   * 'none'    — never flip; for art where a mirrored version would look wrong
   *
   * There is no 'baked' mode. Canvas is the only render sink, so pre-mirrored
   * atlas cells would be dead weight.
   */
  facing: z.enum(['mirror', 'none']).default('mirror'),

  animations: z.record(z.string(), Animation),

  /** Graceful degradation: `{"run": "walk"}` means a missing `run` plays `walk`. */
  aliases: z.record(z.string(), z.string()).default({}),

  rig: Rig.nullish(),
  behavior: Behavior.default({}),

  /** Cosmetic overlays, unlocked via the game layer. Attach points are Phase 7. */
  variants: z
    .record(
      z.string(),
      z.object({
        cell: z.string(),
        attach: z.enum(['head', 'body', 'feet']).default('head'),
        offset: z.tuple([z.number(), z.number()]).default([0, 0]),
      }),
    )
    .default({}),
});

export type PetManifest = z.infer<typeof PetManifest>;
export type PetManifestInput = z.input<typeof PetManifest>;
export type Cell = z.infer<typeof Cell>;
export type Animation = z.infer<typeof Animation>;
export type Behavior = z.infer<typeof Behavior>;
export type Rig = z.infer<typeof Rig>;

/**
 * The animations the sim will ask for by name. A pack does not have to provide
 * all of them — `resolvePack` falls back through `aliases` and then to `idle`,
 * so a one-animation pack still works. Listed here so `petgen doctor` can tell
 * an author what they're missing without failing them for it.
 */
export const KNOWN_ANIMATIONS = [
  'idle',
  'walk',
  'run',
  'sit',
  'sleep',
  'fall',
  'land',
  'stretch',
  'climb',
  'cling',
  'hang',
  'look',
  'react_happy',
  'sulk',
] as const;

export type KnownAnimation = (typeof KNOWN_ANIMATIONS)[number];
