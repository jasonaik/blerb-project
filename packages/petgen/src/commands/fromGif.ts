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
 *
 * Every file is its own art source, so backdrop removal and the pixel-art
 * verdict are PER FILE. That is what lets one import mix a 26px pixel-art
 * walk with a 1000px hand-drawn flourish: the smooth art is resampled down
 * to the pixel art's size (or `--height`) so the two share an atlas at one
 * scale, instead of the atlas builder padding every cell out to a thousand
 * pixels. The one thing decided ACROSS files is the upscale factor of the
 * pixel-art ones — they were drawn at one scale, and a per-file GCD can be a
 * two-frame coincidence.
 */

import { alignGroup, buildAtlas, type AlignedFrame } from '../import/layout.js';
import { loadAnimated, resampleRaster } from '../import/io.js';
import {
  collapseDuplicates,
  hasAlphaChannel,
  transparentFraction,
  trimBox,
  unionBox,
  type Box,
  type Raster,
} from '../import/raster.js';
import { detectForImport, downscaleBy } from '../import/pixelart.js';
import { erodeEdge, removeBackground, sharedBackdrop } from '../import/bgremove.js';
import { emitPack, idFromOutDir, type EmitAnimation } from '../import/emit.js';
import { slugFromFilename } from '../import/spec.js';

export interface FromGifOptions {
  inputs: string[];
  outDir: string;
  /** Animation name; only valid with a single input. */
  anim?: string | undefined;
  /**
   * Per-input animation names, parallel to `inputs`; an undefined entry falls
   * back to the filename slug. For callers whose files aren't named after
   * their animations (batch imports, GUI file pickers).
   */
  animNames?: (string | undefined)[] | undefined;
  /** designSpeed (px/s) per animation name — feet-locks that cycle. */
  speeds?: Record<string, number> | undefined;
  /** Alias map written into the manifest, e.g. { climb: 'walk' }. */
  aliases?: Record<string, string> | undefined;
  /** Backdrop tolerance 0..1 for opaque inputs (corner flood fill). Default 0.1. */
  tolerance?: number | undefined;
  /** Skip background removal — the alpha is already right, or the backdrop is wanted. */
  keepBg?: boolean | undefined;
  /**
   * Content height, in atlas px, that SMOOTH-art animations are resampled to.
   * Pixel art is never resampled. Default: match the pixel-art animations in
   * the same import, if any; otherwise keep full resolution and set
   * atlas.scale so the pet renders ~64px tall.
   */
  height?: number | undefined;
  /**
   * Override the pixel-art verdict for every file: true = pixel art (native,
   * no erode, nearest-neighbour), false = smooth. Any heuristic misfires
   * somewhere — pixel art on a dithered backdrop still reads smooth — and
   * this is the way out.
   */
  pixelArt?: boolean | undefined;
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
  pixelArt: boolean;
  removalRan: boolean;
  hardCut: boolean;
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

/** Height of a group's registered content: the union of every frame's bounds. */
function contentHeight(frames: readonly Raster[]): number {
  let union: Box | null = null;
  for (const f of frames) {
    const b = trimBox(f);
    if (b) union = union ? unionBox(union, b) : b;
  }
  return union ? union.y1 - union.y0 + 1 : 0;
}

/**
 * Below this multiple of the pixel art's height, a "smooth" sibling is far
 * more likely a misclassified pixel-art file (>64 colours, a dithered
 * export) than a painting — and a Lanczos pass at a factor near 1.0 turns a
 * hard 1px outline into a halo. Hi-res art is never this close.
 */
const NEAR_SIZE = 2;

const baseName = (p: string): string => p.replace(/\\/g, '/').split('/').pop() ?? p;

export async function fromGif(o: FromGifOptions): Promise<string> {
  if (o.inputs.length === 0) throw new Error('from-gif needs at least one animated image');
  if (o.anim && o.inputs.length > 1) {
    throw new Error('--anim names a single animation — with several inputs, name the files instead');
  }
  if (o.animNames && o.animNames.length !== o.inputs.length) {
    throw new Error(`animNames must parallel inputs (${o.animNames.length} names for ${o.inputs.length} files)`);
  }
  if (o.height !== undefined && !(o.height >= 4)) {
    throw new Error(`--height must be at least 4px, got ${o.height}`);
  }

  const groups: GifGroup[] = [];
  for (const [idx, input] of o.inputs.entries()) {
    const name = baseName(input);
    const { frames: raw, delaysMs } = await loadAnimated(input);
    if (raw.length < 2) {
      const apng = /\.a?png$/i.test(input)
        ? ' (APNG animation cannot be decoded — convert to GIF or WebP first)'
        : '';
      console.warn(`${name} has a single frame — importing it as a one-frame animation${apng}`);
    }

    // Collapse byte-identical consecutive frames into repeated indices.
    const { unique, play } = collapseDuplicates(raw);
    let frames: Raster[] = unique;

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
        `${name}: frame delays (${Math.min(...delaysMs)}–${Math.max(...delaysMs)}ms) are not ` +
          `multiples of the base ${delay}ms tick — timing is approximated to the nearest multiple.`,
      );
    }
    const fps = Math.min(50, Math.max(1, Math.round((1000 / delay) * 100) / 100));

