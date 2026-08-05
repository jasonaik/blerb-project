/**
 * The shared effect vocabulary.
 *
 * These ship with the app rather than with each pack, which is what lets a pet
 * imported from a single static image — no facial expressions, one pose — still
 * express something. The pet can't smile, but a `heart` can appear above it.
 *
 * The atlas itself lands in Phase 6, when the pet starts reacting to anything.
 * The names are fixed now so `RenderFrame.effects` has a stable vocabulary to
 * refer to and packs can't invent their own.
 */
export const EFFECTS = [
  'zzz',
  'heart',
  'sparkle',
  'dust',
  'sweat',
  'note',
  'question',
  'exclaim',
] as const;

export type EffectId = (typeof EFFECTS)[number];
