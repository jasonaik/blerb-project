/**
 * What survives a restart, and the shape it must have to be believed.
 *
 * `GameState` is plain JSON by design — {bucket, minutes} per day and session
 * lengths, nothing else (CLAUDE.md §11). The host writes it out and reads it
 * back; this file is the border check on the way back in. A file that has
 * been hand-edited, half-written, or produced by a future version with a
 * different shape yields `null`, and the host starts a fresh ledger rather
 * than feeding NaN into a reducer that runs once a second for the rest of
 * the day.
 */

import type { DayStats, GameState, SessionRecord } from './types.js';

/** Days of ledger kept on disk. Older days are pruned on save. */
export const KEEP_DAYS = 90;

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isNumOrNull = (x: unknown): x is number | null => x === null || isNum(x);

function isDayStats(x: unknown): x is DayStats {
  if (!x || typeof x !== 'object') return false;
  const d = x as Record<string, unknown>;
  return (
    isNum(d['focusMs']) &&
    isNum(d['neutralMs']) &&
    isNum(d['elsewhereMs']) &&
    isNum(d['sessions']) &&
    isNum(d['longestMs'])
  );
}

function isSession(x: unknown): x is SessionRecord {
  if (!x || typeof x !== 'object') return false;
  const s = x as Record<string, unknown>;
  return isNum(s['startT']) && isNum(s['endT']) && isNum(s['focusMs']);
}

/**
 * Validate a parsed JSON value as a GameState. Returns a fresh copy with
 * exactly the known fields — unknown keys are dropped, so nothing a host
 * (or a future version) tucked in can ride along — or null when the
 * top-level shape is wrong.
 *
 * Individual day and session records are independent of each other, so one
 * bad record is DROPPED rather than voiding the file: a single corrupt line
 * must not erase ninety days of ledger.
 */
export function hydrate(raw: unknown): GameState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  if (!isNumOrNull(r['prevT']) || !isNumOrNull(r['prevIdleMs'])) return null;
  const prevBucket = r['prevBucket'];
  if (
    prevBucket !== null &&
    prevBucket !== 'focus' &&
    prevBucket !== 'neutral' &&
    prevBucket !== 'elsewhere' &&
    prevBucket !== 'away'
  ) {
    return null;
  }

  let session: GameState['session'] = null;
  if (r['session'] !== null && r['session'] !== undefined) {
    const s = r['session'] as Record<string, unknown>;
    if (
      !s ||
      typeof s !== 'object' ||
      !isNum(s['startT']) ||
      !isNum(s['focusMs']) ||
      !isNum(s['lastFocusT']) ||
      !isNumOrNull(s['awayFromFocusT'])
    ) {
      return null;
    }
    session = {
      startT: s['startT'],
      focusMs: s['focusMs'],
      lastFocusT: s['lastFocusT'],
      awayFromFocusT: s['awayFromFocusT'],
    };
  }

  const daysRaw = r['days'];
  if (!daysRaw || typeof daysRaw !== 'object' || Array.isArray(daysRaw)) return null;
  const days: Record<string, DayStats> = {};
  for (const [key, value] of Object.entries(daysRaw as Record<string, unknown>)) {
    if (!isDayStats(value)) continue;
    days[key] = {
      focusMs: value.focusMs,
      neutralMs: value.neutralMs,
      elsewhereMs: value.elsewhereMs,
      sessions: value.sessions,
      longestMs: value.longestMs,
    };
  }

  const sessionsRaw = r['sessions'];
  if (!Array.isArray(sessionsRaw)) return null;
  const sessions: SessionRecord[] = [];
  for (const value of sessionsRaw) {
    if (!isSession(value)) continue;
    sessions.push({ startT: value.startT, endT: value.endT, focusMs: value.focusMs });
  }

  return {
    prevT: r['prevT'],
    prevBucket: prevBucket as GameState['prevBucket'],
    prevIdleMs: r['prevIdleMs'],
    session,
    days,
    sessions,
  };
}

/**
 * Drop day records the host no longer wants (older than KEEP_DAYS, by key —
 * "YYYY-MM-DD" keys compare correctly as strings). Sessions are already
 * capped by the reducer. Returns a new state; the input is untouched.
 */
export function pruneDays(state: GameState, keep: (dayKey: string) => boolean): GameState {
  const days: Record<string, DayStats> = {};
  for (const [key, value] of Object.entries(state.days)) {
    if (keep(key)) days[key] = { ...value };
  }
  return {
    prevT: state.prevT,
    prevBucket: state.prevBucket,
    prevIdleMs: state.prevIdleMs,
    session: state.session ? { ...state.session } : null,
    days,
    sessions: state.sessions.map((s) => ({ ...s })),
  };
}
