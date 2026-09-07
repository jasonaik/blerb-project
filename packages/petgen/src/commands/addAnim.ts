/**
 * `petgen add-anim <packDir> <gif> [--anim surprise]`
 *
 * Append an animation to a pack that already exists — the way a `surprise`
 * or an `interact` gets onto the pet you are already using, without starting
 * the import over from GIFs you may no longer have.
 *
 * The existing cells are lifted out of the atlas as aligned frames — the
 * union of their content boxes, and the grid's default anchor, which every
 * cell of an imported pack shares — and laid out again around that anchor
 * ahead of the new frames. Their indices don't move, so the existing
 * animations' frame lists are carried through untouched, and because the
 * box is the content's own, a second add-anim leaves the cell size alone.
 * The new file goes through the same per-file pipeline as from-gif and is
 * brought to the pack's own scale.
 *
 * Only grid packs without hand-authored `cells`, and only even grid widths:
 * that is every pack the importers write, and the format's canary. An odd
 * width puts the default anchor [w/2, h-1] on a half pixel that the rebuilt
 * (always even) cell cannot reproduce, so it is refused, not re-quantised.
 *
 * THE WRITE IS ATOMIC BY VERSIONING THE ATLAS. The new atlas lands under a
 * new name, then pet.json is replaced by rename, then the old atlas goes.
 * Every intermediate state is a consistent pair. Two overwrites in a row —
 * the obvious implementation — leave "new atlas, old manifest" between them,
 * and the new atlas has a different grid.
 */

import { copyFile, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePack, type PetManifestInput } from '@blerb/pack';
import type { AlignedFrame } from '../import/layout.js';
import { buildAtlas, alignGroup } from '../import/layout.js';
import { loadRaster } from '../import/io.js';
import { crop, trimBox, unionBox, type Box, type Raster } from '../import/raster.js';
import { emitPack, type EmitAnimation } from '../import/emit.js';
import { slugFromFilename } from '../import/spec.js';
import {
  assembleAnimations,
  contentHeight,
  fitSmoothGroups,
  importGifGroups,
  undoSharedUpscale,
  type GifImportOptions,
} from './fromGif.js';

export interface AddAnimOptions extends GifImportOptions {
  packDir: string;
  inputs: string[];
  /** Per-input animation names, parallel to `inputs`; default: the filename slug. */
  animNames?: (string | undefined)[] | undefined;
  /** Where advisory messages go. Default console.warn; the GUI collects them for its status line. */
  warn?: ((message: string) => void) | undefined;
}

interface RawManifest {
  format: string;
  id: string;
  name: string;
  author?: string;
  license?: string;
  source?: string;
  pixelArt?: boolean;
  facing?: PetManifestInput['facing'];
  atlas: { src: string; scale?: number };
  grid?: { w: number; h: number; cols: number; spacing?: number; margin?: number; count?: number };
  cells?: Record<string, unknown>;
  animations: Record<string, { frames: (number | string)[]; fps?: number; loop?: boolean; next?: string; designSpeed?: number }>;
  aliases?: Record<string, string>;
  behavior?: PetManifestInput['behavior'];
  rig?: PetManifestInput['rig'];
}

/** atlas.png → atlas-1.png → atlas-2.png … */
function nextAtlasName(current: string): string {
  const m = /^(.*?)(?:-(\d+))?\.png$/i.exec(current);
  if (!m) return 'atlas-1.png';
  return `${m[1]}-${(m[2] ? Number(m[2]) : 0) + 1}.png`;
}

