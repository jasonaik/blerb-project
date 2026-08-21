import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, Tray, type Display } from 'electron';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { frameBounds } from '@blerb/render-canvas';
import { deriveFrame, type PetSnapshot, type PetState, type World } from '@blerb/core';
import { CH, type OverlayCommand, type Settings } from '../shared/ipc';
import { DEFAULTS, loadSettings, sanitizeClassification, saveSettings, settingsFileExists } from './settings';
import { importPet } from './importer';
import { startObserver, type Observer } from './observer';
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

/**
 * Where packs live. Dev: the repo's packs/ (one root, read-write). Packaged:
 * the read-only copies bundled under resources/ — which is ONLY blob; third-
 * party art is never distributed — plus a user-writable packs/ in userData
 * that the GUI importer writes to. Roots are searched in order, so a user
 * pack shadows a bundled one with the same id.
 */
const bundledPacksRoot = app.isPackaged
  ? join(process.resourcesPath, 'packs')
  : join(resolve(app.getAppPath(), '..', '..'), 'packs');
const userPacksRoot = app.isPackaged ? join(app.getPath('userData'), 'packs') : bundledPacksRoot;
const packRoots = userPacksRoot === bundledPacksRoot ? [bundledPacksRoot] : [userPacksRoot, bundledPacksRoot];

/** Absolute directory for a pack id — first root that has it, else where an import would put it. */
function packDirFor(id: string): string {
  for (const root of packRoots) {
    if (existsSync(join(root, id, 'pet.json'))) return join(root, id);
  }
  return join(userPacksRoot, id);
}

/** Whether any root already carries this id — the importer must not reuse it. */
const idTakenAnywhere = (id: string): boolean =>
  packRoots.some((root) => existsSync(join(root, id, 'pet.json')));

let settings = loadSettings();
let pet: PetHost | null = null;
let scanner: Scanner | null = null;
let observer: Observer | null = null;
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

// ------------------------------------------------------------------ the pet

/**
 * Every pack directory across the roots — what the pack picker offers. First
 * root wins on id clashes. Cached briefly: with a batch pokemon import in
 * packs/ a full scan reads ~570 pet.jsons (~190ms measured), and this runs on
 * every settings change — including each tick of the pet-size slider — on the
 * same process as the sim. The TTL keeps a slider drag at one scan while a
 * CLI import still shows up on the next human-timescale look.
 */
let packsCache: { at: number; list: { id: string; name: string }[] } | null = null;
const PACKS_CACHE_MS = 2000;

function listPacks(): { id: string; name: string }[] {
  if (packsCache && Date.now() - packsCache.at < PACKS_CACHE_MS) return packsCache.list;
  const seen = new Map<string, { id: string; name: string }>();
  for (const root of packRoots) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of entries) {
      if (!d.isDirectory() || seen.has(d.name) || !existsSync(join(root, d.name, 'pet.json'))) continue;
      try {
        const m = JSON.parse(readFileSync(join(root, d.name, 'pet.json'), 'utf8')) as { name?: unknown };
        seen.set(d.name, { id: d.name, name: typeof m.name === 'string' ? m.name : d.name });
      } catch {
        seen.set(d.name, { id: d.name, name: d.name });
      }
    }
  }
  const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  packsCache = { at: Date.now(), list };
  return list;
}

/**
 * Build (or rebuild) the pet from settings.pack. The sim closes over its
 * pack, so switching pets means a new host — carrying the old position and
 * pose through the snapshot so the new pet appears where the old one stood
 * instead of respawning across the screen.
 */
