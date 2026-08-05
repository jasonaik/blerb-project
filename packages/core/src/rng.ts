/**
 * mulberry32 — small, fast, good enough, and crucially *serializable*: the
 * whole generator is one uint32, so it lives inside PetState and travels with
 * a snapshot. Restore a pet mid-walk and it makes the same decisions it would
 * have made.
 *
 * The API mutates a holder rather than closing over state, because a closure
 * could not be persisted and `Math.random` is banned in this package (see the
 * eslint `pure-packages` rule). Determinism is what makes the sim testable:
 * same seed + same dt sequence + same events => byte-identical PetState.
 */

export interface RngHolder {
  rng: number;
}

/** Uniform in [0, 1). Advances the holder. */
export function rand(s: RngHolder): number {
  s.rng = (s.rng + 0x6d2b79f5) >>> 0;
  let t = s.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Uniform in [lo, hi). */
export function randRange(s: RngHolder, lo: number, hi: number): number {
  return lo + rand(s) * (hi - lo);
}

/** True with probability p. */
export function chance(s: RngHolder, p: number): boolean {
  return rand(s) < p;
}

/**
 * Weighted pick. Ignores non-positive weights; returns null if nothing is
 * eligible, which callers treat as "keep doing what you're doing".
 */
export function weightedPick<T extends string>(
  s: RngHolder,
  weights: ReadonlyArray<readonly [T, number]>,
): T | null {
  let total = 0;
  for (const [, w] of weights) if (w > 0) total += w;
  if (total <= 0) return null;

  let roll = rand(s) * total;
  for (const [key, w] of weights) {
    if (w <= 0) continue;
    roll -= w;
    if (roll <= 0) return key;
  }
  // Floating-point slop on the last bucket.
  for (let i = weights.length - 1; i >= 0; i--) {
    const entry = weights[i]!;
    if (entry[1] > 0) return entry[0];
  }
  return null;
}

/**
 * Turn an arbitrary string into a seed, so "seed the pet from the pack id"
 * gives a stable-but-arbitrary starting point. FNV-1a.
 */
export function seedFrom(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
