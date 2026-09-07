import { describe, expect, it } from 'vitest';
import { createGame, type Game } from './session.js';
import { hydrate, pruneDays } from './persist.js';
import type { Classification } from './types.js';

const CLS: Classification = { focus: ['code'], elsewhere: [] };
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
const T0 = Date.UTC(2026, 7, 16, 9, 0, 0);

function focusFor(g: Game, startS: number, n: number): void {
  for (let i = 0; i < n; i++) g.observe({ t: T0 + (startS + i) * 1000, app: 'code', idleMs: 0 });
}

describe('hydrate', () => {
  it('round-trips a serialized state exactly', () => {
    const g = createGame({ classification: CLS, dayKey });
    focusFor(g, 0, 200);
    const saved = JSON.parse(JSON.stringify(g.serialize()));
    expect(hydrate(saved)).toEqual(g.serialize());
  });

  it('refuses anything that is not the shape, rather than guessing', () => {
    expect(hydrate(null)).toBeNull();
    expect(hydrate('{}')).toBeNull();
    expect(hydrate({})).toBeNull();
    expect(hydrate({ prevT: 'yesterday', prevBucket: null, prevIdleMs: null, session: null, days: {}, sessions: [] })).toBeNull();
    expect(hydrate({ prevT: null, prevBucket: 'lunch', prevIdleMs: null, session: null, days: {}, sessions: [] })).toBeNull();
    expect(hydrate({ prevT: null, prevBucket: null, prevIdleMs: null, session: null, days: 'many', sessions: [] })).toBeNull();
    expect(hydrate({ prevT: null, prevBucket: null, prevIdleMs: null, session: null, days: {}, sessions: 'some' })).toBeNull();
    expect(hydrate({ prevT: null, prevBucket: null, prevIdleMs: null, session: null, days: {}, sessions: [] })).not.toBeNull();
  });

  it('drops a corrupt day or session record instead of voiding ninety good days', () => {
    const good = { focusMs: 60_000, neutralMs: 0, elsewhereMs: 0, sessions: 1, longestMs: 60_000 };
    const h = hydrate({
      prevT: null,
      prevBucket: null,
      prevIdleMs: null,
      session: null,
      days: { '2026-08-15': good, '2026-08-16': { focusMs: 'a lot' } },
      sessions: [{ startT: 1, endT: 2, focusMs: 1 }, { startT: 'noon' }],
    });
    expect(h).not.toBeNull();
    expect(Object.keys(h!.days)).toEqual(['2026-08-15']);
    expect(h!.sessions).toHaveLength(1);
  });

  it('drops keys it does not know, so nothing can ride along in the file', () => {
    const h = hydrate({
      prevT: null,
      prevBucket: null,
      prevIdleMs: null,
      session: null,
      days: { '2026-08-16': { focusMs: 1, neutralMs: 0, elsewhereMs: 0, sessions: 0, longestMs: 0, note: 'x' } },
      sessions: [],
      windowTitle: 'secret.docx',
    });
    expect(JSON.stringify(h)).not.toContain('secret');
    expect(JSON.stringify(h)).not.toContain('note');
  });
});

describe('resuming', () => {
  it('continues the ledger where it left off', () => {
    const a = createGame({ classification: CLS, dayKey });
    focusFor(a, 0, 120);
    const b = createGame({ classification: CLS, dayKey, initial: a.serialize() });
    focusFor(b, 121, 120);
    expect(b.day(T0).focusMs).toBeGreaterThanOrEqual(238_000);
  });

  it('a session left open at shutdown is closed where the samples stopped, by the gap rule', () => {
    const a = createGame({ classification: CLS, dayKey });
    focusFor(a, 0, 120); // open session, 2 minutes in
    expect(a.state.session).not.toBeNull();

    const b = createGame({ classification: CLS, dayKey, initial: a.serialize() });
    // An hour later, the app is back and the user is at a focus app.
    b.observe({ t: T0 + 3_600_000, app: 'code', idleMs: 0 });
    expect(b.state.sessions).toHaveLength(1);
    expect(b.state.sessions[0]!.endT).toBe(T0 + 119_000);
    // And a NEW session has begun — the hour away is not credited to anything.
    expect(b.state.session?.startT).toBe(T0 + 3_600_000);
    expect(b.day(T0).focusMs).toBeLessThan(200_000);
  });

  it('the initial state is copied, not aliased', () => {
    const a = createGame({ classification: CLS, dayKey });
    focusFor(a, 0, 10);
    const snapshot = a.serialize();
    const b = createGame({ classification: CLS, dayKey, initial: snapshot });
    focusFor(b, 11, 10);
    expect(snapshot.prevT).toBe(T0 + 9000);
  });
});

describe('pruneDays', () => {
  it('drops days the host no longer wants and leaves everything else intact', () => {
    const g = createGame({ classification: CLS, dayKey });
    focusFor(g, 0, 120);
    const s = g.serialize();
    s.days['2020-01-01'] = { focusMs: 1, neutralMs: 0, elsewhereMs: 0, sessions: 0, longestMs: 0 };
    const pruned = pruneDays(s, (k) => k >= '2026-01-01');
    expect(Object.keys(pruned.days)).toEqual(['2026-08-16']);
    expect(pruned.session).toEqual(s.session);
    expect(s.days['2020-01-01']).toBeDefined(); // input untouched
  });
});
