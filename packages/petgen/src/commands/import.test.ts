import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolvePack } from '@blerb/pack';
import { deriveFrame } from '@blerb/core';
import { fromSheet } from './fromSheet.js';
import { fromFrames } from './fromFrames.js';
import { assembleAnimations, fromGif } from './fromGif.js';
import { fromImage } from './fromImage.js';
import { diagnosePack } from './doctor.js';
import { loadRaster } from '../import/io.js';
import { blit, crop, makeRaster, trimBox, type Raster } from '../import/raster.js';

/**
 * End-to-end: real files in, a working pack out, `doctor` clean on the result.
 * Inputs are synthesized with sharp so the tests own every pixel.
 */

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));

let tmp: string;
beforeAll(async () => {
  // sharp caches input file handles; on Windows that holds a lock that makes
  // the temp-dir cleanup fail with EBUSY.
  sharp.cache(false);
  tmp = await mkdtemp(join(tmpdir(), 'petgen-'));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
});

function rect(r: Raster, x0: number, y0: number, x1: number, y1: number, rgb = [255, 80, 80]): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * r.w + x) * 4;
      r.data[i] = rgb[0]!;
      r.data[i + 1] = rgb[1]!;
      r.data[i + 2] = rgb[2]!;
      r.data[i + 3] = 255;
    }
  }
}

async function writePng(r: Raster, file: string): Promise<void> {
  const buf = await sharp(Buffer.from(r.data), { raw: { width: r.w, height: r.h, channels: 4 } })
    .png()
    .toBuffer();
  await writeFile(file, buf);
}

/** Cell top-left for atlas index i, from the emitted manifest's grid block. */
function cellAt(manifest: { grid: { w: number; h: number; cols: number; spacing: number; margin: number } }, i: number) {
  const g = manifest.grid;
  return {
    x: g.margin + (i % g.cols) * (g.w + g.spacing),
    y: g.margin + Math.floor(i / g.cols) * (g.h + g.spacing),
    w: g.w,
    h: g.h,
  };
}

interface EmittedManifest {
  pixelArt: boolean;
  grid: { w: number; h: number; cols: number; spacing: number; margin: number; count: number };
  animations: Record<string, { frames: number[]; fps: number }>;
}

/** Trimmed content size of atlas cell i — the check that survives re-layout. */
function contentDims(atlas: Raster, manifest: EmittedManifest, i: number): { w: number; h: number } {
  const c = cellAt(manifest, i);
  const b = trimBox(crop(atlas, c.x, c.y, c.w, c.h))!;
  return { w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1 };
}

/** A ragged sprite: odd run lengths, content comfortably over 8px each way. */
function raggedSprite(w: number, h: number, seed: number): Raster {
  const r = makeRaster(w, h);
  for (let y = 2; y < h - 1; y++) {
    for (let x = 2; x < w - 2; x++) {
      if ((x * 3 + y + seed) % 7 === 0) continue;
      const i = (y * r.w + x) * 4;
      r.data[i] = 200;
      r.data[i + 1] = (40 + seed * 50) % 255;
      r.data[i + 2] = 40;
      r.data[i + 3] = 255;
    }
  }
  return r;
}

/** Nearest-neighbour upscale — what a "2x export" does to art. */
function upscale(r: Raster, k: number): Raster {
  const out = makeRaster(r.w * k, r.h * k);
  for (let y = 0; y < out.h; y++) {
    for (let x = 0; x < out.w; x++) {
      const s = (Math.floor(y / k) * r.w + Math.floor(x / k)) * 4;
      const d = (y * out.w + x) * 4;
      out.data[d] = r.data[s]!;
      out.data[d + 1] = r.data[s + 1]!;
      out.data[d + 2] = r.data[s + 2]!;
      out.data[d + 3] = r.data[s + 3]!;
    }
  }
  return out;
}

async function readManifest(dir: string): Promise<EmittedManifest> {
  return JSON.parse(await readFile(join(dir, 'pet.json'), 'utf8')) as EmittedManifest;
}

