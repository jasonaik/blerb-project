import { BrowserWindow, type Display } from 'electron';
import { join } from 'node:path';

/**
 * The overlay window. Every option here traces to the constraints table in
 * CLAUDE.md §2 — change one and something specific breaks:
 *
 *   transparent+frameless        the whole point
 *   display.bounds, not workArea the pet must be able to overlay the taskbar
 *   'screen-saver' level         'floating'..'status' sit BELOW the taskbar
 *   focusable:false              never steals focus; also drops it from Alt-Tab
 *   skipTaskbar                  no taskbar button
 *   backgroundThrottling:false + CalculateNativeWinOcclusion disabled in
 *                                main.ts — Windows occlusion tracking decides a
 *                                transparent overlay is "covered" whenever a
 *                                maximized window is under it and freezes RAF
 */

export interface OverlayOptions {
  contentProtection: boolean;
}

export function createOverlayWindow(display: Display, opts: OverlayOptions): BrowserWindow {
  const b = display.bounds;

  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload', 'overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setContentProtection(opts.contentProtection);

  // Forwarding silently stops after a renderer reload (electron#15376).
  win.webContents.on('did-finish-load', () => {
    win.setIgnoreMouseEvents(true, { forward: true });
  });

  // Some apps grab topmost for themselves; quietly take it back. Re-asserting
  // also restores content protection after hide/show (electron#29085).
  const reassert = setInterval(() => {
    if (win.isDestroyed()) return clearInterval(reassert);
    win.setAlwaysOnTop(true, 'screen-saver');
  }, 10_000);
  win.on('closed', () => clearInterval(reassert));

  void win.loadFile(join(__dirname, 'renderer', 'overlay.html'));
  return win;
}

export function createSettingsWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 420,
    height: 640,
    resizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    title: 'blerb',
    webPreferences: {
      preload: join(__dirname, 'preload', 'settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  void win.loadFile(join(__dirname, 'renderer', 'settings.html'));
  return win;
}
