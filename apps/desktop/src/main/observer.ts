/**
 * The observation adapter: samples the two signals (foreground basename,
 * coarse idle) once a second and feeds them to the pure @blerb/game reducer.
 *
 * Nothing here persists anything. Phase 5 is observe-and-log: the point is to
 * watch session boundaries land where a human would say they land, for a real
 * day or two, before any state is saved or any pet behavior hangs off it.
 * BLERB_DEBUG=1 narrates transitions; without it this is silent.
 */

import { bucketOf, createGame, type Classification, type Game } from '@blerb/game';
import * as win32 from './win32';

/** Local-timezone day key. The reducer is timezone-agnostic; this is not. */
export function localDayKey(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface Observer {
  readonly game: Game;
  setClassification(cls: Classification): void;
  stop(): void;
}

export function startObserver(classification: Classification, intervalMs = 1000): Observer {
  let cls = classification;
  const game = createGame({ classification, dayKey: localDayKey });
  const debug = Boolean(process.env.BLERB_DEBUG);

  let lastApp: string | null = null;
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
  }, intervalMs);

  return {
    game,
    setClassification(next) {
      cls = next;
      game.setClassification(next);
    },
    stop() {
      clearInterval(timer);
    },
  };
}