describe('from-sheet', () => {
  it('imports a sheet, preserving registration, and the result passes doctor', async () => {
    // 4 cells of 16x16 in a row: walk contact / walk up (1px bob) / idle a / idle b.
    const sheet = makeRaster(64, 16);
    rect(sheet, 4, 8, 11, 15); // frame 0: on the ground
    rect(sheet, 16 + 4, 7, 16 + 11, 14); // frame 1: 1px up
    rect(sheet, 32 + 4, 8, 32 + 11, 15); // frame 2
    rect(sheet, 48 + 4, 9, 48 + 11, 15); // frame 3: squashed idle
    const input = join(tmp, 'sheet.png');
    await writePng(sheet, input);

    const out = join(tmp, 'sheet-pet');
    await fromSheet({
      input,
      outDir: out,
      grid: '16x16',
      anims: ['walk=0-1@8', 'idle=2,3@2'],
    });

    const d = await diagnosePack(out);
    expect(d.errors).toBe(0);

    const manifest = await readManifest(out);
    expect(manifest.animations['walk']).toEqual({ frames: [0, 1], fps: 8 });
    expect(manifest.animations['idle']).toEqual({ frames: [2, 3], fps: 2 });

    // The bob survives: frame 1's content sits 1px above the anchor row.
    const atlas = await loadRaster(join(out, 'atlas.png'));
    const bottoms = [0, 1].map((i) => {
      const c = cellAt(manifest, i);
      return trimBox(crop(atlas, c.x, c.y, c.w, c.h))!.y1;
    });
    expect(bottoms[0]).toBe(manifest.grid.h - 1);
    expect(bottoms[1]).toBe(manifest.grid.h - 2);

    // And the pack actually resolves.
    const pack = resolvePack(JSON.parse(await readFile(join(out, 'pet.json'), 'utf8')));
    expect(pack.animation('walk').frames).toHaveLength(2);
  });

  it('slices correctly through source margins and gutters, auto or explicit cols', async () => {
    // 2x2 grid of 16px cells with margin 2 and spacing 3; each cell's content
    // width encodes its index. An off-by-one in the slice origin fails SOFT —
    // every cell still has content — so the widths are the real assertion.
    const sheet = makeRaster(39, 39);
    for (let i = 0; i < 4; i++) {
      const ox = 2 + (i % 2) * 19;
      const oy = 2 + Math.floor(i / 2) * 19;
      rect(sheet, ox + 4, oy + 6, ox + 4 + (i + 2), oy + 15);
    }
    const input = join(tmp, 'gutter-sheet.png');
    await writePng(sheet, input);

    for (const [label, cols] of [
      ['auto', undefined],
      ['explicit', 2],
    ] as const) {
      const out = join(tmp, `gutter-${label}`);
      await fromSheet({
        input,
        outDir: out,
        grid: '16x16',
        spacing: 3,
        margin: 2,
        cols,
        anims: ['walk=0-3@8'],
      });
      expect((await diagnosePack(out)).errors).toBe(0);
      const manifest = await readManifest(out);
      const atlas = await loadRaster(join(out, 'atlas.png'));
      const widths = manifest.animations['walk']!.frames.map((i) => contentDims(atlas, manifest, i).w);
      expect(widths).toEqual([3, 4, 5, 6]);
    }
  });

  it('deduplicates frames shared between animations, and within one', async () => {
    const sheet = makeRaster(64, 16);
    for (let i = 0; i < 4; i++) rect(sheet, i * 16 + 4, 6, i * 16 + 4 + (i + 2), 15);
    const input = join(tmp, 'shared-sheet.png');
    await writePng(sheet, input);

    const out = join(tmp, 'shared-pet');
    await fromSheet({ input, outDir: out, grid: '16x16', anims: ['walk=0-3@8', 'idle=0,1@2'] });
    const manifest = await readManifest(out);
    expect(manifest.grid.count).toBe(4); // idle reuses walk's cells
    expect(manifest.animations['walk']!.frames).toEqual([0, 1, 2, 3]);
    expect(manifest.animations['idle']!.frames).toEqual([0, 1]);

    // Repeats inside one animation — the blob's own ping-pong pattern.
    const out2 = join(tmp, 'pingpong-pet');
    await fromSheet({ input, outDir: out2, grid: '16x16', anims: ['walk=0,1,0,1@8'] });
    const m2 = await readManifest(out2);
    expect(m2.grid.count).toBe(2);
    expect(m2.animations['walk']!.frames).toEqual([0, 1, 0, 1]);
  });

  it('undoes a 2x export: grid, spacing and margin divide down in lockstep', async () => {
    // Native truth: margin 1, spacing 2, two 16px cells of ragged art.
    const native = makeRaster(36, 18);
    const cells = [raggedSprite(16, 16, 0), raggedSprite(16, 16, 3)];
    blit(native, cells[0]!, { x0: 0, y0: 0, x1: 15, y1: 15 }, 1, 1);
    blit(native, cells[1]!, { x0: 0, y0: 0, x1: 15, y1: 15 }, 19, 1);
    const input = join(tmp, 'up2-sheet.png');
    await writePng(upscale(native, 2), input);

    const out = join(tmp, 'up2-pet');
    // Everything in FILE pixels, as a user reading their 2x export would.
    await fromSheet({ input, outDir: out, grid: '32x32', spacing: 4, margin: 2, anims: ['walk=0-1@8'] });

    expect((await diagnosePack(out)).errors).toBe(0);
    const manifest = await readManifest(out);
    expect(manifest.pixelArt).toBe(true);
    expect(manifest.grid.w).toBeLessThan(32); // cells came out at native scale
    const atlas = await loadRaster(join(out, 'atlas.png'));
    manifest.animations['walk']!.frames.forEach((f, i) => {
      const want = trimBox(cells[i]!)!;
      expect(contentDims(atlas, manifest, f)).toEqual({
        w: want.x1 - want.x0 + 1,
        h: want.y1 - want.y0 + 1,
      });
    });
  });

  it('refuses out-of-range frames and empty cells loudly', async () => {
    const sheet = makeRaster(32, 16);
    rect(sheet, 2, 2, 13, 15);
    const input = join(tmp, 'small-sheet.png');
    await writePng(sheet, input);

    await expect(
      // Frame 4 is row 2 of a sheet that only has 1 row: off the bottom edge.
      fromSheet({ input, outDir: join(tmp, 'x1'), grid: '16x16', anims: ['walk=0,4@8'] }),
    ).rejects.toThrow(/outside/);
    await expect(
      // The same name twice would silently drop the first spec at emit time.
      fromSheet({ input, outDir: join(tmp, 'x3'), grid: '16x16', anims: ['walk=0@8', 'walk=0@4'] }),
    ).rejects.toThrow(/twice/);
    await expect(
      // Validated through the real resolver BEFORE writing anything.
      fromSheet({ input, outDir: join(tmp, 'x4'), grid: '16x16', anims: ['walk=0@8'], id: 'Bad ID!' }),
    ).rejects.toThrow(/invalid pet.json/);
    await expect(
      fromSheet({ input, outDir: join(tmp, 'x2'), grid: '16x16', anims: ['walk=1@8'] }),
    ).rejects.toThrow(/transparent/);
  });
});

