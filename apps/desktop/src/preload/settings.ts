import { contextBridge, ipcRenderer } from 'electron';
import { CH } from '../shared/ipc';

contextBridge.exposeInMainWorld('blerbSettings', {
  get: () => ipcRenderer.invoke(CH.settingsGet),
  set: (patch: unknown) => ipcRenderer.invoke(CH.settingsSet, patch),
  packs: () => ipcRenderer.invoke(CH.packsList),
  onChange: (cb: (s: unknown) => void) => ipcRenderer.on(CH.settingsChanged, (_e, s) => cb(s)),
  quit: () => ipcRenderer.send(CH.appQuit),
});
