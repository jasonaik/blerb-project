import type { PetState, World } from '@blerb/core';
import type { OverlayInit, Settings } from '../shared/ipc';

declare global {
  interface Window {
    blerb: {
      init(): Promise<OverlayInit>;
      read(path: string): Promise<Uint8Array>;
      onInit(cb: (v: OverlayInit) => void): void;
      onPetState(cb: (s: PetState) => void): void;
      onWorld(cb: (w: World) => void): void;
      onVisibility(cb: (v: { hidden: boolean; reason: 'manual' | 'fullscreen' }) => void): void;
      onSettings(cb: (s: Settings) => void): void;
      drag(active: boolean): void;
      place(pt: { x: number; y: number }): void;
      menu(): void;
    };
  }
}

export {};