describe('from-frames', () => {
  it('sorts numerically, honours per-anim fps, and passes doctor', async () => {
    const dir = join(tmp, 'frames');
    await mkdir(dir, { recursive: true });
    // Content width encodes the frame's index, so ordering is checkable in
    // the output atlas: walk_9 is 10px wide, walk_10 is 11px.
    for (const i of [9, 10, 0, 2, 1]) {
      const f = makeRaster(24, 24);
      rect(f, 4, 20 - i, 4 + i + 1, 23);
      await writePng(f, join(dir, `walk_${i}.png`));
    }
    const idle = makeRaster(24, 24);
    rect(idle, 8, 12, 15, 23);
    await writePng(idle, join(dir, 'idle_0.png'));

    const out = join(tmp, 'frames-pet');
    await fromFrames({ dir, outDir: out, fps: ['6', 'walk=12'] });

    const d = await diagnosePack(out);
    expect(d.errors).toBe(0);

    const manifest = await readManifest(out);
    expect(manifest.animations['walk']!.fps).toBe(12);
    expect(manifest.animations['idle']!.fps).toBe(6);

    // walk frames come out in numeric order: widths 1+1, 2+1 ... 10+1.
    const atlas = await loadRaster(join(out, 'atlas.png'));
    const widths = manifest.animations['walk']!.frames.map((i) => {
      const c = cellAt(manifest, i);
      const b = trimBox(crop(atlas, c.x, c.y, c.w, c.h))!;
      return b.x1 - b.x0 + 1;
    });
    expect(widths).toEqual([2, 3, 4, 11, 12]); // indices 0,1,2,9,10
  });

  it('mixed canvas sizes: each animation aligns by its own anchor, bob intact', async () => {
    const dir = join(tmp, 'frames-mixed');
    await mkdir(dir, { recursive: true });
    // walk on 24x24 canvases with a 1px bob; idle on a 32x40 canvas.
    const w0 = makeRaster(24, 24);
    rect(w0, 4, 14, 12, 23);
    const w1 = makeRaster(24, 24);
    rect(w1, 4, 13, 12, 22); // same shape, 1px up
    const idle = makeRaster(32, 40);
    rect(idle, 10, 28, 21, 39);
    await writePng(w0, join(dir, 'walk_0.png'));
    await writePng(w1, join(dir, 'walk_1.png'));
    await writePng(idle, join(dir, 'idle_0.png'));

    const out = join(tmp, 'mixed-pet');
    await fromFrames({ dir, outDir: out });
    expect((await diagnosePack(out)).errors).toBe(0);

    const manifest = await readManifest(out);
    const atlas = await loadRaster(join(out, 'atlas.png'));

    // Any start/count off-by-one in the group bookkeeping puts the wrong
    // content behind an animation — the widths tell them apart.
    const walkCells = manifest.animations['walk']!.frames;
    const idleCells = manifest.animations['idle']!.frames;
    expect(walkCells.map((i) => contentDims(atlas, manifest, i).w)).toEqual([9, 9]);
    expect(idleCells.map((i) => contentDims(atlas, manifest, i).w)).toEqual([12]);

    // The bob survives per-group alignment, and both groups stand on the
    // anchor row despite their different canvases.
    const bottom = (i: number) => {
      const c = cellAt(manifest, i);
      return trimBox(crop(atlas, c.x, c.y, c.w, c.h))!.y1;
    };
    expect(bottom(walkCells[0]!)).toBe(manifest.grid.h - 1);
    expect(bottom(walkCells[1]!)).toBe(manifest.grid.h - 2);
    expect(bottom(idleCells[0]!)).toBe(manifest.grid.h - 1);
  });

  it('refuses the downscale when not every frame divides by the detected factor', async () => {
    const dir = join(tmp, 'frames-nodivide');
    await mkdir(dir, { recursive: true });
    // walk looks like a clean 2x upscale (32x32), but idle's canvas is 31px —
    // a downscale would change the animations' relative scale, so: refuse.
    const walkNative = raggedSprite(16, 16, 1);
    await writePng(upscale(walkNative, 2), join(dir, 'walk_0.png'));
    const idle = makeRaster(31, 31);
    rect(idle, 8, 18, 20, 30);
    await writePng(idle, join(dir, 'idle_0.png'));

    const out = join(tmp, 'nodivide-pet');
    await fromFrames({ dir, outDir: out });
    const manifest = await readManifest(out);
    const atlas = await loadRaster(join(out, 'atlas.png'));

    // Content stays at FILE resolution — the 2x walk art is untouched.
    const nb = trimBox(walkNative)!;
    const walkDims = contentDims(atlas, manifest, manifest.animations['walk']!.frames[0]!);
    expect(walkDims).toEqual({ w: (nb.x1 - nb.x0 + 1) * 2, h: (nb.y1 - nb.y0 + 1) * 2 });
  });
});

