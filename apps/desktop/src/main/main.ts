import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, Tray, type Display } from 'electron';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { frameBounds } from '@blerb/render-canvas';
import { deriveFrame, type PetSnapshot, type PetState, type World } from '@blerb/core';
import { CH, type OverlayCommand, type Settings } from '../shared/ipc';
import { loadSettings, saveSettings } from './settings';
import { createScanner, fallbackWorld, type Scanner } from './scanner';
import { createOverlayWindow, createSettingsWindow } from './windows';
import { createPetHost, loadPackSync, type PetHost } from './pet';

/**
 * Env toggles (dev/diagnostics):
 *   BLERB_DEBUG=1           log each world scan (screens, floors, walls)
 *   BLERB_SOFTWARE=1        disable GPU compositing
 *   BLERB_ALLOW_CAPTURE=1   let screen capture see the pet, for verification
 */

// Windows occlusion tracking treats a fully-transparent always-on-top window
// as occluded whenever a maximized window sits under it, which stops RAF in
// the renderer and freezes the pet.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

if (process.env.BLERB_SOFTWARE) app.disableHardwareAcceleration();
if (!app.requestSingleInstanceLock()) app.quit();

const repoRoot = resolve(app.getAppPath(), '..', '..');
const packsRoot = join(repoRoot, 'packs');

let settings = loadSettings();
let pet: PetHost | null = null;
let scanner: Scanner | null = null;
let settingsWin: BrowserWindow | null = null;
let tray: Tray | null = null;

/** One overlay per display, keyed by display.id — never by array index. */
const overlays = new Map<number, { win: BrowserWindow; display: Display }>();

let lastWorld: World | null = null;
let dragLatch = false;
let interactiveWin: BrowserWindow | null = null;
let hiddenByFullscreen = false;
let quitting = false;

const effectiveProtection = () => settings.captureProtection && !process.env.BLERB_ALLOW_CAPTURE;
const snapshotFile = () => join(app.getPath('userData'), 'pet-snapshot.json');

// ------------------------------------------------------------------ overlays

function spawnOverlays(): void {
  const wanted = new Set(screen.getAllDisplays().map((d) => d.id));

  for (const [id, entry] of overlays) {
    if (!wanted.has(id)) {
      entry.win.destroy();
      overlays.delete(id);
    }
  }

  for (const display of screen.getAllDisplays()) {
    const existing = overlays.get(display.id);
    if (existing) {
      existing.display = display;
      existing.win.setBounds(display.bounds);
      existing.win.webContents.send(CH.overlayInit, initPayload(display));
      continue;
    }

    const win = createOverlayWindow(display, { contentProtection: effectiveProtection() });
    overlays.set(display.id, { win, display });

    win.webContents.on('console-message', (_e, _l, message) => console.log('[overlay]', message));
    win.webContents.on('did-finish-load', () => pushVisibility());
    win.on('closed', () => {
      overlays.delete(display.id);
      if (!quitting && overlays.size === 0) quit();
    });
  }

  // Exclude our own windows from the platform walk, or the pet stands on
  // its own overlay — which is display-sized and passes every other filter.
  scanner?.setSelfHwnds(
    [...overlays.values()].map((o) => {
      const h = o.win.getNativeWindowHandle();
      return String(h.length >= 8 ? h.readBigUInt64LE(0) : BigInt(h.readUInt32LE(0)));
    }),
  );
  scanner?.force();
}

function initPayload(display: Display) {
  return {
    packDir: join(packsRoot, settings.pack).replace(/\\/g, '/'),
    origin: { x: display.bounds.x, y: display.bounds.y },
    world: lastWorld ?? fallbackWorld(),
    state: pet?.sim.state ?? null,
    settings,
  };
}

