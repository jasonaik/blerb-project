/**
 * `petgen from-gif <gif|webp|apng>... -o packs/x`
 *
 * Tier 3: animated images. One file = one animation, named from the file
 * (walk.gif → walk) or --anim for a single input.
 *
 * fps comes from the modal frame delay. Consecutive duplicate frames — GIF
 * optimizers love emitting them — are stored ONCE in the atlas and repeated by
 * index in the animation's frame list, so the timing survives without the
 * atlas paying for identical pixels.
 */

import { alignGroup, buildAtlas, type AlignedFrame } from '../import/layout.js';
import { loadAnimated } from '../import/io.js';
import { collapseDuplicates, hasAlphaChannel, type Raster } from '../import/raster.js';
import { detectForImport, downscaleBy } from '../import/pixelart.js';
import { emitPack, idFromOutDir, type EmitAnimation } from '../import/emit.js';
import { slugFromFilename } from '../import/spec.js';

export interface FromGifOptions {
  inputs: string[];
  outDir: string;
  /** Animation name; only valid with a single input. */
  anim?: string | undefined;
  id?: string | undefined;
  name?: string | undefined;
  author?: string | undefined;
  license?: string | undefined;
}

interface GifGroup {
  anim: string;
  /** Unique frames, in first-appearance order. */
  frames: Raster[];
  /** Indices into `frames`, one per original frame — duplicates repeat. */
  play: number[];
  fps: number;
}

/**
 * Map per-file play lists onto one shared atlas index space.
 *
 * Exported and pure because the offset arithmetic is exactly the kind of thing
 * an encoder hides: real gif/webp encoders merge duplicate frames themselves,
 * so no end-to-end test can reliably produce a group where play.length >
 * uniqueCount — and that is precisely the case where using play.length as the
 * offset would misindex every animation after the first.
 */
export function assembleAnimations(
  groups: readonly { anim: string; play: readonly number[]; uniqueCount: number; fps: number }[],
): EmitAnimation[] {
  const out: EmitAnimation[] = [];
  let base = 0;
  for (const g of groups) {
    out.push({ name: g.anim, frames: g.play.map((i) => base + i), fps: g.fps });
    base += g.uniqueCount;
  }
  return out;
}

/** Most common value. Ties go to the earlier value, which is the front of the loop. */
function modal(xs: readonly number[]): number {
  const counts = new Map<number, number>();
  let best = xs[0]!;
  let bestN = 0;
  for (const x of xs) {
    const n = (counts.get(x) ?? 0) + 1;
    counts.set(x, n);
    if (n > bestN) {
      best = x;
      bestN = n;
    }
  }
  return best;
}

export async function fromGif(o: FromGifOptions): Promise<string> {
  if (o.inputs.length === 0) throw new Error('from-gif needs at least one animated image');
  if (o.anim && o.inputs.length > 1) {
    throw new Error('--anim names a single animation — with several inputs, name the files instead');
  }

  const groups: GifGroup[] = [];
  for (const input of o.inputs) {
    const { frames, delaysMs } = await loadAnimated(input);
    if (frames.length < 2) {
      const apng = /\.a?png$/i.test(input)
        ? ' (APNG animation cannot be decoded — convert to GIF or WebP first)'
        : '';
      console.warn(`${input} has a single frame — importing it as a one-frame animation${apng}`);
    }

    // Collapse byte-identical consecutive frames into repeated indices.
    const { unique, play } = collapseDuplicates(frames);

    // Variable frame timing — real sprite GIFs hold key poses 2-3x longer
    // than the base tick — survives as repeated indices: a 150ms frame at a
    // 50ms modal delay is played three times. Found by importing actual
    // Gen-5 battle sprites, where flattening to the modal rate visibly
    // rushed every held pose.
    const delay = modal(delaysMs);
    const repeats = delaysMs.map((d) => Math.max(1, Math.min(8, Math.round(d / delay))));
    const timedPlay: number[] = [];
    play.forEach((u, j) => {
      for (let k = 0; k < repeats[j]!; k++) timedPlay.push(u);
    });
    // Only warn when a delay is badly off every multiple of the modal tick —
    // that part of the timing genuinely cannot be represented.
    const misfit = delaysMs.some((d) => Math.abs(d / delay - Math.round(d / delay)) > 0.25);
    if (misfit) {
      console.warn(
        `${input}: frame delays (${Math.min(...delaysMs)}–${Math.max(...delaysMs)}ms) are not ` +
          `multiples of the base ${delay}ms tick — timing is approximated to the nearest multiple.`,
      );
    }
    const fps = Math.min(50, Math.max(1, Math.round((1000 / delay) * 100) / 100));

    groups.push({ anim: o.anim ?? slugFromFilename(input), frames: unique, play: timedPlay, fps });
  }

  const dupNames = groups.map((g) => g.anim).filter((n, i, a) => a.indexOf(n) !== i);
  if (dupNames.length > 0) {
    throw new Error(`two inputs produce the same animation name: ${dupNames.join(', ')}`);
  }

  if (!groups.some((g) => g.frames.some(hasAlphaChannel))) {
    console.warn(
      'no transparency anywhere — the pet will be a solid rectangle. ' +
        'Export with a transparent background; automatic background removal arrives with from-image.',
    );
  }

  // Each file's frames share that file's canvas: one registered group per
  // file, cell size unified across groups by the atlas builder.
  let perGroup: AlignedFrame[][] = groups.map((g) => alignGroup(g.frames));

  // Pixel-art detection across every frame at once; a downscale must divide everything.
  const verdict = detectForImport(groups.flatMap((g) => g.frames));
  if (verdict.scale >= 2) {
    const k = verdict.scale;
    const allDivide = groups.every((g) => g.frames.every((f) => f.w % k === 0 && f.h % k === 0));
    if (allDivide) {
      console.log(`detected pixel art upscaled ${k}x — importing at native resolution`);
      for (const g of groups) g.frames = g.frames.map((f) => downscaleBy(f, k));
      perGroup = groups.map((g) => alignGroup(g.frames));
    } else {
      console.warn(`looks like pixel art upscaled ${k}x, but the frames do not divide by ${k} — leaving as-is`);
    }
  }

  const aligned = perGroup.flat();
  const layout = buildAtlas(aligned);

  const animations = assembleAnimations(
    groups.map((g) => ({ anim: g.anim, play: g.play, uniqueCount: g.frames.length, fps: g.fps })),
  );

  const id = o.id ?? idFromOutDir(o.outDir);
  return emitPack({
    outDir: o.outDir,
    id,
    name: o.name ?? id,
    author: o.author ?? 'unknown',
    license: o.license ?? 'unknown',
    source: `from-gif ${o.inputs.map((i) => i.replace(/\\/g, '/').split('/').pop()).join(', ')}`,
    pixelArt: verdict.pixelArt,
    layout,
    animations,
  });
}