    // --- backdrop ---------------------------------------------------------
    // GIFs downloaded from anywhere are usually opaque: the encoder flattened
    // the art onto white. Same rule as from-image — "already cut out" means a
    // MEANINGFUL amount of the canvas is transparent, and the fill is from
    // the corners so a white character keeps its interior whites. The
    // backdrop colours are sampled ONCE per file, across frames: a frame with
    // a foot in a corner must not sample the character as its backdrop.
    let removalRan = false;
    let hardCut = false;
    const alreadyCut = frames.some((f) => transparentFraction(f) >= 0.02);
    if (!alreadyCut && !o.keepBg) {
      const backdrop = sharedBackdrop(frames);
      const cut = frames.map((f) => removeBackground(f, o.tolerance ?? 0.1, backdrop));
      const removed = Math.min(...cut.map((c) => c.removed));
      if (removed < 0.02) {
        console.warn(
          `${name}: no backdrop found from the corners — the character may fill the frame, ` +
            'or the background is too varied for a flood fill. Importing as-is.',
        );
      } else {
        console.log(`${name}: removed backdrop (${Math.round(removed * 100)}% of the canvas)`);
        frames = cut.map((c) => c.out);
        removalRan = true;
        hardCut = cut.every((c) => c.hardCut);
      }
    }

    // --- pixel art, per file ---------------------------------------------
    // A flood-filled alpha channel is binary by construction and must not
    // count as pixel-art evidence — but a HARD cut is the same evidence,
    // still visible in the RGB, and stands in for it.
    const detected = detectForImport(frames, { alphaSynthetic: removalRan, hardEdge: hardCut });
    const pixelArt = o.pixelArt ?? detected.pixelArt;
    if (o.pixelArt !== undefined && o.pixelArt !== detected.pixelArt) {
      console.log(`${name}: treated as ${pixelArt ? 'pixel art' : 'smooth art'} (override)`);
    }
    if (!pixelArt && removalRan) {
      // Feather the cut edge on smooth art; pixel art keeps its hard outline.
      frames = frames.map(erodeEdge);
    }
    if (!frames.some((f) => trimBox(f) !== null)) {
      throw new Error(`${name}: nothing left after background removal — try a lower --tolerance`);
    }

