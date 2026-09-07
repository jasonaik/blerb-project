/**
 * The retrospective — the only kind of feedback the game gives (design
 * contract rule 2): informational, after the fact, about what you did.
 *
 * "You held focus 52 minutes — longest this week." Never "+2 XP". The
 * distinction is not tone, it is the sign of the effect: positive
 * informational feedback helps intrinsic motivation (d=+0.33), contingent
 * reward for the same behaviour hurts it (d=−0.40). So there are no points
 * here to add up, no level to reach, and — rule 3 — nothing here is ever
 * phrased as a shortfall. A day with nothing in it says so, plainly.
 *
 * Day keys are the host's ("2026-08-16", local time): the reducer is
 * timezone-agnostic and so is this. The host says which keys are today,
 * yesterday, and this week; the arithmetic is done on records, not dates.
 */

import type { DayStats, GameState } from './types.js';

export interface Retrospective {
  today: DayStats;
  /** The previous day's record, or null if there is none. */
  yesterday: DayStats | null;
  /** Totals over the week keys the host passed — today included. */
  week: { focusMs: number; sessions: number; daysWithFocus: number; longestMs: number };
  /**
   * Today's longest session is the longest of the week — the one fact the
   * whole layer exists to be able to say. Only claimed when the week has
   * more than one day with focus in it; on day one "longest this week" is
   * true of anything.
   */
  todayIsWeekBest: boolean;
}

export interface DayKeys {
  today: string;
  yesterday: string;
  /** Every key in the window that counts as "this week", today included. */
  week: readonly string[];
}

const EMPTY: DayStats = { focusMs: 0, neutralMs: 0, elsewhereMs: 0, sessions: 0, longestMs: 0 };

export function retrospective(state: GameState, keys: DayKeys): Retrospective {
  const today = state.days[keys.today] ?? EMPTY;
  const yesterday = keys.yesterday === keys.today ? null : (state.days[keys.yesterday] ?? null);

  // A Set, so a host that computes its keys carelessly (a DST day counted
  // twice) can never double-book a day.
  const week = { focusMs: 0, sessions: 0, daysWithFocus: 0, longestMs: 0 };
  for (const key of new Set(keys.week)) {
    const d = state.days[key];
    if (!d) continue;
    week.focusMs += d.focusMs;
    week.sessions += d.sessions;
    if (d.focusMs > 0) week.daysWithFocus++;
    week.longestMs = Math.max(week.longestMs, d.longestMs);
  }

  const todayIsWeekBest =
    today.longestMs > 0 && week.daysWithFocus > 1 && today.longestMs >= week.longestMs;

  return { today, yesterday, week, todayIsWeekBest };
}

/** "1h 52m", "52m", "under a minute". Never seconds — nothing here is a stopwatch. */
export function formatDuration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'under a minute';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * The retrospective as plain sentences, in the order they should be read.
 * Pure so the design contract can be tested against the actual words:
 * `summary.test.ts` asserts no line ever mentions points, XP, levels or
 * streaks, and that an empty day reads as a fact, not a failure.
 */
export function describe(r: Retrospective): string[] {
  const lines: string[] = [];
  const t = r.today;

  if (t.focusMs === 0 && t.sessions === 0) {
    lines.push('Nothing recorded yet today.');
  } else {
    const sessions = t.sessions === 1 ? '1 session' : `${t.sessions} sessions`;
    lines.push(
      t.sessions > 0
        ? `Focus today: ${formatDuration(t.focusMs)} across ${sessions}.`
        : `Focus today: ${formatDuration(t.focusMs)}.`,
    );
    if (t.longestMs > 0) {
      lines.push(
        `Longest session: ${formatDuration(t.longestMs)}` +
          (r.todayIsWeekBest ? ' — your longest this week.' : '.'),
      );
    }
  }

  if (r.yesterday && r.yesterday.focusMs > 0) {
    lines.push(`Yesterday: ${formatDuration(r.yesterday.focusMs)}.`);
  }
  if (r.week.daysWithFocus > 1) {
    lines.push(
      `This week: ${formatDuration(r.week.focusMs)} over ${r.week.daysWithFocus} days` +
        (r.week.longestMs > 0 && !r.todayIsWeekBest ? `, longest session ${formatDuration(r.week.longestMs)}.` : '.'),
    );
  }
  return lines;
}
