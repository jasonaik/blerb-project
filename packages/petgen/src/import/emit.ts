/**
 * Assemble and write a pack directory: atlas.png + pet.json.
 *
 * The generated pet.json leans on every default the schema has — grid layout,
 * derived anchors, alias fallbacks — because the format's health metric is that
 * a complete pet stays hand-writably small (see CLAUDE.md §6). The generator
 * emitting sprawl would hide schema regressions behind tooling.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePack, type PetManifestInput } from '@blerb/pack';
import type { AtlasLayout } from './layout.js';
import { savePng } from './io.js';

export interface EmitAnimation {
  name: string;
  /** Indices into the emitted atlas grid. */
  frames: number[];
  fps: number;
}

export interface EmitOptions {
  outDir: string;
  id: string;
  name: string;
  author: string;
  license: string;
  /** Provenance note, e.g. the input filename. */
  source: string;
  pixelArt: boolean;
  layout: AtlasLayout;
  animations: EmitAnimation[];
  /** Procedural gait rig, for single-image packs. */
  rig?: NonNullable<PetManifestInput['rig']> | undefined;
  /**
   * The art's resolution relative to its display size — a 4 here renders the
   * cell at quarter size. How hi-res smooth art becomes a pet-sized pet
   * without downsampling away detail the user might want at bigger scales.
   */
  atlasScale?: number | undefined;
}

export async function emitPack(o: EmitOptions): Promise<string> {
  const animations: Record<string, { frames: number[]; fps: number }> = {};
  for (const a of o.animations) {
    animations[a.name] = { frames: a.frames, fps: a.fps };
  }

  const manifest: PetManifestInput = {
    format: 'blerb-pet/1',
    id: o.id,
    name: o.name,
    author: o.author,
    license: o.license,
    source: o.source,
    pixelArt: o.pixelArt,
    atlas: { src: 'atlas.png', ...(o.atlasScale && o.atlasScale !== 1 ? { scale: o.atlasScale } : {}) },
    grid: {
      w: o.layout.cellW,
      h: o.layout.cellH,
      cols: o.layout.cols,
      spacing: o.layout.spacing,
      margin: o.layout.margin,
      count: o.layout.count,
    },
    animations,
    ...(o.rig ? { rig: o.rig } : {}),
  };

  // Through the real resolver BEFORE anything touches the disk — a bad --id
  // or a broken animation should fail the import, not write a broken pack
  // that only doctor notices later.
  resolvePack(manifest);

  await mkdir(o.outDir, { recursive: true });
  await savePng(o.layout.atlas, join(o.outDir, 'atlas.png'));
  const manifestPath = join(o.outDir, 'pet.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return manifestPath;
}

/** `packs/my-pet` → `my-pet`; also the fallback display name. */
export function idFromOutDir(outDir: string): string {
  const base = outDir.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? 'pet';
  const slug = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return /^[a-z0-9]/.test(slug) ? slug : `pet-${slug || 'x'}`;
}
