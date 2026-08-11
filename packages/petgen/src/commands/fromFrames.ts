/**
 * `petgen from-frames <dir> --pattern "{anim}_{i}.png" -o packs/x`
 *
 * Tier 2: a folder of frame files. The two things people get wrong by hand,
 * both handled here:
 *   - walk_10 sorts after walk_9 (numeric, not lexical)
 *   - frames are trimmed with ONE union box so the cells come out uniform and
 *     the anchor is consistent — per-frame tight-trimming deletes the bob
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { alignGroup, buildAtlas, type AlignedFrame } from '../import/layout.js';
import { loadRaster } from '../import/io.js';
import { detectForImport, downscaleBy } from '../import/pixelart.js';
import { emitPack, idFromOutDir, type EmitAnimation } from '../import/emit.js';
import { byIndex, makeNameParser, parseFpsFlags } from '../import/spec.js';
import type { Raster } from '../import/raster.js';

export interface FromFramesOptions {
  dir: string;
  outDir: string;
  pattern?: string | undefined;
  /** `8` or `walk=10`, repeatable. */
  fps?: string[] | undefined;
  id?: string | undefined;
  name?: string | undefined;
  author?: string | undefined;
  license?: string | undefined;
}

export async function fromFrames(o: FromFramesOptions): Promise<string> {
  const parse = makeNameParser(o.pattern);
  const { byAnim, fallback } = parseFpsFlags(o.fps ?? []);

  const files = (await readdir(o.dir)).filter((f) => /\.(png|webp)$/i.test(f));
  const grouped = new Map<string, { file: string; index: number }[]>();
  for (const file of files) {
    const parsed = parse(file);
    if (!parsed) {
      console.warn(`skipping ${file} — does not match the frame pattern`);
      continue;
    }
    const list = grouped.get(parsed.anim) ?? [];
    list.push({ file, index: parsed.index });
    grouped.set(parsed.anim, list);
  }
  if (grouped.size === 0) {
    throw new Error(
      `no frame files matched in ${o.dir} — expected names like walk_0.png, or pass --pattern`,
    );
  }

  // Numeric sort within each animation, animations in name order for stability.
  const animNames = [...grouped.keys()].sort();
  const loaded: { anim: string; frames: Raster[] }[] = [];
  for (const anim of animNames) {
    const entries = grouped
      .get(anim)!
      .map((e) => ({ anim, index: e.index, file: e.file }))
      .sort(byIndex);
    const frames: Raster[] = [];
    for (const e of entries) frames.push(await loadRaster(join(o.dir, e.file)));
    loaded.push({ anim, frames });
  }

  // Pixel-art detection across every frame at once (see detectForImport for
  // why one frame is not enough); a downscale must divide every frame or
  // none, or the animations would change relative scale.
  const verdict = detectForImport(loaded.flatMap((g) => g.frames));
  if (verdict.scale >= 2) {
    const k = verdict.scale;
    const allDivide = loaded.every((g) => g.frames.every((f) => f.w % k === 0 && f.h % k === 0));
    if (allDivide) {
      console.log(`detected pixel art upscaled ${k}x — importing at native resolution`);
      for (const g of loaded) g.frames = g.frames.map((f) => downscaleBy(f, k));
    } else {
      console.warn(`looks like pixel art upscaled ${k}x, but not every frame divides by ${k} — leaving as-is`);
    }
  }

  // Registration: if EVERY frame across every animation shares one canvas
  // size, they were exported off one canvas — union and anchor once, globally.
  // Otherwise each animation is its own registered group and the atlas builder
  // unifies cell size across groups in anchor space.
  const first = loaded[0]!.frames[0]!;
  const allSame = loaded.every((g) => g.frames.every((f) => f.w === first.w && f.h === first.h));

  let aligned: AlignedFrame[];
  const animRanges: { anim: string; start: number; count: number }[] = [];
  if (allSame) {
    const flat = loaded.flatMap((g) => g.frames);
    aligned = alignGroup(flat);
    let at = 0;
    for (const g of loaded) {
      animRanges.push({ anim: g.anim, start: at, count: g.frames.length });
      at += g.frames.length;
    }
  } else {
    console.warn(
      'frames are not all the same size — aligning each animation by its own anchor. ' +
        'If the result jitters, re-export every frame on one shared canvas.',
    );
    aligned = [];
    for (const g of loaded) {
      animRanges.push({ anim: g.anim, start: aligned.length, count: g.frames.length });
      aligned.push(...alignGroup(g.frames));
    }
  }

  const layout = buildAtlas(aligned);
  const animations: EmitAnimation[] = animRanges.map((r) => ({
    name: r.anim,
    frames: Array.from({ length: r.count }, (_, i) => r.start + i),
    fps: byAnim.get(r.anim) ?? fallback,
  }));

  const id = o.id ?? idFromOutDir(o.outDir);
  return emitPack({
    outDir: o.outDir,
    id,
    name: o.name ?? id,
    author: o.author ?? 'unknown',
    license: o.license ?? 'unknown',
    source: `from-frames ${o.dir.replace(/\\/g, '/').split('/').filter(Boolean).pop()}`,
    pixelArt: verdict.pixelArt,
    layout,
    animations,
  });
}
