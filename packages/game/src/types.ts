/**
 * THE GAME LAYER'S ENTIRE VIEW OF THE USER.
 *
 * Two signals, deliberately (CLAUDE.md §8): which process is in the
 * foreground, and how long since any input. Nothing here can hold a window
 * title, a URL, or a file path — `normalizeApp` strips paths defensively, so
 * even a misbehaving host cannot leak one into this state. What persists,
 * ever, is {bucket, minutes} and session lengths. That is the whole privacy
 * story, enforced by shape.
 */

export type Bucket = 'focus' | 'neutral' | 'elsewhere';

/**
 * User-owned lists of process basenames (case-insensitive, `.exe` optional).
 * `elsewhere` SHIPS EMPTY — pre-labelling apps as bad is exactly the
 * paternalism the design contract exists to avoid. Anything unlisted is
 * neutral.
 */
export interface Classification {
  focus: readonly string[];
  elsewhere: readonly string[];
}

/**
 * One poll of the two signals. The host samples ~1/s; the reducer only ever
 * diffs consecutive samples, so nothing here depends on the rate.
 */
export interface ObservationSample {
  /** Host clock, ms. Only differences are used. */
  t: number;
  /** Foreground process basename, or null (no window, lock screen). */
  app: string | null;
  /** Time since the last keyboard/mouse input, ms. */
  idleMs: number;
}

/** A completed focus session. The headline number is endT - startT. */
export interface SessionRecord {
  startT: number;
  endT: number;
  /** ms actually spent with a focus app foregrounded and the user present. */
  focusMs: number;
}

export interface DayStats {
  focusMs: number;
  neutralMs: number;
  elsewhereMs: number;
  sessions: number;
  longestMs: number;
}

/** Fully serializable — snapshot-testable, and one day persistable. */
export interface GameState {
  prevT: number | null;
  /** Previous sample's bucket, for attributing the elapsed interval. */
  prevBucket: Bucket | 'away' | null;
  /** Previous sample's idleMs — lets a sleep-gap close land on the last input. */
  prevIdleMs: number | null;
  session: {
    startT: number;
    focusMs: number;
    /** Last moment a focus app was foregrounded with the user present. */
    lastFocusT: number;
    /**
     * Start of the CURRENT contiguous present-but-not-at-focus stretch, or
     * null while at a focus app. The sustained-exit clock times from here —
     * timing it from lastFocusT let a tolerated 60-89s reading pause
     * pre-charge the exit allowance, so a 30s glance at chat afterwards
     * split the session.
     */
    awayFromFocusT: number | null;
  } | null;
  /** Keyed by the host's dayKey (a local date string). */
  days: Record<string, DayStats>;
  /** Most recent completed sessions, newest last. Capped. */
  sessions: SessionRecord[];
}