export async function addAnimations(o: AddAnimOptions): Promise<string> {
  const warn = o.warn ?? ((m: string) => console.warn(m));
  if (o.inputs.length === 0) throw new Error('add-anim needs at least one animated image');
  if (o.animNames && o.animNames.length !== o.inputs.length) {
    throw new Error(`animNames must parallel inputs (${o.animNames.length} names for ${o.inputs.length} files)`);
  }

  const manifestPath = join(o.packDir, 'pet.json');
  const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as RawManifest;
  // Through the real resolver first: a broken pack should fail here, not
  // after we have rewritten it.
  const pack = resolvePack(raw, manifestPath.replace(/\\/g, '/'));
  if (!raw.grid || (raw.cells && Object.keys(raw.cells).length > 0)) {
    throw new Error(`${raw.id}: add-anim only works on grid packs without hand-authored cells`);
  }
  if (raw.grid.w % 2 !== 0) {
    throw new Error(
      `${raw.id}: add-anim needs an even grid width (got ${raw.grid.w}) — an odd width puts the default ` +
        `anchor [w/2, h-1] on a half pixel, which the rebuilt even-width atlas cannot reproduce`,
    );
  }
  for (const [name, a] of Object.entries(raw.animations)) {
    if (a.frames.some((f) => typeof f !== 'number')) {
      throw new Error(`${raw.id}: animation "${name}" refers to named cells — add-anim needs grid indices`);
    }
  }

  const names = o.inputs.map((input, i) => o.animNames?.[i] ?? slugFromFilename(input));
  for (const n of names) {
    if (raw.animations[n]) throw new Error(`${raw.id} already has an animation called "${n}"`);
  }
  const dup = names.filter((n, i, a) => a.indexOf(n) !== i);
  if (dup.length > 0) throw new Error(`two inputs produce the same animation name: ${dup.join(', ')}`);
  if (names.includes('walk') && raw.rig) {
    warn(`${raw.id} has a procedural rig; the drawn walk now replaces the procedural one`);
  }

  // --- the existing cells, lifted out of the atlas -------------------------
  const atlas = await loadRaster(join(o.packDir, raw.atlas.src));
  const g = raw.grid;
  const spacing = g.spacing ?? 0;
  const margin = g.margin ?? 0;
  const maxIndex = Math.max(...Object.values(raw.animations).flatMap((a) => a.frames as number[]));
  const count = g.count ?? maxIndex + 1;
  if (maxIndex >= count) throw new Error(`${raw.id}: an animation refers to grid index ${maxIndex}, past count ${count}`);

  const cells: Raster[] = [];
  let union: Box | null = null;
  // The pet's height is the tallest single FRAME, not the union — a walk's
  // bob makes the union taller than any pose, and new art matched to that
  // would come out visibly bigger than the pet.
  let existingH = 0;
  for (let i = 0; i < count; i++) {
    const col = i % g.cols;
    const row = Math.floor(i / g.cols);
    const cell = crop(atlas, margin + col * (g.w + spacing), margin + row * (g.h + spacing), g.w, g.h);
    cells.push(cell);
    const box = trimBox(cell);
    if (box) {
      union = union ? unionBox(union, box) : box;
      existingH = Math.max(existingH, box.y1 - box.y0 + 1);
    }
  }
  if (!union) throw new Error(`${raw.id}: every existing cell is transparent`);
  // Content box, default anchor: placement is anchor-relative, so this is
  // exactly where buildAtlas put each cell — and idempotent.
  const existing: AlignedFrame[] = cells.map((raster) => ({ raster, box: union!, ax: g.w / 2, ay: g.h - 1 }));

  // --- the new frames, through the from-gif pipeline -----------------------
  const groups = await importGifGroups(o.inputs, names, o);
  const packPixelArt = pack.pixelArt;
  const pixelGroups = groups.filter((gr) => gr.pixelArt);
  const smoothGroups = groups.filter((gr) => !gr.pixelArt);
  undoSharedUpscale(pixelGroups);

  // Bring the new art to the pack's scale — its content height in atlas px.
  // A pixel pack keeps from-gif's rules (shrink only, never a near-size
  // sibling). A smooth pack's scale is FIXED by its cells and atlas.scale,
  // so smooth art is matched in both directions: a smaller file left alone
  // would render at h / atlas.scale — a speck beside the pet.
  if (smoothGroups.length > 0 && (o.height ?? existingH) > 0) {
    await fitSmoothGroups(smoothGroups, o.height ?? existingH, {
      pixelArt: packPixelArt,
      explicit: o.height !== undefined || !packPixelArt,
    });
    if (packPixelArt && o.height === undefined) {
      for (const gr of smoothGroups) {
        const h = contentHeight(gr.frames);
        if (h < existingH) warn(`${gr.anim}: ${h}px tall beside the pet's ${existingH}px — pass --height ${existingH} to enlarge it`);
      }
    }
  }
  if (pixelGroups.length > 0 && !packPixelArt) {
    warn(
      `${raw.id} is smooth art; the new pixel art keeps its native size (${pixelGroups
        .map((gr) => `${gr.anim} ${contentHeight(gr.frames)}px`)
        .join(', ')}) — pass --height to scale it`,
    );
  }

  const layout = buildAtlas([...existing, ...groups.flatMap((gr) => alignGroup(gr.frames))]);

  // Existing animations, indices untouched; new ones appended after `count`.
  const animations: EmitAnimation[] = Object.entries(raw.animations).map(([name, a]) => ({
    name,
    frames: a.frames as number[],
    fps: a.fps ?? 8,
    designSpeed: a.designSpeed,
    loop: a.loop,
    next: a.next,
  }));
  animations.push(
    ...assembleAnimations(
      groups.map((gr) => ({ anim: gr.anim, play: gr.play, uniqueCount: gr.frames.length, fps: gr.fps })),
      count,
    ),
  );

  const atlasFile = nextAtlasName(raw.atlas.src);
  const scratch = await mkdtemp(join(tmpdir(), 'petgen-add-'));
  try {
    await emitPack({
      outDir: scratch,
      id: raw.id,
      name: raw.name,
      author: raw.author ?? 'unknown',
      license: raw.license ?? 'unknown',
      source: `${raw.source ?? 'unknown'} + add-anim ${o.inputs.map((p) => p.replace(/\\/g, '/').split('/').pop()).join(', ')}`,
      pixelArt: packPixelArt,
      facing: raw.facing,
      layout,
      atlasScale: raw.atlas.scale,
      atlasFile,
      animations,
      aliases: raw.aliases,
      behavior: raw.behavior,
      rig: raw.rig ?? undefined,
    });
    // 1. The new atlas, under its new name: the old pair is still intact.
    await copyFile(join(scratch, atlasFile), join(o.packDir, atlasFile));
    // 2. The manifest, by rename: the one atomic step. Before it, old+old;
    //    after it, new+new.
    const tmpManifest = manifestPath + '.tmp';
    await writeFile(tmpManifest, await readFile(join(scratch, 'pet.json')));
    await rename(tmpManifest, manifestPath);
    // 3. The old atlas is garbage now. Best effort — a leftover is harmless.
    if (raw.atlas.src !== atlasFile) await rm(join(o.packDir, raw.atlas.src), { force: true }).catch(() => {});
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
  return manifestPath;
}
