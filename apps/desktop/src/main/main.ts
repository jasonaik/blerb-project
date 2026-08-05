import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, Tray } from 'electron';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { World } from '@blerb/core';
import { CH, type OverlayCommand, type PetBbox, type Settings } from '../shared/ipc';
import { loadSettings, saveSettings } from './settings';
import { createScanner, fallbackWorld, type Scanner } from './scanner';
import { createOverlayWindow, createSettingsWindow } from './windows';

/**
 * Env toggles (dev/diagnostics):
 *   BLERB_SOFTWARE=1        disable GPU compositing (the Spike A fallback)
 *   BLERB_ALLOW_CAPTURE=1   let screen capture see the pet (for automated
 *                           verification — capture-protection is default ON)
 */

// Windows occlusion tracking treats a fully-transparent always-on-top window
// as occluded whenever a maximized window sits under it, which stops RAF in
// the renderer and freezes the pet. Known Electron-overlay requirement.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

if (process.env.BLERB_SOFTWARE) app.disableHardwareAcceleration();

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// Dev layout: app path is apps/desktop, packs live at the repo root.
const repoRoot = resolve(app.getAppPath(), '..', '..');
const packsRoot = join(repoRoot, 'packs');

let settings = loadSettings();
let overlay: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let scanner: Scanner | null = null;

let lastWorld: World | null = null;
let petBbox: PetBbox | null = null;
let dragLatch = false;
let cursorInside = false;
let hiddenByFullscreen = false;
let quitting = false;

const effectiveProtection = () =>
  settings.captureProtection && !process.env.BLERB_ALLOW_CAPTURE;

// ---------------------------------------------------------------- visibility

function pushVisibility(): void {
  if (!overlay) return;
  const hidden = !settings.petVisible || hiddenByFullscreen;
  if (hidden && overlay.isVisible()) overlay.hide();
  if (!hidden && !overlay.isVisible()) {
    overlay.showInactive();
    // Content protection can drop across hide/show (electron#29085).
    overlay.setContentProtection(effectiveProtection());
  }
  overlay.webContents.send(CH.visibility, {
    hidden,
    reason: hiddenByFullscreen ? 'fullscreen' : 'manual',
  });
}

// ------------------------------------------------------------------ settings

function applySettings(patch: Partial<Settings>): Settings {
  settings = { ...settings, ...patch };
  saveSettings(settings);

  if ('petVisible' in patch) pushVisibility();
  if ('captureProtection' in patch) overlay?.setContentProtection(effectiveProtection());
  if ('launchAtLogin' in patch) app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });

  overlay?.webContents.send(CH.settingsChanged, settings);
  settingsWin?.webContents.send(CH.settingsChanged, settings);
  rebuildTrayMenu();
  return settings;
}

// ---------------------------------------------------------------------- tray

function trayTemplate(): Electron.MenuItemConstructorOptions[] {
  return [
    {
      label: 'Pet visible',
      type: 'checkbox',
      checked: settings.petVisible,
      click: (item) => applySettings({ petVisible: item.checked }),
    },
    {
      label: 'Invisible in screen capture',
      type: 'checkbox',
      checked: settings.captureProtection,
      click: (item) => applySettings({ captureProtection: item.checked }),
    },
    {
      label: 'Debug overlay',
      type: 'checkbox',
      checked: settings.debugOverlay,
      click: (item) => applySettings({ debugOverlay: item.checked }),
    },
    { type: 'separator' },
    {
      label: 'Recenter pet',
      click: () => overlay?.webContents.send(CH.command, { name: 'recenter' } satisfies OverlayCommand),
    },
    { label: 'Settings…', click: openSettings },
    { type: 'separator' },
    { label: 'Quit blerb', click: quit },
  ];
}

function rebuildTrayMenu(): void {
  tray?.setContextMenu(Menu.buildFromTemplate(trayTemplate()));
}

function createTray(): void {
  const icon = nativeImage
    .createFromPath(join(packsRoot, settings.pack, 'atlas.png'))
    .crop({ x: 0, y: 0, width: 32, height: 32 })
    .resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('blerb');
  rebuildTrayMenu();
  tray.on('double-click', openSettings);
}

// ----------------------------------------------------------------- windows

function openSettings(): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  settingsWin = createSettingsWindow();
  settingsWin.on('closed', () => (settingsWin = null));
}

