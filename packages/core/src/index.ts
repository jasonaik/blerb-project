export type {
  Rect,
  Platform,
  Wall,
  World,
  HideReason,
  BehaviorId,
  PetEvent,
  PetState,
  PetSnapshot,
  EffectSprite,
  RenderFrame,
} from './types.js';

export {
  createSim,
  deriveFrame,
  simpleWorld,
  WORLD_FLOOR,
  type Sim,
  type SimOptions,
} from './sim.js';

export {
  EPS,
  rectContains,
  regionAt,
  unionRect,
  subtractSpans,
  type Span,
} from './geom.js';

export { rand, randRange, chance, weightedPick, seedFrom, type RngHolder } from './rng.js';
