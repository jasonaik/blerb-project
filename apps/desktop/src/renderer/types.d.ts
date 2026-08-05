import type { World } from '@blerb/core';
import type { OverlayCommand, OverlayInit, PetBbox, Settings } from '../shared/ipc';

declare global {
  interface Window {
    blerb: {
      init(): Promise<OverlayInit>;
      read(path: string): Promise<Uint8Array>;
      onWorld(cb: (w: World) => void): void;
      onVisibility(cb: (v: { hidden: boolean; reason: 'manual' | 'fullscreen' }) => void): void;
      onSettings(cb: (s: Settings) => void): void;
      onCommand(cb: (c: OverlayCommand) => void): void;
      bbox(b: PetBbox): void;
      drag(active: boolean): void;
      menu(): void;
    };
  }
}

export {};
