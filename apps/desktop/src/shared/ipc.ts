import type { PetState, World } from '@blerb/core';

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
  /** Cling to and climb the outer edges of the desktop. */
  climbing: boolean;
  /** Hang upside down under window top edges and the top of the screen. */
  hanging: boolean;
  /**
   * Resample the desktop at ~60/s while a window is being dragged or resized,
   * so the pet rides it smoothly instead of catching up three times a second.
   * Costs about 1% of one core, and only while something is actually moving.
   */
  smoothTracking: boolean;
  /** Display scale multiplier for the sprite. 32px art at 2 → 64px on screen. */
  petScale: number;
  /** Pack directory name under packs/. */
  pack: string;
  /**
   * User-owned app lists by process basename (case-insensitive, .exe
   * optional). `elsewhere` ships EMPTY on purpose — nothing is pre-labelled
   * as bad. Unlisted apps are neutral. Hand-edit settings.json for now; a UI
   * comes with the game layer.
   */
  classification: { focus: string[]; elsewhere: string[] };
}

export interface OverlayInit {
  /** Forward slashes, absolute. */
  packDir: string;
  /**
   * This window's display origin in global DIP coordinates. The pet's position
   * is global; the renderer subtracts this to draw. That's what lets a pet
   * straddling two monitors be drawn correctly by both windows at once.
   */
  origin: { x: number; y: number };
  world: World;
  state: PetState;
  settings: Settings;
}

export type OverlayCommand = { name: 'recenter' | 'sleep' | 'wake' };

export const CH = {
  overlayInit: 'overlay:init',
  overlayMenu: 'overlay:menu',
  /** Renderer holds the click-through latch open while dragging the pet. */
  overlayDrag: 'overlay:drag',
  /** Pointer position in GLOBAL DIP, for drag-and-drop placement. */
  overlayPlace: 'overlay:place',
  fsRead: 'fs:read',
  world: 'world',
  petState: 'pet:state',
  visibility: 'visibility',
  command: 'command',
  settingsChanged: 'settings:changed',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  appQuit: 'app:quit',
} as const;
