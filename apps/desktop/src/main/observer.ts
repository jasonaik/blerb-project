/**
 * The observation adapter: samples the two signals (foreground basename,
 * coarse idle) once a second and feeds them to the pure @blerb/game reducer.
 *
 * Nothing here persists anything. Phase 5 is observe-and-log: the point is to
 * watch session boundaries land where a human would say they land, for a real
 * day or two, before any state is saved or any pet behavior hangs off it.
 * BLERB_DEBUG=1 narrates transitions; without it this is silent.
 */

import { bucketOf, createGame, type Classification, type Game, type GameState } from '@blerb/game';
import * as win32 from './win32';

/** Local-timezone day key. The reducer is timezone-agnostic; this is not. */
export function localDayKey(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The day key `k` calendar days before `t` — stepped on the LOCAL calendar,
 * not by subtracting 24h multiples. A DST day is 23 or 25 hours long, so
 * `t - k * 86_400_000` lands an hour off the wall clock and, crossing a
 * transition, either repeats a key or skips one: a week that counts one day
 * twice, or a 90-day prune cutoff that is a day early.
 */
export function localDayKeyAgo(t: number, k: number): string {
  const d = new Date(t);
  d.setDate(d.getDate() - k);
  return localDayKey(d.getTime());
}

export interface Observer {
  readonly game: Game;
  setClassification(cls: Classification): void;
  /**
   * The last foreground process basename that was not blerb itself — so the
   * settings window can offer "add <this> to focus apps" without the user
   * having to guess how a program spells its own exe. In memory only; the
   * game state cannot hold it and the file never sees it.
   */
  currentApp(): string | null;
  stop(): void;
}

export interface ObserverOptions {
  intervalMs?: number;
  /** A saved ledger to resume from (gameStore.ts). */
  initial?: GameState | null;
}

/** Our own process, as the foreground poll sees it — dev and packaged. */
const OWN_APPS = new Set(['electron', 'blerb']);

export function startObserver(classification: Classification, opts: ObserverOptions = {}): Observer {
  let cls = classification;
  const game = createGame({ classification, dayKey: localDayKey, initial: opts.initial ?? undefined });
  const debug = Boolean(process.env.BLERB_DEBUG);

  let lastApp: string | null = null;
  let lastForeignApp: string | null = null;
  let lastAway = false;
  let hadSession = false;
  // Closes are detected by TAIL IDENTITY, not array length — the sessions
  // list is capped, and once full its length never changes again.
  let lastEndT = -Infinity;

  const timer = setInterval(() => {
    const t = Date.now();
    const app = win32.foregroundApp();
    const idle = win32.idleMs();
    game.observe({ t, app, idleMs: idle });
    if (app && !OWN_APPS.has(app.toLowerCase())) lastForeignApp = app;

    if (!debug) return;

    // Narrate transitions only — this log is the Phase 5 deliverable.
    const away = idle >= 60_000;
    if (app !== lastApp) {
      console.log(`[obs] fg=${app ?? '(none)'} bucket=${app ? bucketOf(app, cls) : '-'}`);
      lastApp = app;
    }
    if (away !== lastAway) {
      console.log(away ? `[obs] away (idle ${Math.round(idle / 1000)}s)` : '[obs] back');
      lastAway = away;
    }
    const inSession = game.state.session !== null;
    if (inSession && !hadSession) {
      console.log('[obs] session started');
    }
    const tail = game.state.sessions[game.state.sessions.length - 1];
    if (tail && tail.endT > lastEndT) {
      const min = Math.round((tail.endT - tail.startT) / 60_000);
      const d = game.day(tail.startT);
      console.log(
        `[obs] session ended: ${min}m (focus ${Math.round(tail.focusMs / 60_000)}m) — ` +
          `today: ${d.sessions} session(s), longest ${Math.round(d.longestMs / 60_000)}m`,
      );
      lastEndT = tail.endT;
    } else if (!inSession && hadSession) {
      console.log('[obs] session discarded (under a minute — a tap, not a session)');
    }
    hadSession = inSession;
  }, opts.intervalMs ?? 1000);

  return {
    game,
    setClassification(next) {
      cls = next;
      game.setClassification(next);
    },
    currentApp: () => lastForeignApp,
    stop() {
      clearInterval(timer);
    },
  };
}