describe('from-gif', () => {
  async function writeAnimated(
    file: string,
    frames: Raster[],
    delayMs: number[],
    format: 'gif' | 'webp',
  ): Promise<void> {
    const w = frames[0]!.w;
    const h = frames[0]!.h;
    const joined = Buffer.concat(frames.map((f) => Buffer.from(f.data)));
    let img = sharp(joined, { raw: { width: w, height: h * frames.length, channels: 4, pageHeight: h } });
    img = format === 'gif' ? img.gif({ delay: delayMs }) : img.webp({ lossless: true, delay: delayMs });
    await writeFile(file, await img.toBuffer());
  }

  it('derives fps from the modal delay', async () => {
    // Distinct frames on purpose: webp/gif encoders may merge byte-identical
    // consecutive frames themselves (sharp's webpsave does), so duplicate
    // handling is unit-tested against collapseDuplicates, not the encoder.
    const frames = [0, 1, 2].map((i) => {
      const r = makeRaster(20, 20);
      rect(r, 2 + i * 5, 10, 8 + i * 5, 19);
      return r;
    });
    const file = join(tmp, 'walk.webp');
    await writeAnimated(file, frames, [100, 100, 100], 'webp');

    const out = join(tmp, 'gif-pet');
    await fromGif({ inputs: [file], outDir: out });

    const d = await diagnosePack(out);
    expect(d.errors).toBe(0);

    const manifest = await readManifest(out);
    expect(manifest.grid.count).toBe(3);
    expect(manifest.animations['walk']).toEqual({ frames: [0, 1, 2], fps: 10 });
  });

  it('preserves held poses: a frame with 3x the modal delay plays three times', async () => {
    const frames = [0, 1, 2].map((i) => {
      const r = makeRaster(20, 20);
      rect(r, 2 + i * 5, 10, 8 + i * 5, 19);
      return r;
    });
    const file = join(tmp, 'held.webp');
    await writeAnimated(file, frames, [100, 300, 100], 'webp');

    const out = join(tmp, 'held-pet');
    await fromGif({ inputs: [file], outDir: out });

    const manifest = await readManifest(out);
    expect(manifest.grid.count).toBe(3);
    expect(manifest.animations['held']).toEqual({ frames: [0, 1, 1, 1, 2], fps: 10 });
  });

  it('maps several files of different sizes onto one atlas with correct offsets', async () => {
    // walk: 3 frames, 20x20, 7px-wide content. idle: 2 frames, 16x24, 11px.
    const walkFrames = [0, 1, 2].map((i) => {
      const r = makeRaster(20, 20);
      rect(r, 2 + i * 3, 10, 8 + i * 3, 19);
      return r;
    });
    const idleFrames = [0, 1].map((i) => {
      const r = makeRaster(16, 24);
      rect(r, 2, 12 - i, 12, 23 - i, [40, 200, 90]);
      return r;
    });
    const walkFile = join(tmp, 'walk-multi.webp');
    const idleFile = join(tmp, 'idle-multi.gif');
    await writeAnimated(walkFile, walkFrames, [100, 100, 100], 'webp');
    await writeAnimated(idleFile, idleFrames, [50, 50], 'gif');

    const out = join(tmp, 'multi-gif-pet');
    await fromGif({ inputs: [walkFile, idleFile], outDir: out });
    expect((await diagnosePack(out)).errors).toBe(0);

    const manifest = await readManifest(out);
    expect(manifest.grid.count).toBe(5);
    expect(manifest.animations['walk-multi']).toEqual({ frames: [0, 1, 2], fps: 10 });
    expect(manifest.animations['idle-multi']).toEqual({ frames: [3, 4], fps: 20 });

    // The idle cells must actually hold the idle art — base-offset arithmetic
    // gone wrong points them at walk frames, whose content is 7px wide.
    const atlas = await loadRaster(join(out, 'atlas.png'));
    for (const i of manifest.animations['idle-multi']!.frames) {
      expect(contentDims(atlas, manifest, i).w).toBe(11);
    }
    for (const i of manifest.animations['walk-multi']!.frames) {
      expect(contentDims(atlas, manifest, i).w).toBe(7);
    }
  });

  it('rejects --anim with several inputs, and colliding animation names', async () => {
    const f = makeRaster(16, 16);
    rect(f, 4, 8, 11, 15);
    const a = join(tmp, 'reject-a.gif');
    const b = join(tmp, 'reject-b.gif');
    const bCollide = join(tmp, 'Reject-A.gif'); // slugs to the same name as a
    await writeAnimated(a, [f, f], [100, 100], 'gif');
    await writeAnimated(b, [f, f], [100, 100], 'gif');
    await writeAnimated(bCollide, [f, f], [100, 100], 'gif');

    await expect(
      fromGif({ inputs: [a, b], outDir: join(tmp, 'r1'), anim: 'walk' }),
    ).rejects.toThrow(/single animation/);
    await expect(fromGif({ inputs: [a, bCollide], outDir: join(tmp, 'r2') })).rejects.toThrow(
      /same animation name/,
    );
  });

  it('undoes a 2x export, re-aligning groups at the native scale', async () => {
    const nat = [raggedSprite(20, 20, 0), raggedSprite(20, 20, 4)];
    const file = join(tmp, 'up2.webp');
    await writeAnimated(file, nat.map((f) => upscale(f, 2)), [100, 100], 'webp');

    const out = join(tmp, 'up2-gif-pet');
    await fromGif({ inputs: [file], outDir: out });
    expect((await diagnosePack(out)).errors).toBe(0);

    const manifest = await readManifest(out);
    expect(manifest.pixelArt).toBe(true);
    const atlas = await loadRaster(join(out, 'atlas.png'));
    // Cells hold the NATIVE-scale content. If the groups were not re-aligned
    // after the downscale, stale full-size boxes would blit garbage or double
    // the cell, and these dims would be 2x off.
    manifest.animations['up2']!.frames.forEach((f, i) => {
      const want = trimBox(nat[i]!)!;
      expect(contentDims(atlas, manifest, f)).toEqual({
        w: want.x1 - want.x0 + 1,
        h: want.y1 - want.y0 + 1,
      });
    });
  });

  it('imports a real GIF and names the animation from the file', async () => {
    const frames = [0, 1, 2].map((i) => {
      const r = makeRaster(16, 16);
      rect(r, 2 + i * 3, 8, 7 + i * 3, 15, [40, 200, 90]);
      return r;
    });
    const file = join(tmp, 'Bounce Loop.gif');
    await writeAnimated(file, frames, [50, 50, 50], 'gif');

    const out = join(tmp, 'gif2-pet');
    await fromGif({ inputs: [file], outDir: out });

    const d = await diagnosePack(out);
    expect(d.errors).toBe(0);
    const manifest = await readManifest(out);
    expect(Object.keys(manifest.animations)).toEqual(['bounce-loop']);
    expect(manifest.animations['bounce-loop']!.fps).toBe(20);
    expect(manifest.animations['bounce-loop']!.frames).toHaveLength(3);
  });
});

