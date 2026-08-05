import { contextBridge, ipcRenderer } from 'electron';
import { CH } from '../shared/ipc';

// The overlay page's entire view of the world. Typed on the renderer side in
// src/renderer/types.d.ts — keep the two in sync by hand; it's eight methods.
contextBridge.exposeInMainWorld('blerb', {
  init: () => ipcRenderer.invoke(CH.overlayInit),
  read: (p: string) => ipcRenderer.invoke(CH.fsRead, p),
  onWorld: (cb: (w: unknown) => void) => ipcRenderer.on(CH.world, (_e, w) => cb(w)),
  onVisibility: (cb: (v: unknown) => void) => ipcRenderer.on(CH.visibility, (_e, v) => cb(v)),
  onSettings: (cb: (s: unknown) => void) => ipcRenderer.on(CH.settingsChanged, (_e, s) => cb(s)),
  onCommand: (cb: (c: unknown) => void) => ipcRenderer.on(CH.command, (_e, c) => cb(c)),
  bbox: (b: unknown) => ipcRenderer.send(CH.overlayBbox, b),
  drag: (active: boolean) => ipcRenderer.send(CH.overlayDrag, active),
  menu: () => ipcRenderer.send(CH.overlayMenu),
});
