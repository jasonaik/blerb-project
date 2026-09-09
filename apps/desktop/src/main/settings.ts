import { app } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { normalizeApp } from '@blerb/game';
import type { Settings } from '../shared/ipc';

export const DEFAULTS: Settings = {
  petVisible: true,
  captureProtection: true,
  debugOverlay: false,
  launchAtLogin: false,
  climbing: true,
  hanging: true,
  smoothTracking: true,
  petScale: 2,
  activity: 0.7,
  pack: 'blob',
  classification: { focus: [], elsewhere: [] },
};

/**
 * A number in [0, 1], or the fallback. settings.json is hand-editable and
 * the IPC patch is untrusted, so a string, NaN or 70 (percent, not a share)
 * must not reach the sim — the walk weight is derived by division on it.
 */
export function unitInterval(x: unknown, fallback: number): number {
  return typeof x === 'number' && Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : fallback;
}

const file = () => join(app.getPath('userData'), 'settings.json');

/** Whether a settings file exists yet — false means this is the first run. */
export function settingsFileExists(): boolean {
  try {
    readFileSync(file());
    return true;
  } catch {
    return false;
  }
}

/**
 * classification is hand-edited JSON for now, so wrong types are the EXPECTED
 * input: a string where an array belongs, null, a stray number in the list.
 * Anything that isn't a string array degrades to the empty list rather than
 * throwing once a second inside the observer's poll.
 */
// Normalized at the persistence boundary — the same normalizeApp the reducer
// applies to what it observes — so a pasted "C:\...\Code.exe" is stored as
// "code", not as a path in settings.json (§11), and matches the way the
// observer reports the same program back.
const strList = (x: unknown): string[] =>
  Array.isArray(x)
    ? [...new Set(x.filter((s): s is string => typeof s === 'string').map(normalizeApp).filter(Boolean))]
    : [];

export function sanitizeClassification(x: unknown): Settings['classification'] {
  const c = (x ?? {}) as Record<string, unknown>;
  return { focus: strList(c['focus']), elsewhere: strList(c['elsewhere']) };
}

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Settings>;
    const s = { ...DEFAULTS, ...raw };
    s.classification = sanitizeClassification(raw.classification ?? DEFAULTS.classification);
    s.activity = unitInterval(raw.activity, DEFAULTS.activity);
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

/** Atomic: temp + rename, so a crash mid-write can't corrupt the file. */
export function saveSettings(s: Settings): void {
  const f = file();
  mkdirSync(dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, f);
}