function broadcast(channel: string, payload: unknown): void {
  for (const { win } of overlays.values()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------- visibility

function pushVisibility(): void {
  const hidden = !settings.petVisible || hiddenByFullscreen;
  for (const { win } of overlays.values()) {
    if (win.isDestroyed()) continue;
    if (hidden && win.isVisible()) win.hide();
    if (!hidden && !win.isVisible()) {
      win.showInactive();
      win.setContentProtection(effectiveProtection()); // can drop across hide/show
    }
  }
  pet?.sim.dispatch(hidden ? { k: 'hide', reason: hiddenByFullscreen ? 'fullscreen' : 'manual' } : { k: 'show' });
  pet?.wake();
  broadcast(CH.visibility, { hidden, reason: hiddenByFullscreen ? 'fullscreen' : 'manual' });
}

// ------------------------------------------------------------------ settings

function applySettings(patch: Partial<Settings>): Settings {
  settings = { ...settings, ...patch };
  saveSettings(settings);

  if ('petVisible' in patch) pushVisibility();
  if ('captureProtection' in patch) {
    for (const { win } of overlays.values()) win.setContentProtection(effectiveProtection());
  }
  if ('launchAtLogin' in patch) app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
  if ('smoothTracking' in patch) scanner?.setSmoothTracking(settings.smoothTracking);

  broadcast(CH.settingsChanged, settings);
  settingsWin?.webContents.send(CH.settingsChanged, settings);
  pet?.wake();
  rebuildTrayMenu();
  return settings;
}

// ---------------------------------------------------------------------- tray

function trayTemplate(): Electron.MenuItemConstructorOptions[] {
  return [
    { label: 'Pet visible', type: 'checkbox', checked: settings.petVisible, click: (i) => applySettings({ petVisible: i.checked }) },
    { label: 'Invisible in screen capture', type: 'checkbox', checked: settings.captureProtection, click: (i) => applySettings({ captureProtection: i.checked }) },
    { label: 'Can climb walls', type: 'checkbox', checked: settings.climbing, click: (i) => applySettings({ climbing: i.checked }) },
    { label: 'Can hang upside down', type: 'checkbox', checked: settings.hanging, click: (i) => applySettings({ hanging: i.checked }) },
    { label: 'Follow moving windows smoothly', type: 'checkbox', checked: settings.smoothTracking, click: (i) => applySettings({ smoothTracking: i.checked }) },
    { label: 'Debug overlay', type: 'checkbox', checked: settings.debugOverlay, click: (i) => applySettings({ debugOverlay: i.checked }) },
    { type: 'separator' },
    { label: 'Recenter pet', click: () => command({ name: 'recenter' }) },
    { label: 'Settings…', click: openSettings },
    { type: 'separator' },
    { label: 'Quit blerb', click: quit },
  ];
}

const rebuildTrayMenu = () => tray?.setContextMenu(Menu.buildFromTemplate(trayTemplate()));

/**
 * The pet's own right-click menu: everything the tray has, plus the one action
 * that only makes sense with a pet in front of you — shutting it into the
 * window it is currently standing in.
 */
function petMenuTemplate(): Electron.MenuItemConstructorOptions[] {
  const s = pet?.sim.state;
  const here = s && scanner ? scanner.windowAt(s.x, s.y) : null;
  // The scanner owns the pin so it can drop it when the window closes; asking
  // it is the only way to be sure the two agree.
  const pinned = scanner?.terrarium() != null;

  return [
    {
      label: pinned ? 'Let out of this window' : 'Keep in this window',
      // Only offered when the pet is actually inside something to be kept in.
      enabled: pinned || here !== null,
      click: () => setTerrarium(pinned ? null : here),
    },
    { type: 'separator' },
    ...trayTemplate(),
  ];
}

function setTerrarium(id: string | null): void {
  scanner?.setTerrarium(id);
  scanner?.force();
  pet?.wake();
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

function command(c: OverlayCommand): void {
  pet?.sim.dispatch({ k: 'command', name: c.name });
  pet?.wake();
}

function openSettings(): void {
  if (settingsWin && !settingsWin.isDestroyed()) return settingsWin.focus();
  settingsWin = createSettingsWindow();
  settingsWin.on('closed', () => (settingsWin = null));
}

// ------------------------------------------------------- cursor / clickthrough

/**
 * Click-through hit test, driven by a main-process cursor poll rather than DOM
 * mousemove — forwarding silently dies when Task Manager has focus
 * (electron#33281, WONTFIX), so renderer events can't be trusted for this.
 *
 * With N windows only the one under the pet may become interactive, and only
 * while the cursor is actually over the sprite.
 */
/** Slack around the sprite for the click-through hit test, DIP. */
const GRAB_PAD = 6;

function startCursorWatcher(): void {
  setInterval(() => {
    if (dragLatch || !pet) return;

    const s = pet.sim.state;
    const frame = deriveFrame(pet.pack, s, settings.petScale);
    const cell = pet.pack.cells.get(frame.cellId);
    if (!cell || s.hidden) return setInteractive(null);

    // Through the SAME transform the renderer draws with. The sprite is
    // rotated a quarter turn on a wall and a half turn under a ceiling, so a
    // box derived from the cell alone sits in the wrong place entirely — which
    // is why a hanging pet was almost impossible to pick up.
    const b = frameBounds(
      cell,
      { ...frame, scale: frame.scale * settings.petScale },
      pet.pack.atlasScale,
    );
    // A little slack, because the target is a moving 32px sprite and the user
    // is aiming with a mouse.
    const pad = GRAB_PAD;
    const p = screen.getCursorScreenPoint(); // global DIP
    const over =
      p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;

    if (!over) return setInteractive(null);
    const hit = [...overlays.values()].find(
      (o) =>
        p.x >= o.display.bounds.x &&
        p.x < o.display.bounds.x + o.display.bounds.width &&
        p.y >= o.display.bounds.y &&
        p.y < o.display.bounds.y + o.display.bounds.height,
    );
    setInteractive(hit?.win ?? null);
  }, 33);
}

function setInteractive(win: BrowserWindow | null): void {
  if (interactiveWin === win) return;
  if (interactiveWin && !interactiveWin.isDestroyed()) {
    interactiveWin.setIgnoreMouseEvents(true, { forward: true });
  }
  interactiveWin = win;
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(false);
}

// ------------------------------------------------------------------ snapshot

function saveSnapshot(): void {
  if (!pet) return;
  try {
    const f = snapshotFile();
    mkdirSync(join(f, '..'), { recursive: true });
    const tmp = f + '.tmp';
    writeFileSync(tmp, JSON.stringify(pet.sim.serialize()));
    renameSync(tmp, f);
  } catch {
    /* the pet just respawns next launch */
  }
}

function loadSnapshot(): PetSnapshot | undefined {
  try {
    const f = snapshotFile();
    if (!existsSync(f)) return undefined;
    return JSON.parse(readFileSync(f, 'utf8')) as PetSnapshot;
  } catch {
    return undefined;
  }
}

// ----------------------------------------------------------------------- ipc

function registerIpc(): void {
  ipcMain.handle(CH.overlayInit, (e) => {
    const entry = [...overlays.values()].find((o) => o.win.webContents === e.sender);
    return initPayload(entry?.display ?? screen.getPrimaryDisplay());
  });

  // Reads are restricted to packs/ — the renderer needs sprite assets and
  // nothing else from disk.
  ipcMain.handle(CH.fsRead, async (_e, p: string) => {
    const rp = resolve(String(p));
    if (!rp.startsWith(resolve(packsRoot) + sep)) throw new Error('read outside packs/ denied');
    return readFile(rp);
  });

  ipcMain.on(CH.overlayDrag, (_e, active: boolean) => {
    dragLatch = active;
    if (!active) setInteractive(null);
  });

  ipcMain.on(CH.overlayPlace, (_e, pt: { x: number; y: number }) => {
    // Carrying the pet out of the window it was shut into means letting it
    // out. Leaving the pin would strand invisible walls across a window the
    // pet is no longer in.
    const pinned = scanner?.terrarium();
    if (pinned && scanner?.windowAt(pt.x, pt.y) !== pinned) setTerrarium(null);

    pet?.sim.dispatch({ k: 'command', name: 'place', x: pt.x, y: pt.y });
    pet?.wake();
  });

  ipcMain.on(CH.overlayMenu, () => Menu.buildFromTemplate(petMenuTemplate()).popup());
  ipcMain.handle(CH.settingsGet, () => settings);
  ipcMain.handle(CH.settingsSet, (_e, patch: Partial<Settings>) => applySettings(patch));
  ipcMain.on(CH.appQuit, quit);
}

// ---------------------------------------------------------------- lifecycle

function quit(): void {
  quitting = true;
  saveSnapshot();
  pet?.stop();
  scanner?.stop();
  tray?.destroy();
  app.quit();
}

void app.whenReady().then(() => {
  registerIpc();

  const packDir = join(packsRoot, settings.pack);
  const pack = loadPackSync(packDir);
  // The pack ships with climbing on; the setting is the user's override.
  pack.behavior.can.climb = settings.climbing;
  pack.behavior.can.hang = settings.hanging;
  // Diagnostic: climb at every wall instead of ~45% of the time, so the
  // multi-monitor path can be exercised without waiting on dice.
  if (process.env.BLERB_CLIMBY) pack.behavior.climbiness = 1;

  scanner = createScanner({
    onWorld: (world) => {
      lastWorld = world;
      pet?.sim.dispatch({ k: 'world', world });
      pet?.wake();
      broadcast(CH.world, world);
    },
    onFullscreen: (fs) => {
      if (fs !== hiddenByFullscreen) {
        hiddenByFullscreen = fs;
        pushVisibility();
      }
    },
  });

  const world = fallbackWorld();
  lastWorld = world;
  pet = createPetHost(pack, world, loadSnapshot());
  pet.onState((s: PetState) => broadcast(CH.petState, s));

  if (process.env.BLERB_DEBUG) {
    let prev = '';
    pet.onState((s) => {
      const where = [...overlays.values()].find(
        (o) =>
          s.x >= o.display.bounds.x &&
          s.x < o.display.bounds.x + o.display.bounds.width &&
          s.y >= o.display.bounds.y &&
          s.y < o.display.bounds.y + o.display.bounds.height,
      );
      const line = `${s.behavior} on=${s.standingOn ?? s.climbingOn ?? s.hangingOn ?? 'air'} screen=${where?.display.id ?? '?'}`;
      if (line !== prev) {
        prev = line;
        console.log(`[pet] ${line} @ ${Math.round(s.x)},${Math.round(s.y)}`);
      }
    });
  }

  spawnOverlays();
  createTray();
  startCursorWatcher();
  scanner.setSmoothTracking(settings.smoothTracking);
  scanner.start(300);
  pet.start();

  setInterval(saveSnapshot, 10_000);

  const relayout = () => spawnOverlays();
  screen.on('display-added', relayout);
  screen.on('display-removed', relayout);
  screen.on('display-metrics-changed', relayout);

  console.log(
    `[blerb] up — displays=${overlays.size} protection=${effectiveProtection()} ` +
      `gpu=${!process.env.BLERB_SOFTWARE} climb=${settings.climbing}`,
  );
});

// Tray app: closing every window is not quitting.
app.on('window-all-closed', () => {
  /* stay resident */
});
