import { contextBridge, ipcRenderer } from 'electron';
import { CH } from '../shared/ipc';

// The overlay page's entire view of the world. Typed on the renderer side in
// src/renderer/types.d.ts — keep the two in sync by hand; it's nine methods.
contextBridge.exposeInMainWorld('blerb', {
  init: () => ipcRenderer.invoke(CH.overlayInit),
  read: (p: string) => ipcRenderer.invoke(CH.fsRead, p),
  onInit: (cb: (v: unknown) => void) => ipcRenderer.on(CH.overlayInit, (_e, v) => cb(v)),
  onPetState: (cb: (s: unknown) => void) => ipcRenderer.on(CH.petState, (_e, s) => cb(s)),
  onWorld: (cb: (w: unknown) => void) => ipcRenderer.on(CH.world, (_e, w) => cb(w)),
  onVisibility: (cb: (v: unknown) => void) => ipcRenderer.on(CH.visibility, (_e, v) => cb(v)),
  onSettings: (cb: (s: unknown) => void) => ipcRenderer.on(CH.settingsChanged, (_e, s) => cb(s)),
  drag: (active: boolean) => ipcRenderer.send(CH.overlayDrag, active),
  place: (pt: { x: number; y: number }) => ipcRenderer.send(CH.overlayPlace, pt),
  menu: () => ipcRenderer.send(CH.overlayMenu),
});
