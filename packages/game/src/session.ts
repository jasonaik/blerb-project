/**
 * Session segmentation as a pure reducer over observation samples.
 *
 * A SESSION is a stretch with a focus-bucket app in the foreground. It ends
 * two ways, with deliberately different thresholds:
 *
 *   - a SUSTAINED switch to another bucket: ≥60s with a non-focus app
 *     foregrounded. Checking Slack for 20 seconds does not end a session.
 *   - an idle gap ≥90s. Idle between 60s and 90s at a focus app ends
 *     NOTHING — that is someone reading or thinking, and the asymmetry
 *     between these two thresholds is the design's whole answer to the
 *     "idle can't tell absence from concentration" problem (CLAUDE.md §8):
 *     when in doubt, keep the session open.
 *
 * Sessions close RETROACTIVELY at the moment focus was actually lost (the
 * last focus-foreground moment, or the last input), not at the moment the
 * reducer notices — so the 60s of Slack that ended a session is not counted
 * as focus time.
 *
 * No wall clock anywhere: time arrives inside samples, and day boundaries
 * arrive as an injected `dayKey`. Same samples, same config → byte-identical
 * state, which is what makes a synthetic day a complete test.
 */

import { bucketOf, normalizeApp } from './classify.js';
import type { Bucket, Classification, DayStats, GameState, ObservationSample } from './types.js';

/** Input older than this = the user is away; time stops accruing to buckets. */
export const IDLE_AWAY_MS = 60_000;
/** An idle gap this long ends a session (at the moment input stopped). */
export const SESSION_IDLE_END_MS = 90_000;
/** A non-focus foreground stretch this long ends a session (at its start). */
export const SESSION_EXIT_MS = 60_000;
/** Focus stretches shorter than this are taps, not sessions. */
export const MIN_SESSION_MS = 60_000;
/**
 * A gap between samples longer than this means the machine slept or the
 * process stopped — credit nothing across it, and end any open session where
 * the samples stopped rather than pretending the gap was focus.
 */
export const MAX_SAMPLE_GAP_MS = 5_000;
/** Completed sessions kept in state, newest last. */
const MAX_SESSIONS = 200;

export interface GameConfig {
  classification: Classification;
  /** t (ms) → day bucket, e.g. a local "2026-08-16". The host owns timezones. */
  dayKey: (t: number) => string;
}

export interface Game {
  readonly state: Readonly<GameState>;
  observe(sample: ObservationSample): void;
  /** Live classification swap — the user edited their lists. */
  setClassification(cls: Classification): void;
  /** Stats for the day containing t (usually "now"). Zeroes if none. */
  day(t: number): DayStats;
  serialize(): GameState;
}

const emptyDay = (): DayStats => ({
  focusMs: 0,
  neutralMs: 0,
  elsewhereMs: 0,
  sessions: 0,
  longestMs: 0,
});