    const anim = o.anim ?? o.animNames?.[idx] ?? slugFromFilename(input);
    groups.push({ anim, frames, play: timedPlay, fps, pixelArt, removalRan, hardCut });
  }

  const dupNames = groups.map((g) => g.anim).filter((n, i, a) => a.indexOf(n) !== i);
  if (dupNames.length > 0) {
    throw new Error(`two inputs produce the same animation name: ${dupNames.join(', ')}`);
  }

  if (!groups.some((g) => g.frames.some(hasAlphaChannel))) {
    console.warn(
      'no transparency anywhere — the pet will be a solid rectangle. ' +
        'Export with a transparent background, or a plain backdrop the corner flood fill can find.',
    );
  }

  const pixelGroups = groups.filter((g) => g.pixelArt);
  const smoothGroups = groups.filter((g) => !g.pixelArt);
  const heightOf = (g: GifGroup) => contentHeight(g.frames);

  // --- one upscale factor for every pixel-art file, or none ---------------
  // Detection over ALL their frames stacked, as from-frames does: a single
  // file's run GCD can be a two-frame coincidence, and one file downscaled
  // 2x beside its siblings at native size is a pet half the size of itself.
  if (pixelGroups.length > 0) {
    const shared = detectForImport(
      pixelGroups.flatMap((g) => g.frames),
      {
        alphaSynthetic: pixelGroups.some((g) => g.removalRan),
        hardEdge: pixelGroups.every((g) => !g.removalRan || g.hardCut),
      },
    );
    if (shared.scale >= 2) {
      const k = shared.scale;
      if (pixelGroups.every((g) => g.frames.every((f) => f.w % k === 0 && f.h % k === 0))) {
        console.log(`pixel art upscaled ${k}x — importing at native resolution`);
        for (const g of pixelGroups) g.frames = g.frames.map((f) => downscaleBy(f, k));
      } else {
        console.warn(`looks like pixel art upscaled ${k}x, but the frames do not divide by ${k} — leaving as-is`);
      }
    }
  }

  // --- one scale for the whole atlas -------------------------------------
  // Pixel art is always native. Smooth art either comes down to the pixel
  // art's size (they must share a cell size, and a 1000px cell around a 26px
  // sprite is not a pet), or — with no pixel art to match — to the smallest
  // smooth file (never inventing pixels), and then stays at that resolution
  // with atlas.scale set so it renders ~64px, keeping the pixels in the file
  // for anyone who turns the pet size up.
  let atlasScale = 1;
  if (smoothGroups.length > 0) {
    const matchH = pixelGroups.length > 0 ? Math.max(...pixelGroups.map(heightOf)) : 0;
    const smoothHs = smoothGroups.map(heightOf).filter((h) => h > 0);
    const targetH =
      o.height ?? (matchH > 0 ? matchH : new Set(smoothHs).size > 1 ? Math.min(...smoothHs) : undefined);
    if (targetH !== undefined) {
      for (const g of smoothGroups) {
        const h = heightOf(g);
        if (h === 0 || h === targetH) continue;
        if (o.height === undefined) {
          // Matching only ever shrinks, and only art that is clearly hi-res.
          if (h < targetH) continue;
          if (matchH > 0 && h <= NEAR_SIZE * targetH) {
            console.warn(
              `${g.anim}: ${h}px tall is close to the pixel art's ${targetH}px — leaving it unresampled ` +
                `(it may be pixel art with many colours; pass --pixel-art, or --height ${targetH} to force)`,
            );
            continue;
          }
        }
        const f = targetH / h;
        const first = g.frames[0]!;
        const w2 = Math.max(1, Math.round(first.w * f));
        const h2 = Math.max(1, Math.round(first.h * f));
        console.log(
          `${g.anim}: smooth art ${h}px tall — resampling to ${targetH}px` +
            (o.height === undefined ? (matchH > 0 ? ' to match the pixel art' : ' to match the smallest file') + ' (override with --height)' : ''),
        );
        g.frames = await Promise.all(g.frames.map((fr) => resampleRaster(fr, w2, h2)));
      }
    }
    if (pixelGroups.length === 0 && o.height === undefined) {
      const maxH = Math.max(...smoothGroups.map(heightOf));
      if (maxH > 128) {
        atlasScale = Math.round((maxH / 64) * 100) / 100;
        console.log(`hi-res art (${maxH}px tall) — setting atlas.scale ${atlasScale} so it renders ~64px`);
      }
    }
  }
  // Any pixel art in the atlas needs nearest-neighbour sampling: the smooth
  // files have been brought to its size, and blocky smooth art is a far
  // smaller failure than a smeared primary walk.
  const pixelArt = pixelGroups.length > 0;

  // Each file's frames share that file's canvas: one registered group per
  // file, cell size unified across groups by the atlas builder.
  const perGroup: AlignedFrame[][] = groups.map((g) => alignGroup(g.frames));
  const layout = buildAtlas(perGroup.flat());

  const animations = assembleAnimations(
    groups.map((g) => ({ anim: g.anim, play: g.play, uniqueCount: g.frames.length, fps: g.fps })),
  );
  // Case-insensitive on purpose, and a leftover key is an ERROR: animation
  // names are lowercased filename slugs, so `--speed Walk=27` matching
  // nothing silently is the exact trap parseFpsFlags already documents —
  // and a silently dropped speed means feet that skate with zero feedback.
  if (o.speeds) {
    const byLower = new Map(animations.map((a) => [a.name.toLowerCase(), a]));
    const unmatched: string[] = [];
    for (const [key, speed] of Object.entries(o.speeds)) {
      const a = byLower.get(key.toLowerCase());
      if (a) a.designSpeed = speed;
      else unmatched.push(key);
    }
    if (unmatched.length > 0) {
      throw new Error(
        `--speed names no animation: ${unmatched.join(', ')} — this import produces ${animations
          .map((a) => a.name)
          .join(', ')}`,
      );
    }
  }

  const id = o.id ?? idFromOutDir(o.outDir);
  return emitPack({
    outDir: o.outDir,
    id,
    name: o.name ?? id,
    author: o.author ?? 'unknown',
    license: o.license ?? 'unknown',
    source: `from-gif ${o.inputs.map(baseName).join(', ')}`,
    pixelArt,
    layout,
    atlasScale,
    animations,
    aliases: o.aliases,
  });
}
