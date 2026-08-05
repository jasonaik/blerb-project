import type { World } from '@blerb/core';

/**
 * The IPC contract between main, the overlay renderer, and the settings page.
 * Everything here must survive structured clone — no functions, no classes.
 */

export interface Settings {
  petVisible: boolean;
  /** setContentProtection — invisible to screen capture/shares. Default on. */
  captureProtection: boolean;
  debugOverlay: boolean;
  launchAtLogin: boolean;
  /** Display scale multiplier for the sprite. 32px art at 2 → 64px on screen. */
  petScale: number;
  /** Pack directory name under packs/. */
  pack: string;
}

export interface OverlayInit {
  /** Forward slashes, absolute. */
  packDir: string;
  world: World;
  settings: Settings;
}

/** Pet bounds in overlay-local CSS px. Renderer → main, drives click-through. */
export interface PetBbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type OverlayCommand = { name: 'recenter' | 'sleep' | 'wake' };

export const CH = {
  overlayInit: 'overlay:init',
  overlayBbox: 'overlay:bbox',
  overlayMenu: 'overlay:menu',
  /** Renderer holds the click-through latch open while dragging the pet. */
  overlayDrag: 'overlay:drag',
  fsRead: 'fs:read',
  world: 'world',
  visibility: 'visibility',
  command: 'command',
  settingsChanged: 'settings:changed',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  appQuit: 'app:quit',
} as const;