export function createGame(cfg: GameConfig): Game {
  let cls = cfg.classification;

  const state: GameState = {
    prevT: null,
    prevBucket: null,
    prevIdleMs: null,
    session: null,
    days: {},
    sessions: [],
  };

  function dayOf(t: number): DayStats {
    const key = cfg.dayKey(t);
    return (state.days[key] ??= emptyDay());
  }

  /**
   * Close the open session as of `endT`. Taps under MIN_SESSION_MS vanish
   * without a trace — ignoring the pet, and brushing past a focus app, are
   * both completely free (design contract rule 7).
   */
  function closeSession(endT: number): void {
    const s = state.session;
    if (!s) return;
    state.session = null;
    // No caller may record an end before the start, whatever the host clock
    // did in between.
    const end = Math.max(endT, s.startT);
    const length = end - s.startT;
    if (length < MIN_SESSION_MS) return;
    state.sessions.push({ startT: s.startT, endT: end, focusMs: s.focusMs });
    if (state.sessions.length > MAX_SESSIONS) state.sessions.shift();
    // Sessions are booked to the day they STARTED. A midnight-straddling
    // session can therefore make a day's longestMs exceed that day's own
    // focusMs (which accrues to the day each interval ends in) — accepted
    // and pinned by test; anything reporting "longest today" should say
    // "longest session started today".
    const day = dayOf(s.startT);
    day.sessions++;
    day.longestMs = Math.max(day.longestMs, length);
  }

  function observe(sample: ObservationSample): void {
    const app = sample.app === null ? null : normalizeApp(sample.app);
    const present = sample.idleMs < IDLE_AWAY_MS;
    const bucket: Bucket | 'away' = app === null || !present ? 'away' : bucketOf(app, cls);

    // --- attribute the elapsed interval to the PREVIOUS sample's bucket ----
    if (state.prevT !== null && state.prevBucket !== null) {
      const dt = sample.t - state.prevT;
      if (Math.abs(dt) > MAX_SAMPLE_GAP_MS) {
        // The machine slept, we stopped, or the clock STEPPED (NTP, manual
        // change — dt can be hugely negative). Either way this timebase does
        // not continue the last one: nothing accrues, and an open session
        // ended when the samples stopped. That end lands on the last input,
        // not on lastFocusT — presence lingers ~60s past the final
        // keystroke, and the idle-close path already corrects for that; the
        // gap path must agree with it.
        closeSession(
          state.session
            ? Math.min(state.session.lastFocusT, state.prevT - (state.prevIdleMs ?? 0))
            : sample.t,
        );
      } else if (dt > 0 && state.prevBucket !== 'away') {
        const day = dayOf(sample.t);
        if (state.prevBucket === 'focus') day.focusMs += dt;
        else if (state.prevBucket === 'neutral') day.neutralMs += dt;
        else day.elsewhereMs += dt;
        if (state.session && state.prevBucket === 'focus') state.session.focusMs += dt;
      }
    }

    // --- session transitions ----------------------------------------------
    if (state.session === null) {
      if (bucket === 'focus') {
        state.session = { startT: sample.t, focusMs: 0, lastFocusT: sample.t, awayFromFocusT: null };
      }
    } else if (bucket === 'focus') {
      state.session.lastFocusT = sample.t;
      state.session.awayFromFocusT = null;
    } else if (sample.idleMs >= SESSION_IDLE_END_MS) {
      // Idle gap. The session ended at the EARLIER of "focus left the
      // foreground" and "input stopped" — someone who switched to chat and
      // then wandered off must not have the chat tail counted as focus.
      // (lastFocusT can sit AFTER the last input, because presence lingers
      // for IDLE_AWAY_MS past the final keystroke.)
      closeSession(Math.min(state.session.lastFocusT, sample.t - sample.idleMs));
    } else if (present) {
      // Present, and not at a focus app. This includes app === null with
      // fresh input — an unreadable foreground (protected process, secure
      // desktop) is still the user actively being elsewhere, and treating it
      // as 'away' let a two-hour game bridge into one giant session.
      //
      // The exit clock times from the START of this contiguous stretch —
      // NOT from lastFocusT, which stops during a tolerated 60-89s reading
      // pause and would pre-charge the allowance (a 30s glance at chat after
      // reading used to split the session).
      state.session.awayFromFocusT ??= sample.t;
      if (sample.t - state.session.awayFromFocusT >= SESSION_EXIT_MS) {
        closeSession(state.session.lastFocusT);
      }
    }
    // Not present, idle under 90s: undecided. The 60-89s reading window at a
    // focus app ends nothing, and an idle tail elsewhere is the idle rule's
    // job the moment it crosses 90s.

    state.prevT = sample.t;
    state.prevBucket = bucket;
    state.prevIdleMs = sample.idleMs;
  }

  return {
    state,
    observe,
    setClassification(next) {
      cls = next;
    },
    day(t) {
      return state.days[cfg.dayKey(t)] ?? emptyDay();
    },
    serialize() {
      return JSON.parse(JSON.stringify(state)) as GameState;
    },
  };
}
