import { app } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hydrate, KEEP_DAYS, pruneDays, type GameState } from '@blerb/game';
import { localDayKeyAgo } from './observer';

/**
 * The ledger on disk: `%APPDATA%\blerb-desktop\game.json`.
 *
 * Its contents are exactly a `GameState` — {bucket, minutes} per day and
 * session lengths (CLAUDE.md §11). No app names, ever: the reducer's own test
 * pins that the state cannot hold one, and `hydrate` drops any key it does
 * not know on the way back in, so nothing can be smuggled through the file.
 */

const file = () => join(app.getPath('userData'), 'game.json');

/**
 * A missing file is a first launch. A file that exists but fails the shape
 * check is something else — a hand-edit, a half-write, a future version —
 * and it is NOT silently thrown away: it is set aside as game.json.rejected
 * and said so, because the next save would otherwise overwrite the only
 * copy of ninety days of ledger with a fresh one.
 */
export function loadGameState(): GameState | null {
  const f = file();
  let text: string;
  try {
    text = readFileSync(f, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[blerb] could not read game.json — starting a fresh ledger:', err);
    }
    return null;
  }
  let state: GameState | null = null;
  try {
    state = hydrate(JSON.parse(text));
  } catch {
    /* unparseable — handled below */
  }
  if (!state) {
    console.warn('[blerb] game.json is not a ledger — starting fresh; the old file is kept as game.json.rejected');
    try {
      renameSync(f, f + '.rejected');
    } catch {
      /* best effort */
    }
  }
  return state;
}

/** Atomic (temp + rename), pruned to KEEP_DAYS so the file never grows without bound. */
export function saveGameState(state: GameState, now = Date.now()): void {
  const cutoff = localDayKeyAgo(now, KEEP_DAYS);
  const pruned = pruneDays(state, (key) => key >= cutoff);
  const f = file();
  mkdirSync(dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  writeFileSync(tmp, JSON.stringify(pruned));
  renameSync(tmp, f);
}
