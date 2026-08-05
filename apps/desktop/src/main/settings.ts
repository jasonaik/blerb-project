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
  petScale: 2,
  pack: 'blob',
};

const file = () => join(app.getPath('userData'), 'settings.json');

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Settings>;
    return { ...DEFAULTS, ...raw };
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
