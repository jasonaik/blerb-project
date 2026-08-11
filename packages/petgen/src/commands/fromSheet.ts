/**
 * `petgen from-sheet <png> --grid 32x32 --anim walk=0-3@8 -o packs/x`
 *
 * Tier 1: the author already has a sprite sheet on a uniform grid. We slice it,
 * re-derive the anchor from the art itself, and re-emit on OUR grid — which is
 * usually tighter than the source's, because source sheets are padded for
 * hand-editing room.
 */

import { alignGroup } from '../import/layout.js';
import { buildAtlas } from '../import/layout.js';
import { loadRaster } from '../import/io.js';
import { crop, trimBox, type Raster } from '../import/raster.js';
import { detectForImport, downscaleBy } from '../import/pixelart.js';
import { emitPack, idFromOutDir, type EmitAnimation } from '../import/emit.js';
import { parseAnimSpec, type AnimSpec } from '../import/spec.js';

export interface FromSheetOptions {
  input: string;
  outDir: string;
  /** Source cell size, "32x32". */
  grid: string;
  /** `walk=0-3@8` specs. At least one. */
  anims: string[];
  /** Source sheet layout, if it has gutters. Default 0. */
  spacing?: number | undefined;
  margin?: number | undefined;
  cols?: number | undefined;
  id?: string | undefined;
  name?: string | undefined;
  author?: string | undefined;
  license?: string | undefined;
}

export async function fromSheet(o: FromSheetOptions): Promise<string> {
  const gm = /^(\d+)x(\d+)$/i.exec(o.grid);
  if (!gm) throw new Error(`--grid must look like 32x32, got "${o.grid}"`);
  let cellW = Number(gm[1]);
  let cellH = Number(gm[2]);
  let spacing = o.spacing ?? 0;
  let margin = o.margin ?? 0;

  if (o.anims.length === 0) {
    throw new Error(
      'from-sheet needs at least one --anim, e.g. --anim walk=0-3@8 --anim idle=4,5@2',
    );
  }
  const specs: AnimSpec[] = o.anims.map(parseAnimSpec);
  const dup = specs.map((s) => s.name).find((n, i, a) => a.indexOf(n) !== i);
  if (dup) {
    // Emitting flattens animations into a record keyed by name — a repeat
    // would silently win, which reads as "my frames vanished".
    throw new Error(`--anim "${dup}" given twice — put all its frames in one spec`);
  }

  let sheet = await loadRaster(o.input);

  // Undo any nearest-neighbour upscale BEFORE slicing, so the grid the user
  // gave (in the file's own pixels) divides down with it.
  const verdict = detectForImport([sheet]);
  if (verdict.scale >= 2) {
    const k = verdict.scale;
    if (cellW % k === 0 && cellH % k === 0 && spacing % k === 0 && margin % k === 0) {
      console.log(`detected pixel art upscaled ${k}x — importing at native resolution`);
      sheet = downscaleBy(sheet, k);
      cellW /= k;
      cellH /= k;
      spacing /= k;
      margin /= k;
    } else {
      console.warn(
        `looks like pixel art upscaled ${k}x, but --grid ${o.grid} does not divide by ${k} — leaving as-is`,
      );
    }
  }

  const cols =
    o.cols ?? Math.max(1, Math.floor((sheet.w - 2 * margin + spacing) / (cellW + spacing)));

  // Unique source indices, in first-use order: that ordering becomes the
  // output atlas ordering, so animations map to contiguous runs where possible.
  const order: number[] = [];
  for (const s of specs) {
    for (const i of s.indices) if (!order.includes(i)) order.push(i);
  }

  const frames: Raster[] = order.map((i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = margin + col * (cellW + spacing);
    const y = margin + row * (cellH + spacing);
    if (x + cellW > sheet.w || y + cellH > sheet.h) {
      throw new Error(
        `frame ${i} (row ${row}, col ${col}) falls outside the ${sheet.w}x${sheet.h} sheet — ` +
          `check --grid/--cols`,
      );
    }
    const f = crop(sheet, x, y, cellW, cellH);
    if (!trimBox(f)) {
      throw new Error(`frame ${i} is completely transparent — wrong index, or wrong --grid?`);
    }
    return f;
  });

  // All source cells share one canvas size, so they are one registered group.
  const aligned = alignGroup(frames);
  const layout = buildAtlas(aligned);

  const animations: EmitAnimation[] = specs.map((s) => ({
    name: s.name,
    frames: s.indices.map((i) => order.indexOf(i)),
    fps: s.fps,
  }));

  const id = o.id ?? idFromOutDir(o.outDir);
  return emitPack({
    outDir: o.outDir,
    id,
    name: o.name ?? id,
    author: o.author ?? 'unknown',
    license: o.license ?? 'unknown',
    source: `from-sheet ${o.input.replace(/\\/g, '/').split('/').pop()}`,
    pixelArt: verdict.pixelArt,
    layout,
    animations,
  });
}
