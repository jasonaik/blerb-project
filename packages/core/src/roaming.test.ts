import { expect, it } from 'vitest';
import { resolvePack } from '@blerb/pack';
import { createSim } from './sim.js';
import { buildDesktopGeometry, type ScreenInfo } from './desktop.js';
import { unionRect } from './geom.js';
import type { World } from './types.js';

/**
 * Throwaway probe, not a unit test: does the pet actually move between
 * monitors on its own, over many seeds, with no commands at all?
 *
 * Kept out of the main suite's assertions style on purpose — this measures a
 * rate, and it is the check that would have caught the trapped-pet regression.
 */

const pack = (behavior: Record<string, unknown> = {}) =>
  resolvePack({
    format: 'blerb-pet/1',
    id: 't',
    name: 'T',
    atlas: { src: 'a.png' },
    grid: { w: 32, h: 32, cols: 4 },
    animations: {
      idle: { fps: 3, frames: [0, 1] },
      walk: { fps: 8, frames: [2, 3], designSpeed: 40 },
    },
    aliases: { climb: 'walk', cling: 'idle', sit: 'idle', sleep: 'idle', stretch: 'idle', fall: 'idle', land: 'idle' },
    behavior,
  });

const DEV: ScreenInfo[] = [
  { id: 'laptop', region: { x: 0, y: 0, w: 1440, h: 900 }, floorY: 852 },
  { id: 'ext', region: { x: 233, y: -1080, w: 1920, h: 1080 }, floorY: -48 },
];

const world = (): World => {
  const regions = DEV.map((s) => s.region);
  const { platforms, walls, ceilings } = buildDesktopGeometry(DEV);
  return { rev: 1, bounds: unionRect(regions), regions, platforms, walls, ceilings, gravity: 900, reducedMotion: false };
};

const dts = Array.from({ length: 400_000 }, (_, i) => 14 + ((i * 7) % 6)); // ~1.8h

it('descends and ascends on its own across many seeds', () => {
  const seeds = [3, 11, 29, 41, 57, 83, 101, 137];
  let down = 0;
  let up = 0;

  for (const seed of seeds) {
    // Start on the external monitor's seam; can it get to the laptop?
    const w1 = world();
    const a = createSim({ pack: pack(), world: w1, seed });
    a.dispatch({ k: 'command', name: 'place', x: 800, y: -400 });
    for (const dt of dts) {
      a.step(dt);
      if (a.state.standingOn === 'floor:laptop:0') {
        down++;
        break;
      }
    }

    // And back up again?
    const b = createSim({ pack: pack({ climbiness: 1 }), world: world(), seed });
    b.dispatch({ k: 'command', name: 'place', x: 700, y: 800 });
    for (const dt of dts) {
      b.step(dt);
      if (b.state.standingOn === 'floor:ext:0' || b.state.standingOn === 'seam:ext:0') {
        up++;
        break;
      }
    }
  }

  console.log(`descended ${down}/${seeds.length}, ascended ${up}/${seeds.length}`);
  expect(down).toBe(seeds.length);
  expect(up).toBe(seeds.length);
});
