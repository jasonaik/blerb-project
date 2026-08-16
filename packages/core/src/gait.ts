/**
 * The procedural gait: how a pack with ONE drawing walks convincingly.
 *
 * Pure deformation of an already-derived RenderFrame — squash, bob and lean
 * about the ground anchor — driven by PetState alone, so it is exactly as
 * deterministic as the rest of the sim. AI frame generation was rejected for
 * this job (see CLAUDE.md §7): its failure mode is a character that flickers
 * into a different character eight times a second. Deformation can look
 * stiff; it cannot look like someone else.
 *
 * Every term is anchored at the FEET (RenderFrame.x/y is the ground anchor,
 * and the renderer scales about it), which is why squashing reads as weight
 * pressing into the floor instead of the sprite sinking through it.
 *
 * Every branch eases IN over its first EASE_MS via behaviorT, so a behavior
 * change starts from neutral instead of teleporting the pose. The one
 * remaining discontinuity is deliberate and documented: a walk that ends
 * mid-stride snaps its last deformation back to neutral in one frame —
 * carrying it further would need the previous behavior in PetState, and the
 * pop is a few percent of height at worst.
 */

import type { ResolvedPack } from '@blerb/pack';
import type { PetState, RenderFrame } from './types.js';

const TAU = Math.PI * 2;

/** Ramp into each branch's deformation, ms. */
const EASE_MS = 150;
/** The land pulse: full squash, then a ramp back up. */
const LAND_HOLD_MS = 60;
const LAND_MS = 120;
/** sy can never reach 0 (sx = 1/sy), whatever a hand-written pack declares. */
const MIN_SY = 0.05;

type Rig = NonNullable<ResolvedPack['rig']>;

/**
 * resolvePack guarantees every rig has a 'walk' gait (synthesized from the
 * schema's defaults if unwritten), so lookups always land somewhere
 * deterministic — never on "whichever key the author wrote first".
 */
function gait(rig: Rig, name: string) {
  return rig.gaits[name] ?? rig.gaits['walk']!;
}

/**
 * Deform `f` according to the pack's rig and the pet's current state.
 * Identity when the pack has no rig. Never touches PetState.
 *
 * `displayScale` is the host's pet-size multiplier. Squash and lean are
 * relative so they scale with the sprite for free; the bob is an absolute
 * anchor offset and must be told, or it shrinks (proportionally) as the pet
 * grows.
 */
export function applyGait(
  pack: ResolvedPack,
  s: PetState,
  f: RenderFrame,
  displayScale = 1,
): RenderFrame {
  const rig = pack.rig;
  if (!rig) return f;

  // On a wall or under a ceiling the sprite is already rotated a quarter or
  // half turn; the walk deformation assumes upright ground contact, so only
  // the breathing survives there.
  const upright = s.climbingOn === null && s.hangingOn === null;
  const ease = Math.min(1, s.behaviorT / EASE_MS);

  let dy = 0;
  let sy = 1;
  let lean = 0;

  if (upright && s.behavior === 'walk') {
    const g = gait(rig, 'walk');
    // Phase from DISTANCE, not time: two footfalls per stride, feet locked to
    // the ground, so the cycle can never treadmill or skate.
    const p = (((s.odometer / g.strideLength) % 1) + 1) % 1;
    const th = p * TAU;
    // Displayed height: cell.h over atlasScale (hi-res art renders small),
    // times the host's pet-size setting.
    const cellH = (pack.cell(f.cellId).h / pack.atlasScale) * displayScale;
    dy = -g.bobAmp * cellH * Math.abs(Math.sin(th)) * ease;
    // Squash AT CONTACT (weight landing), stretch at the apex. The first cut
    // had this inverted — tallest at footfall — and reviewed motion reads
    // wrong even at 8% amplitude.
    sy = 1 - g.squash * Math.cos(2 * th) * ease;
    lean = ((g.tiltDeg * Math.PI) / 180) * s.facing * (0.6 + 0.4 * Math.sin(th)) * ease;
  } else if (upright && s.behavior === 'land' && s.behaviorT < LAND_MS) {
    // Hold the impact squash, then ramp back to neutral instead of stepping.
    const t = s.behaviorT;
    sy = t < LAND_HOLD_MS ? 0.75 : 0.75 + 0.25 * ((t - LAND_HOLD_MS) / (LAND_MS - LAND_HOLD_MS));
  } else if (s.behavior === 'sleep') {
    const g = gait(rig, 'sleep');
    // Twice the amplitude at 0.4x the rate: visibly asleep, not idling slowly.
    sy = 1 + g.breatheAmp * 2 * Math.sin(TAU * g.breatheHz * 0.4 * (s.simT / 1000)) * ease;
  } else if (s.behavior !== 'fall') {
    const g = gait(rig, 'idle');
    sy = 1 + g.breatheAmp * Math.sin(TAU * g.breatheHz * (s.simT / 1000)) * ease;
  }

  if (dy === 0 && sy === 1 && lean === 0) return f;
  sy = Math.max(MIN_SY, sy);
  // Volume-preserving: sx = 1/sy, so the character reads as flesh, not as a
  // picture being stretched.
  return {
    ...f,
    y: f.y + dy,
    rotation: f.rotation + lean,
    squash: { sx: 1 / sy, sy },
  };
}
