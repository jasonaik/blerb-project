import { describe, expect, it } from 'vitest';
import { createGame, type Game } from './session.js';
import type { Classification } from './types.js';

/**
 * A synthetic day is a complete test: the reducer sees only samples, so
 * every boundary can be walked up to the exact millisecond.
 */

const CLS: Classification = { focus: ['code', 'neovim'], elsewhere: ['slack'] };

/** UTC day key: pure, timezone-proof for tests. */
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

const T0 = Date.UTC(2026, 7, 16, 9, 0, 0); // 09:00, mid-day — no midnight nearby

function game(): Game {
  return createGame({ classification: CLS, dayKey });
}

/** Feed samples at 1s cadence from T0: [seconds, app, idleSeconds][] */
function run(g: Game, script: [number, string | null, number][]): void {
  for (const [s, app, idle] of script) {
    g.observe({ t: T0 + s * 1000, app, idleMs: idle * 1000 });
  }
}

/** n seconds of the same app with fresh input, starting at startS. */
function stretch(startS: number, n: number, app: string | null, idle = 0): [number, string | null, number][] {
  return Array.from({ length: n }, (_, i) => [startS + i, app, idle] as [number, string | null, number]);
}

describe('session segmentation', () => {
  it('a focus stretch becomes one session; neutral and elsewhere never do', () => {
    const g = game();
    run(g, [...stretch(0, 120, 'Code.exe'), ...stretch(120, 120, 'chrome'), ...stretch(240, 120, 'slack')]);
    // Force the close by sustained absence from focus.
    expect(g.state.sessions).toHaveLength(1);
    const s = g.state.sessions[0]!;
    expect(s.startT).toBe(T0);
    expect(s.endT).toBe(T0 + 119_000); // last focus foreground moment
  });

  it('a brief switch away does not end the session', () => {
    const g = game();
    run(g, [
      ...stretch(0, 100, 'code'),
      ...stretch(100, 30, 'chrome'), // 30s away — under the 60s sustain
      ...stretch(130, 100, 'code'),
      ...stretch(230, 90, 'slack'), // sustained: ends it
    ]);
    expect(g.state.sessions).toHaveLength(1);
    expect(g.state.sessions[0]!.endT).toBe(T0 + 229_000);
    // The 30s detour is wall-time inside the session but not focus time:
    // 100s + 100s of code, counting the interval INTO each first away sample.
    expect(g.state.sessions[0]!.focusMs).toBe(200_000);
  });

  it('the sustained-exit boundary is exactly 60s at the other bucket', () => {
    // The clock anchors at the FIRST sample away (t=100); 60s elapse at t=160.
    const just = game();
    run(just, [...stretch(0, 100, 'code'), ...stretch(100, 61, 'chrome')]);
    expect(just.state.sessions).toHaveLength(1); // t=160: 60s reached → closed
    expect(just.state.sessions[0]!.endT).toBe(T0 + 99_000);

    const under = game();
    run(under, [...stretch(0, 100, 'code'), ...stretch(100, 60, 'chrome'), [160, 'code', 0]]);
    expect(under.state.sessions).toHaveLength(0); // back at 59s away → still open
    expect(under.state.session).not.toBeNull();
  });

  it('READING: 60-89s of idle at the focus app ends nothing', () => {
    // The characteristic failure of idle-based detectors is punishing the
    // person quietly thinking (CLAUDE.md §8). Between the away threshold
    // (60s) and the session-end threshold (90s), the session stays open.
    const g = game();
    run(g, [
      ...stretch(0, 100, 'code'),
      // Input stops; idle climbs to 85s while code stays foregrounded.
      ...Array.from({ length: 85 }, (_, i) => [100 + i, 'code', i] as [number, string | null, number]),
      ...stretch(185, 100, 'code'), // typing again
      ...stretch(285, 61, 'slack'),
    ]);
    expect(g.state.sessions).toHaveLength(1); // ONE unbroken session
    expect(g.state.sessions[0]!.endT).toBe(T0 + 284_000);
  });

  it('an idle gap of 90s ends the session at the moment input stopped', () => {
    const g = game();
    run(g, [
      ...stretch(0, 100, 'code'),
      ...Array.from({ length: 95 }, (_, i) => [100 + i, 'code', i] as [number, string | null, number]),
    ]);
    expect(g.state.sessions).toHaveLength(1);
    // Input stopped at second 100 (the sample where idle began counting).
    expect(g.state.sessions[0]!.endT).toBe(T0 + 100_000);
  });

  it('switching to chat and THEN idling does not credit the chat tail', () => {
    const g = game();
    run(g, [
      ...stretch(0, 100, 'code'),
      ...stretch(100, 30, 'slack'), // left focus at 99s, active on slack
      // then walks away: idle climbs past 90 while slack is foregrounded
      ...Array.from({ length: 95 }, (_, i) => [130 + i, 'slack', i] as [number, string | null, number]),
    ]);
    expect(g.state.sessions).toHaveLength(1);
    expect(g.state.sessions[0]!.endT).toBe(T0 + 99_000); // when focus was left
  });

  it('READING then a glance: the pause does not pre-charge the exit clock', () => {
    // Idle 60-89s at focus is tolerated — but it used to stop lastFocusT,
    // so a 30s glance at chat afterwards closed the session as if the user
    // had been gone 90s. The exit clock must time from the start of the
    // contiguous at-another-app stretch.
    const g = game();
    run(g, [
      ...stretch(0, 100, 'code'),
      ...Array.from({ length: 89 }, (_, i) => [100 + i, 'code', i] as [number, string | null, number]),
      ...stretch(189, 59, 'chrome'), // 59s glance — under the allowance
      ...stretch(248, 100, 'code'),
      ...stretch(348, 61, 'slack'),
    ]);
    expect(g.state.sessions).toHaveLength(1); // ONE session, glance survived
  });

  it('a present user at an unreadable app is elsewhere, not away', () => {
    // win32 returns null for protected processes (anti-cheat games, secure
    // desktop). Active input + null app used to alias to 'away', where
    // NEITHER close rule could fire — a two-hour game bridged into one
    // giant session.
    const g = game();
    run(g, [
      ...stretch(0, 120, 'code'),
      ...stretch(120, 120, null), // present the whole time: idle 0
      ...stretch(240, 120, 'code'),
      ...stretch(360, 61, 'slack'),
    ]);
    expect(g.state.sessions).toHaveLength(2);
    expect(g.state.sessions[0]!.endT).toBe(T0 + 119_000);
    // A SHORT null blip must still bridge (UAC prompt, window transition).
    const h = game();
    run(h, [
      ...stretch(0, 120, 'code'),
      ...stretch(120, 30, null),
      ...stretch(150, 120, 'code'),
      ...stretch(270, 61, 'slack'),
    ]);
    expect(h.state.sessions).toHaveLength(1);
  });

  it('null samples accrue no ledger minutes', () => {
    const g = game();
    run(g, [...stretch(0, 60, 'code'), ...stretch(60, 120, null), ...stretch(180, 61, 'slack')]);
    const d = g.day(T0);
    expect(d.focusMs + d.neutralMs + d.elsewhereMs).toBeLessThanOrEqual(121_000);
  });

  it('a backwards clock step cannot shrink or erase a session', () => {
    const g = game();
    run(g, stretch(0, 600, 'code')); // 10 minutes of focus
    // NTP steps the clock back 5 minutes: treated like a sample gap — the
    // session closes with its pre-step span, and a new timebase begins.
    g.observe({ t: T0 + 300_000, app: 'code', idleMs: 0 });
    expect(g.state.sessions).toHaveLength(1);
    const s = g.state.sessions[0]!;
    expect(s.endT).toBe(T0 + 599_000);
    expect(s.endT).toBeGreaterThan(s.startT);
  });

  it('a sleep gap while reading closes at the last INPUT, like the idle rule would', () => {
    // Typing stops at t=100; reading until t=158 (idle 58s); lid closes.
    // The same physical timeline ended by staying awake records endT=100s —
    // the gap path must agree.
    const g = game();
    run(g, [
      ...stretch(0, 100, 'code'),
      ...Array.from({ length: 59 }, (_, i) => [100 + i, 'code', i] as [number, string | null, number]),
    ]);
    g.observe({ t: T0 + 7_200_000, app: 'code', idleMs: 0 });
    expect(g.state.sessions).toHaveLength(1);
    expect(g.state.sessions[0]!.endT).toBe(T0 + 100_000);
  });

  it('focus taps under a minute are not sessions', () => {
    const g = game();
    run(g, [...stretch(0, 30, 'code'), ...stretch(30, 120, 'chrome')]);
    expect(g.state.sessions).toHaveLength(0);
    expect(g.day(T0).sessions).toBe(0);
  });

  it('a sample gap (sleep, quit) ends the session where the samples stopped', () => {
    const g = game();
    run(g, stretch(0, 120, 'code'));
    g.observe({ t: T0 + 3_600_000, app: 'code', idleMs: 0 }); // an hour later
    expect(g.state.sessions).toHaveLength(1);
    expect(g.state.sessions[0]!.endT).toBe(T0 + 119_000);
    // And no minutes accrued across the gap.
    expect(g.day(T0).focusMs).toBeLessThan(125_000);
  });
});