function loadPetHost(snapshot?: PetSnapshot): PetHost {
  const pack = loadPackSync(packDirFor(settings.pack));
  // The pack ships with climbing on; the settings are the user's override.
  pack.behavior.can.climb = settings.climbing;
  pack.behavior.can.hang = settings.hanging;
  // Diagnostic: climb at every wall instead of ~45% of the time, so the
  // multi-monitor path can be exercised without waiting on dice.
  if (process.env.BLERB_CLIMBY) pack.behavior.climbiness = 1;

  const host = createPetHost(pack, lastWorld ?? fallbackWorld(), snapshot);
  host.onState((s: PetState) => broadcast(CH.petState, s));

  if (process.env.BLERB_DEBUG) {
    let prev = '';
    host.onState((s) => {
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
  return host;
}

/**
 * Swap the running pet for settings.pack. On a broken pack (hand-imported,
 * failed doctor) the old pet stays and the setting reverts — a bad pick from
 * the picker must never kill the app.
 */
function switchPack(prevPack: string): void {
  const snap = pet?.sim.serialize();
  try {
    const next = loadPetHost(snap);
    pet?.stop();
    pet = next;
    pet.start();
  } catch (err) {
    console.error(`[blerb] pack "${settings.pack}" failed to load — keeping "${prevPack}":`, err);
    settings = { ...settings, pack: prevPack };
    saveSettings(settings);
    return;
  }
  // Overlays reload the sprite art from the new packDir; the tray wears the
  // new face.
  for (const { win, display } of overlays.values()) {
    if (!win.isDestroyed()) win.webContents.send(CH.overlayInit, initPayload(display));
  }
  tray?.setImage(trayIcon());
}

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
    packDir: packDirFor(settings.pack).replace(/\\/g, '/'),
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
  // The pack id is joined into filesystem paths (packDirFor); a slug is the
  // only shape that can ever be legitimate, so anything else — separators,
  // dots, empty — is dropped here rather than trusted from IPC.
  if (patch.pack !== undefined && !/^[a-z0-9][a-z0-9_-]*$/i.test(patch.pack)) {
    console.warn(`[blerb] ignoring invalid pack id ${JSON.stringify(patch.pack)}`);
    patch = { ...patch };
    delete patch.pack;
  }
  const prevPack = settings.pack;
  settings = { ...settings, ...patch };
  // Same hole as loadSettings: a malformed IPC patch must neither crash the
  // observer nor persist a bad shape for the next launch.
  if ('classification' in patch) settings.classification = sanitizeClassification(patch.classification);
  saveSettings(settings);

  if ('pack' in patch && settings.pack !== prevPack) switchPack(prevPack);
  if (('climbing' in patch || 'hanging' in patch) && pet) {
    // The sim reads these live on every behavior decision — write through to
    // the resolved pack so the toggles work without a restart.
    pet.pack.behavior.can.climb = settings.climbing;
    pet.pack.behavior.can.hang = settings.hanging;
    pet.wake();
  }
  if ('petVisible' in patch) pushVisibility();
  if ('captureProtection' in patch) {
    for (const { win } of overlays.values()) win.setContentProtection(effectiveProtection());
  }
  if ('launchAtLogin' in patch) app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
  if ('smoothTracking' in patch) scanner?.setSmoothTracking(settings.smoothTracking);
  if ('classification' in patch) observer?.setClassification(settings.classification);

  broadcast(CH.settingsChanged, settings);
  settingsWin?.webContents.send(CH.settingsChanged, settings);
  pet?.wake();
  rebuildTrayMenu();
  return settings;
}

// ---------------------------------------------------------------------- tray

/**
 * With a handful of packs the Pet submenu is a radio list; with hundreds
 * (a batch pokemon import) a native menu is the wrong control entirely, so it
 * degrades to "current pet + open Settings", where a real dropdown lives.
 */
function petSubmenu(): Electron.MenuItemConstructorOptions[] {
  const packs = listPacks();
  if (packs.length <= 24) {
    return packs.map((p) => ({
      label: p.name,
      type: 'radio' as const,
      checked: p.id === settings.pack,
      click: () => applySettings({ pack: p.id }),
    }));
  }
  const current = packs.find((p) => p.id === settings.pack);
  return [
    { label: current?.name ?? settings.pack, type: 'radio', checked: true, enabled: false },
    { type: 'separator' },
    { label: `All ${packs.length} pets…`, click: openSettings },
  ];
}

function trayTemplate(): Electron.MenuItemConstructorOptions[] {
  return [
    { label: 'Pet', submenu: petSubmenu() },
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

/** The pet's face, cropped from its atlas's first cell. */
function trayIcon(): Electron.NativeImage {
  const img = nativeImage.createFromPath(join(packDirFor(settings.pack), 'atlas.png'));
  const { width, height } = img.getSize();
  // The REAL first cell when the resolved pack is at hand — a hi-res atlas
  // (from-image art can be 400px a cell) has nothing but transparent margin
  // in its top-left 64px, which renders as a blank tray icon.
  const cell = pet?.pack.cells.values().next().value;
  if (cell && cell.w <= width && cell.h <= height) {
    return img
      .crop({ x: cell.x, y: cell.y, width: cell.w, height: cell.h })
      .resize({ width: 16, height: 16 });
  }
  // Fallback (pet not built yet): a first-cell-ish square.
  const side = Math.max(16, Math.min(64, Math.min(width, height)));
  return img.crop({ x: 0, y: 0, width: side, height: side }).resize({ width: 16, height: 16 });
}

function createTray(): void {
  tray = new Tray(trayIcon());
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

  // Reads are restricted to the pack roots — the renderer needs sprite assets
  // and nothing else from disk.
  ipcMain.handle(CH.fsRead, async (_e, p: string) => {
    const rp = resolve(String(p));
    if (!packRoots.some((root) => rp.startsWith(resolve(root) + sep))) {
      throw new Error('read outside packs/ denied');
    }
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
  ipcMain.handle(CH.packsList, () => listPacks());
  ipcMain.handle(CH.packsImport, async (_e, rawName?: string) => {
    const dialogOpts = {
      title: 'Choose pet art',
      filters: [
        { name: 'Pet art (GIF, WebP, PNG, JPG)', extensions: ['gif', 'webp', 'png', 'jpg', 'jpeg'] },
      ],
      properties: ['openFile' as const, 'multiSelections' as const],
    };
    const picked = settingsWin
      ? await dialog.showOpenDialog(settingsWin, dialogOpts)
      : await dialog.showOpenDialog(dialogOpts);
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true };
    const result = await importPet(picked.filePaths, userPacksRoot, rawName, idTakenAnywhere);
    // A freshly imported pet becomes THE pet — that is unmistakably "it
    // worked", where a new entry in a 500-item dropdown is not.
    packsCache = null;
    if (result.ok && result.id) applySettings({ pack: result.id });
    return result;
  });
  ipcMain.on(CH.appQuit, quit);
}

// ---------------------------------------------------------------- lifecycle

function quit(): void {
  quitting = true;
  saveSnapshot();
  pet?.stop();
  scanner?.stop();
  observer?.stop();
  tray?.destroy();
  app.quit();
}

// Double-clicking the exe while blerb is already running should open the GUI,
// not silently do nothing — for an installed tray app that is the only
// discoverable "where did it go".
app.on('second-instance', () => openSettings());

void app.whenReady().then(() => {
  const firstRun = !settingsFileExists();
  registerIpc();

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

  lastWorld = fallbackWorld();
  // switchPack guards against a broken pack picked at runtime; this guards
  // the one it can't — settings.pack naming a pack that no longer exists on
  // disk. An installed app whose settings point at a deleted (or dev-only)
  // pack must fall back to the bundled default, not die at startup.
  try {
    pet = loadPetHost(loadSnapshot());
  } catch (err) {
    if (settings.pack === DEFAULTS.pack) throw err; // blob itself broken — the install is bad
    console.error(`[blerb] pack "${settings.pack}" failed to load — falling back to ${DEFAULTS.pack}:`, err);
    settings = { ...settings, pack: DEFAULTS.pack };
    saveSettings(settings);
    pet = loadPetHost(loadSnapshot());
  }

  spawnOverlays();
  createTray();
  startCursorWatcher();
  scanner.setSmoothTracking(settings.smoothTracking);
  scanner.start(300);
  pet.start();
  // Phase 5: observe and log only. Nothing persists, nothing reacts yet.
  observer = startObserver(settings.classification);

  setInterval(saveSnapshot, 10_000);

  // First launch: show the settings window so the app visibly exists beyond
  // a tray icon and a sprite on the taskbar.
  if (firstRun) {
    saveSettings(settings);
    openSettings();
  }

  // Diagnostic: run the GUI import path headlessly (files ;-separated).
  // BLERB_IMPORT="C:\a\walk.gif;C:\a\idle.gif" BLERB_IMPORT_NAME=x
  if (process.env.BLERB_IMPORT) {
    void importPet(
      process.env.BLERB_IMPORT.split(';'),
      userPacksRoot,
      process.env.BLERB_IMPORT_NAME,
      idTakenAnywhere,
    ).then((r) => {
      console.log('[blerb] BLERB_IMPORT:', JSON.stringify(r));
      packsCache = null;
      if (r.ok && r.id) applySettings({ pack: r.id });
    });
  }

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
