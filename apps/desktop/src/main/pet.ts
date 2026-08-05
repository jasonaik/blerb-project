import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSim, deriveFrame, type PetSnapshot, type PetState, type Sim, type World } from '@blerb/core';
import { resolvePack, type ResolvedPack } from '@blerb/pack';

/**
 * The pet, simulated once in the main process.
 *
 * With one overlay window per display, the pet is a single entity that can be
 * on any of them — or straddling two. Running the sim per-window would mean N
 * pets; running it in main and broadcasting PetState means one pet and N dumb
 * views. `RenderFrame` still never crosses a process boundary: each renderer
 * derives its own from the state it receives.
 *
 * The loop parks itself when nothing is changing. A pet that idles at 2fps and
 * is stationary >70% of the time (design contract rule 4) should not keep a
 * 60Hz timer alive.
 */

const ACTIVE_MS = 16;
const PARKED_MS = 100;
const PARK_AFTER = 20;

export interface PetHost {
  readonly sim: Sim;
  readonly pack: ResolvedPack;
  start(): void;
  stop(): void;
  /** Nudge the loop out of its parked state, e.g. after a user command. */
  wake(): void;
  onState(cb: (s: PetState) => void): void;
}

export function loadPackSync(packDir: string): ResolvedPack {
  const manifest = JSON.parse(readFileSync(join(packDir, 'pet.json'), 'utf8')) as unknown;
  return resolvePack(manifest, `${packDir.replace(/\\/g, '/')}/pet.json`);
}

export function createPetHost(
  pack: ResolvedPack,
  world: World,
  snapshot?: PetSnapshot,
): PetHost {
  const sim = createSim({ pack, world, ...(snapshot ? { snapshot } : {}) });

  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = 0;
  let idle = 0;
  let parked = false;
  let prevKey = '';
  const listeners: ((s: PetState) => void)[] = [];

  /** Everything a viewer can see. If none of it changed, nobody needs telling. */
  const key = (s: PetState): string => {
    const f = deriveFrame(pack, s);
    return `${f.cellId}|${f.x.toFixed(1)}|${f.y.toFixed(1)}|${f.facing}|${f.opacity}|${f.rotation.toFixed(3)}`;
  };

  function tick(): void {
    const now = Date.now();
    const dt = last === 0 ? ACTIVE_MS : now - last;
    last = now;

    sim.step(dt);

    const k = key(sim.state);
    if (k === prevKey) {
      if (++idle >= PARK_AFTER) parked = true;
    } else {
      prevKey = k;
      idle = 0;
      parked = false;
      for (const cb of listeners) cb(sim.state);
    }

    timer = setTimeout(tick, parked ? PARKED_MS : ACTIVE_MS);
  }

  return {
    sim,
    pack,
    start() {
      if (timer) return;
      last = 0;
      tick();
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
    wake() {
      parked = false;
      idle = 0;
      prevKey = '';
    },
    onState(cb) {
      listeners.push(cb);
    },
  };
}