describe('the day ledger', () => {
  it('attributes elapsed time to the previous bucket, and away to nothing', () => {
    const g = game();
    run(g, [
      ...stretch(0, 60, 'code'),
      ...stretch(60, 60, 'chrome'),
      ...stretch(120, 60, 'slack'),
      // away: idle over 60s
      ...Array.from({ length: 60 }, (_, i) => [180 + i, 'slack', 61 + i] as [number, string | null, number]),
    ]);
    const d = g.day(T0);
    expect(d.focusMs).toBe(60_000);
    expect(d.neutralMs).toBe(60_000);
    // elsewhere accrues while present; the away stretch starts at 61s idle,
    // so presence lapsed exactly at its first sample.
    expect(d.elsewhereMs).toBe(60_000);
    expect(d.focusMs + d.neutralMs + d.elsewhereMs).toBeLessThan(240_000);
  });

  it('books a midnight-straddling session to the day it STARTED', () => {
    // Minutes accrue to the day each interval ends in; the session record
    // books to its start day. A straddler can therefore give its start day
    // a longestMs bigger than that day's focusMs — accepted, documented in
    // closeSession, pinned here so nobody "fixes" one side silently.
    const NIGHT = Date.UTC(2026, 7, 16, 23, 58, 0);
    const g = game();
    for (let s = 0; s < 240; s++) g.observe({ t: NIGHT + s * 1000, app: 'code', idleMs: 0 });
    for (let s = 240; s < 301; s++) g.observe({ t: NIGHT + s * 1000, app: 'slack', idleMs: 0 });
    const day1 = g.day(NIGHT);
    const day2 = g.day(NIGHT + 240_000);
    expect(day1.sessions).toBe(1);
    expect(day1.longestMs).toBe(239_000); // full span, booked to the start day
    expect(day2.sessions).toBe(0);
    expect(day1.focusMs + day2.focusMs).toBe(240_000); // minutes split at midnight
  });

  it('counts sessions and the longest per day', () => {
    const g = game();
    run(g, [
      ...stretch(0, 300, 'code'),
      ...stretch(300, 61, 'slack'),
      ...stretch(361, 120, 'code'),
      ...stretch(481, 61, 'slack'),
    ]);
    const d = g.day(T0);
    expect(d.sessions).toBe(2);
    expect(d.longestMs).toBe(299_000);
  });
});