function spawnOverlay(): void {
  overlay = createOverlayWindow(screen.getPrimaryDisplay(), {
    contentProtection: effectiveProtection(),
  });

  overlay.webContents.on('console-message', (_e, _level, message) => {
    console.log('[overlay]', message);
  });

  overlay.webContents.on('did-finish-load', () => pushVisibility());
  overlay.on('closed', () => {
    overlay = null;
    if (!quitting) quit();
  });
}

function refitOverlay(): void {
  if (!overlay) return;
  overlay.setBounds(screen.getPrimaryDisplay().bounds);
  scanner?.force();
}

// ------------------------------------------------------- cursor / clickthrough

/**
 * The click-through hit test. Main-process cursor polling is the source of
 * truth — DOM mousemove forwarding silently dies when Task Manager has focus
 * (electron#33281, WONTFIX), so the renderer's own events can't be trusted
 * for this. 30Hz is imperceptible for a hover boundary and costs ~nothing.
 */
function startCursorWatcher(): void {
  setInterval(() => {
    if (!overlay || overlay.isDestroyed() || !overlay.isVisible()) return;
    if (dragLatch) return; // renderer owns the mouse until pointerup

    let inside = false;
    if (petBbox) {
      const p = screen.getCursorScreenPoint(); // DIP
      const d = screen.getPrimaryDisplay().bounds;
      const x = p.x - d.x;
      const y = p.y - d.y;
      inside =
        x >= petBbox.x && x <= petBbox.x + petBbox.w && y >= petBbox.y && y <= petBbox.y + petBbox.h;
    }

    if (inside !== cursorInside) {
      cursorInside = inside;
      if (inside) overlay.setIgnoreMouseEvents(false);
      else overlay.setIgnoreMouseEvents(true, { forward: true });
    }
  }, 33);
}

// ----------------------------------------------------------------------- ipc

function registerIpc(): void {
  ipcMain.handle(CH.overlayInit, () => ({
    packDir: join(packsRoot, settings.pack).replace(/\\/g, '/'),
    world: lastWorld ?? fallbackWorld(),
    settings,
  }));

  // Reads are restricted to the packs directory — the renderer needs sprite
  // assets and nothing else from disk.
  ipcMain.handle(CH.fsRead, async (_e, p: string) => {
    const rp = resolve(String(p));
    if (!rp.startsWith(resolve(packsRoot) + sep)) throw new Error('read outside packs/ denied');
    return readFile(rp);
  });

  ipcMain.on(CH.overlayBbox, (_e, b: PetBbox) => {
    petBbox = b;
  });

  ipcMain.on(CH.overlayDrag, (_e, active: boolean) => {
    dragLatch = active;
    if (!active) {
      // Hand the mouse back; the watcher re-evaluates on its next tick.
      cursorInside = false;
      overlay?.setIgnoreMouseEvents(true, { forward: true });
    }
  });

  ipcMain.on(CH.overlayMenu, () => {
    Menu.buildFromTemplate(trayTemplate()).popup();
  });

  ipcMain.handle(CH.settingsGet, () => settings);
  ipcMain.handle(CH.settingsSet, (_e, patch: Partial<Settings>) => applySettings(patch));
  ipcMain.on(CH.appQuit, quit);
}

// ---------------------------------------------------------------- lifecycle

function quit(): void {
  quitting = true;
  scanner?.stop();
  tray?.destroy();
  app.quit();
}

void app.whenReady().then(() => {
  registerIpc();
  spawnOverlay();
  createTray();
  startCursorWatcher();

  scanner = createScanner({
    onWorld: (world) => {
      lastWorld = world;
      overlay?.webContents.send(CH.world, world);
    },
    onFullscreen: (fs) => {
      if (fs !== hiddenByFullscreen) {
        hiddenByFullscreen = fs;
        pushVisibility();
      }
    },
  });
  // The overlay covers the whole display, so without this it looks like a
  // perfectly good full-width ledge and the pet tries to stand on itself.
  if (overlay) {
    const handle = overlay.getNativeWindowHandle();
    const hwnd =
      handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
    scanner.setSelfHwnd(String(hwnd));
  }

  scanner.start(300);

  screen.on('display-metrics-changed', refitOverlay);
  screen.on('display-added', refitOverlay);
  screen.on('display-removed', refitOverlay);

  console.log(
    `[blerb] up — protection=${effectiveProtection()} gpu=${!process.env.BLERB_SOFTWARE} packs=${packsRoot}`,
  );
});

// Tray app: closing every window is not quitting.
app.on('window-all-closed', () => {
  /* stay resident */
});
