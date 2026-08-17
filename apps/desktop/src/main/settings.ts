import { app } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
  pack: 'blob',
  classification: { focus: [], elsewhere: [] },
};

const file = () => join(app.getPath('userData'), 'settings.json');

/**
 * classification is hand-edited JSON for now, so wrong types are the EXPECTED
 * input: a string where an array belongs, null, a stray number in the list.
 * Anything that isn't a string array degrades to the empty list rather than
 * throwing once a second inside the observer's poll.
 */
const strList = (x: unknown): string[] =>
  Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [];

export function sanitizeClassification(x: unknown): Settings['classification'] {
  const c = (x ?? {}) as Record<string, unknown>;
  return { focus: strList(c['focus']), elsewhere: strList(c['elsewhere']) };
}

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Settings>;
    const s = { ...DEFAULTS, ...raw };
    s.classification = sanitizeClassification(raw.classification ?? DEFAULTS.classification);
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