describe('determinism and privacy', () => {
  it('same samples, same config → byte-identical state', () => {
    const script: [number, string | null, number][] = [
      ...stretch(0, 100, 'Code.exe'),
      ...stretch(100, 45, null),
      ...stretch(145, 100, 'code'),
      ...stretch(245, 70, 'C:\\\\Program Files\\\\Slack\\\\slack.exe'),
    ];
    const a = game();
    const b = game();
    run(a, script);
    run(b, script);
    expect(JSON.stringify(a.serialize())).toBe(JSON.stringify(b.serialize()));
  });

  it('a hostile full-path app name never reaches state', () => {
    const g = game();
    run(g, stretch(0, 120, 'C:\\\\Users\\\\Jason Aik\\\\secret project\\\\Code.exe'));
    run(g, stretch(120, 61, 'slack'));
    const json = JSON.stringify(g.serialize());
    expect(json).not.toContain('\\\\');
    expect(json).not.toContain('/');
    expect(json.toLowerCase()).not.toContain('jason');
    expect(json.toLowerCase()).not.toContain('.exe');
    // And the session still counted — the path normalized to a focus app.
    expect(g.state.sessions).toHaveLength(1);
  });

  it('state holds no app names at all — only buckets and numbers', () => {
    // The privacy contract by SHAPE: {bucket, minutes}, sessions, nothing else.
    const g = game();
    run(g, [...stretch(0, 120, 'code'), ...stretch(120, 61, 'chrome')]);
    const json = JSON.stringify(g.serialize());
    expect(json).not.toContain('code');
    expect(json).not.toContain('chrome');
  });
});
