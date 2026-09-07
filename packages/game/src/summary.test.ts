import { describe as suite, expect, it } from 'vitest';
import { describe, formatDuration, retrospective } from './summary.js';
import type { DayStats, GameState } from './types.js';

const day = (focusMin: number, sessions = focusMin > 0 ? 1 : 0, longestMin = focusMin): DayStats => ({
  focusMs: focusMin * 60_000,
  neutralMs: 0,
  elsewhereMs: 0,
  sessions,
  longestMs: longestMin * 60_000,
});

const state = (days: Record<string, DayStats>): GameState => ({
  prevT: null,
  prevBucket: null,
  prevIdleMs: null,
  session: null,
  days,
  sessions: [],
});

const KEYS = {
  today: '2026-08-21',
  yesterday: '2026-08-20',
  week: ['2026-08-15', '2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21'],
};

suite('retrospective', () => {
  it('reads today, yesterday and the week off the ledger', () => {
    const r = retrospective(
      state({ '2026-08-21': day(112, 3, 52), '2026-08-20': day(130, 2, 70), '2026-08-15': day(10) }),
      KEYS,
    );
    expect(r.today.sessions).toBe(3);
    expect(r.yesterday?.focusMs).toBe(130 * 60_000);
    expect(r.week).toEqual({ focusMs: 252 * 60_000, sessions: 6, daysWithFocus: 3, longestMs: 70 * 60_000 });
    expect(r.todayIsWeekBest).toBe(false);
  });

  it('calls today the week\'s best only when it is, and the week has more than one day', () => {
    expect(retrospective(state({ '2026-08-21': day(52) }), KEYS).todayIsWeekBest).toBe(false); // day one
    expect(
      retrospective(state({ '2026-08-21': day(52), '2026-08-19': day(30) }), KEYS).todayIsWeekBest,
    ).toBe(true);
    expect(
      retrospective(state({ '2026-08-21': day(52), '2026-08-19': day(90) }), KEYS).todayIsWeekBest,
    ).toBe(false);
  });

  it('cannot be made to double-count by a careless host', () => {
    const s = state({ '2026-08-21': day(30), '2026-08-20': day(45) });
    const doubled = retrospective(s, { ...KEYS, week: [...KEYS.week, '2026-08-20', '2026-08-21'] });
    expect(doubled.week.focusMs).toBe(75 * 60_000);
    expect(doubled.week.daysWithFocus).toBe(2);
    expect(retrospective(s, { ...KEYS, yesterday: KEYS.today }).yesterday).toBeNull();
  });

  it('ignores days outside the week window', () => {
    const r = retrospective(state({ '2026-08-01': day(500), '2026-08-21': day(10) }), KEYS);
    expect(r.week.focusMs).toBe(10 * 60_000);
    expect(r.week.daysWithFocus).toBe(1);
  });
});

suite('describe — the words the design contract is about', () => {
  const allLines = (days: Record<string, DayStats>) => describe(retrospective(state(days), KEYS));

  it('says the one thing the layer exists to say', () => {
    const lines = allLines({ '2026-08-21': day(112, 3, 52), '2026-08-19': day(40, 1, 40) });
    expect(lines).toContain('Focus today: 1h 52m across 3 sessions.');
    expect(lines).toContain('Longest session: 52m — your longest this week.');
  });

  it('rule 3: an empty day is a fact, never a shortfall', () => {
    const lines = allLines({});
    expect(lines).toEqual(['Nothing recorded yet today.']);
    for (const l of lines) {
      expect(l.toLowerCase()).not.toMatch(/only|just|missed|fail|behind|should|no sessions|0m/);
    }
  });

  it('rules 1, 2 and 4: never points, XP, levels, streaks, or a live "+n"', () => {
    const samples = [
      allLines({}),
      allLines({ '2026-08-21': day(1) }),
      allLines({ '2026-08-21': day(112, 3, 52), '2026-08-20': day(130, 2, 70) }),
      allLines({ '2026-08-21': day(52), '2026-08-19': day(30) }),
      allLines(Object.fromEntries(KEYS.week.map((k, i) => [k, day(30 + i, 1, 30 + i)]))),
    ];
    for (const lines of samples) {
      for (const l of lines) {
        expect(l).not.toMatch(/\bxp\b|point|level|streak|\+\d|day \d+ of|in a row|combo|bonus/i);
      }
    }
  });

  it('never shows seconds — nothing here is a stopwatch', () => {
    expect(formatDuration(30_000)).toBe('under a minute');
    expect(formatDuration(59_999)).toBe('under a minute');
    expect(formatDuration(52 * 60_000)).toBe('52m');
    expect(formatDuration(112 * 60_000)).toBe('1h 52m');
    expect(formatDuration(120 * 60_000)).toBe('2h');
  });

  it('mentions the week only once there is a week to speak of', () => {
    expect(allLines({ '2026-08-21': day(30) }).some((l) => l.startsWith('This week'))).toBe(false);
    expect(
      allLines({ '2026-08-21': day(30), '2026-08-18': day(45) }).some((l) => l.startsWith('This week')),
    ).toBe(true);
  });
});