describe('from-image', () => {
  it('turns one JPEG on a plain backdrop into a walking rigged pack', async () => {
    // A rounded red creature with feet, on white, saved as an actual JPEG —
    // no alpha channel at all, plus compression noise.
    const src = makeRaster(64, 64);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) rect(src, x, y, x, y, [250, 250, 250]);
    for (let y = 14; y < 50; y++) {
      for (let x = 12; x < 52; x++) {
        const dx = (x - 32) / 20, dy = (y - 32) / 18;
        if (dx * dx + dy * dy <= 1) rect(src, x, y, x, y);
      }
    }
    rect(src, 20, 50, 26, 57); // legs reach the "ground"
    rect(src, 38, 50, 44, 57);
    const input = join(tmp, 'creature.jpg');
    await writeFile(
      input,
      await sharp(Buffer.from(src.data), { raw: { width: 64, height: 64, channels: 4 } })
        .flatten({ background: '#fafafa' })
        .jpeg({ quality: 92 })
        .toBuffer(),
    );

    const out = join(tmp, 'image-pet');
    await fromImage({ input, outDir: out });
    expect((await diagnosePack(out)).errors).toBe(0);

    const manifest = JSON.parse(await readFile(join(out, 'pet.json'), 'utf8')) as EmittedManifest & {
      rig: { type: string; gaits: Record<string, { strideLength?: number }> };
    };
    expect(manifest.grid.count).toBe(1);
    expect(manifest.rig.type).toBe('procedural');
    expect(manifest.rig.gaits['walk']!.strideLength).toBeGreaterThan(10);

    // The backdrop is gone and the feet sit on the anchor row.
    const atlas = await loadRaster(join(out, 'atlas.png'));
    const c = cellAt(manifest, 0);
    const cell = crop(atlas, c.x, c.y, c.w, c.h);
    const content = trimBox(cell)!;
    expect(content.y1).toBe(manifest.grid.h - 1);
    // Corners of the cell are transparent — the white is removed.
    expect(trimBox(cell)!.x0).toBeGreaterThan(0);

    // And the rig actually animates through the real deriveFrame: mid-stride
    // the pet lifts and squashes; at contact it lands back on its feet.
    const pack = resolvePack(JSON.parse(await readFile(join(out, 'pet.json'), 'utf8')));
    const stride = manifest.rig.gaits['walk']!.strideLength!;
    const base = {
      x: 50, y: 90, vx: 0, vy: 0, facing: 1 as const,
      standingOn: 'floor:0', climbingOn: null, climbSide: 1 as const, climbDir: -1 as const,
      // behaviorT past the gait's ease-in window, or the deformation is
      // (correctly) still neutral.
      hangingOn: null, behavior: 'walk' as const, behaviorT: 500, behaviorDur: 1000,
      anim: 'walk', animT: 0, simT: 0, odometer: 0, motionEma: 0, rng: 1,
      hidden: false, worldRev: 0,
    };
    const contact = deriveFrame(pack, base);
    const apex = deriveFrame(pack, { ...base, odometer: stride / 4 });
    expect(contact.y).toBe(90);
    expect(apex.y).toBeLessThan(90);
    expect(apex.squash.sx * apex.squash.sy).toBeCloseTo(1, 10);
  });

  it('gives hi-res smooth art an atlas.scale so it renders at pet size', async () => {
    // A 260px-tall smooth creature on white: the pixels must stay in the
    // file, but the pack has to render ~64px — atlas.scale, not resampling.
    const src = makeRaster(320, 320);
    for (let y = 0; y < 320; y++) for (let x = 0; x < 320; x++) rect(src, x, y, x, y, [250, 250, 250]);
    for (let y = 40; y < 280; y++) {
      for (let x = 60; x < 260; x++) {
        const dx = (x - 160) / 100, dy = (y - 160) / 120;
        if (dx * dx + dy * dy <= 1) rect(src, x, y, x, y, [(x / 2) & 255, 90, 120]);
      }
    }
    const input = join(tmp, 'big.jpg');
    await writeFile(
      input,
      await sharp(Buffer.from(src.data), { raw: { width: 320, height: 320, channels: 4 } })
        .flatten({ background: '#fafafa' })
        .jpeg({ quality: 92 })
        .toBuffer(),
    );

    const out = join(tmp, 'big-pet');
    await fromImage({ input, outDir: out });
    expect((await diagnosePack(out)).errors).toBe(0);
    const manifest = JSON.parse(await readFile(join(out, 'pet.json'), 'utf8')) as {
      atlas: { scale?: number };
      rig: { gaits: Record<string, { strideLength?: number }> };
    };
    expect(manifest.atlas.scale).toBeGreaterThan(2); // ~240/64
    // Stride is in world px, i.e. displayed size — a fraction of file px.
    expect(manifest.rig.gaits['walk']!.strideLength).toBeLessThan(80);
    expect(manifest.rig.gaits['walk']!.strideLength).toBeGreaterThan(10);
  });

  it('one stray near-opaque pixel does not disable background removal', async () => {
    // A matte fringe artifact: opaque white backdrop, red creature, ONE pixel
    // of alpha 254. The old any-alpha-at-all gate called this "already cut
    // out" and imported a walking rectangle.
    const src = makeRaster(40, 40);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) rect(src, x, y, x, y, [250, 250, 250]);
    for (let y = 10; y < 33; y++) for (let x = 8; x < 30; x++) if ((x + y) % 9 !== 0) rect(src, x, y, x, y);
    src.data[(5 * 40 + 5) * 4 + 3] = 254;
    const input = join(tmp, 'fringe.png');
    await writePng(src, input);

    const out = join(tmp, 'fringe-pet');
    await fromImage({ input, outDir: out });
    const atlas = await loadRaster(join(out, 'atlas.png'));
    const manifest = await readManifest(out);
    const dims = contentDims(atlas, manifest, 0);
    expect(dims.w).toBeLessThan(30); // the creature, not the 40px backdrop
  });

  it('errors rather than emitting an empty pet when removal eats everything', async () => {
    const solid = makeRaster(24, 24);
    for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) rect(solid, x, y, x, y);
    const input = join(tmp, 'solid.png');
    await writePng(solid, input);
    await expect(fromImage({ input, outDir: join(tmp, 'x-img') })).rejects.toThrow(/nothing left/);
  });

  it('trusts existing transparency instead of flood-filling it', async () => {
    const cut = makeRaster(32, 32);
    rect(cut, 8, 10, 23, 29); // already on transparent background...
    rect(cut, 8, 30, 16, 30); // ...with a ragged foot row (odd runs — see
    // detectForImport: a plain even-sided rect reads as an accidental 2x)
    const input = join(tmp, 'cut.png');
    await writePng(cut, input);
    const out = join(tmp, 'cut-pet');
    await fromImage({ input, outDir: out });
    expect((await diagnosePack(out)).errors).toBe(0);
    const atlas = await loadRaster(join(out, 'atlas.png'));
    const manifest = await readManifest(out);
    expect(contentDims(atlas, manifest, 0)).toEqual({ w: 16, h: 21 });
  });
});

describe('assembleAnimations', () => {
  it('offsets by unique-frame count, not play length', () => {
    // A gif with collapsed duplicates has play.length > uniqueCount. Using
    // play.length as the offset misindexes every animation after the first —
    // and real encoders merge duplicates at encode time, so only a pure test
    // can pin this.
    const out = assembleAnimations([
      { anim: 'walk', play: [0, 0, 1], uniqueCount: 2, fps: 10 },
      { anim: 'idle', play: [0, 1], uniqueCount: 2, fps: 4 },
    ]);
    expect(out[0]).toEqual({ name: 'walk', frames: [0, 0, 1], fps: 10 });
    expect(out[1]).toEqual({ name: 'idle', frames: [2, 3], fps: 4 });
  });
});

describe('doctor', () => {
  it('passes the shipped blob pack — the canary', async () => {
    const d = await diagnosePack(join(repoRoot, 'packs', 'blob'));
    expect(d.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(d.pack?.id).toBe('blob');
  });

  it('catches out-of-bounds cells and dead aliases', async () => {
    const dir = join(tmp, 'broken-pack');
    await mkdir(dir, { recursive: true });
    const atlas = makeRaster(16, 16);
    rect(atlas, 2, 2, 13, 15);
    await writePng(atlas, join(dir, 'atlas.png'));
    await writeFile(
      join(dir, 'pet.json'),
      JSON.stringify({
        format: 'blerb-pet/1',
        id: 'broken',
        name: 'Broken',
        atlas: { src: 'atlas.png' },
        grid: { w: 16, h: 16, cols: 4 },
        animations: { idle: { frames: [0, 3] } }, // frame 3 is off the 16px-wide atlas
        aliases: { walk: 'sprint' }, // sprint does not exist
      }),
    );

    const d = await diagnosePack(dir);
    expect(d.errors).toBeGreaterThan(0);
    expect(d.findings.some((f) => f.message.includes('outside'))).toBe(true);
    expect(d.findings.some((f) => f.severity === 'warn' && f.message.includes('sprint'))).toBe(true);
  });

  it('reports an unreadable pack as an error, not a crash', async () => {
    const d = await diagnosePack(join(tmp, 'does-not-exist'));
    expect(d.errors).toBeGreaterThan(0);
  });

  it('catches an alias cycle that never reaches a real animation', async () => {
    const dir = join(tmp, 'cycle-pack');
    await mkdir(dir, { recursive: true });
    const atlas = makeRaster(16, 16);
    rect(atlas, 2, 2, 13, 15);
    await writePng(atlas, join(dir, 'atlas.png'));
    await writeFile(
      join(dir, 'pet.json'),
      JSON.stringify({
        format: 'blerb-pet/1',
        id: 'cycle',
        name: 'Cycle',
        atlas: { src: 'atlas.png' },
        grid: { w: 16, h: 16, cols: 1 },
        animations: { idle: { frames: [0] } },
        // Neither exists; each points at the other. A one-hop check called
        // this fine because the target "is an alias".
        aliases: { dance: 'boogie', boogie: 'dance' },
      }),
    );
    const d = await diagnosePack(dir);
    expect(
      d.findings.filter((f) => f.severity === 'warn' && f.message.includes('never reaches')),
    ).toHaveLength(2);
  });

  it('warns when every frame floats above its anchor row — and only then', async () => {
    const mkPack = async (name: string, bottomRow: number) => {
      const dir = join(tmp, name);
      await mkdir(dir, { recursive: true });
      const atlas = makeRaster(16, 16);
      rect(atlas, 4, 2, 11, bottomRow);
      await writePng(atlas, join(dir, 'atlas.png'));
      await writeFile(
        join(dir, 'pet.json'),
        JSON.stringify({
          format: 'blerb-pet/1',
          id: 'f',
          name: 'F',
          atlas: { src: 'atlas.png' },
          grid: { w: 16, h: 16, cols: 1 },
          animations: { idle: { frames: [0] } },
        }),
      );
      return diagnosePack(dir);
    };
    const floating = await mkPack('float-pack', 10); // stops 5px above row 15
    expect(floating.findings.some((f) => f.severity === 'warn' && f.message.includes('float'))).toBe(true);
    const grounded = await mkPack('grounded-pack', 15);
    expect(grounded.findings.some((f) => f.message.includes('float'))).toBe(false);
  });
});
