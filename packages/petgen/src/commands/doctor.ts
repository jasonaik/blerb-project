/**
 * `petgen doctor <packDir>` — is this pack going to work?
 *
 * Three severities, honestly separated:
 *   error — the pack will crash or misrender. Exit code 1.
 *   warn  — something is probably not what the author meant.
 *   info  — worth knowing, requires nothing.
 *
 * The schema half is just `resolvePack` (single source of truth — see
 * packages/pack/src/schema.ts). What doctor ADDS is the decoded atlas: only
 * here do we know whether cell rects actually land inside the image, whether a
 * referenced frame is blank, and whether the art looks like undeclared or
 * upscaled pixel art.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KNOWN_ANIMATIONS, resolvePack, type ResolvedPack } from '@blerb/pack';
import { loadRaster } from '../import/io.js';
import { detectPixelArt } from '../import/pixelart.js';
import { trimBox, crop, type Raster } from '../import/raster.js';

export type Severity = 'error' | 'warn' | 'info';

export interface Finding {
  severity: Severity;
  message: string;
}

export interface Diagnosis {
  findings: Finding[];
  errors: number;
  warnings: number;
  /** Present when the manifest at least parsed. */
  pack?: ResolvedPack;
}

export async function diagnosePack(packDir: string): Promise<Diagnosis> {
  const findings: Finding[] = [];
  const err = (message: string) => findings.push({ severity: 'error', message });
  const warn = (message: string) => findings.push({ severity: 'warn', message });
  const info = (message: string) => findings.push({ severity: 'info', message });
  const done = (pack?: ResolvedPack): Diagnosis => ({
    findings,
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warn').length,
    ...(pack ? { pack } : {}),
  });

  // --- manifest ------------------------------------------------------------
  const manifestPath = join(packDir, 'pet.json');
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    err(`cannot read ${manifestPath}`);
    return done();
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    err(`pet.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    return done();
  }

  let pack: ResolvedPack;
  try {
    pack = resolvePack(json, manifestPath.replace(/\\/g, '/'));
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return done();
  }

  // --- atlas ---------------------------------------------------------------
  let atlas: Raster;
  try {
    atlas = await loadRaster(join(packDir, pack.manifest.atlas.src));
  } catch {
    err(`atlas "${pack.manifest.atlas.src}" is missing or not decodable`);
    return done(pack);
  }

  // Every cell any animation actually uses, deduplicated.
  const usedCells = new Set<string>();
  for (const anim of pack.animations.values()) {
    for (const f of anim.frames) usedCells.add(f);
  }

  // Gap between each cell's lowest content and its anchor row. One floating
  // frame is normal (a jump); EVERY frame floating means the whole pet hovers
  // above everything it stands on — a trim or registration mistake.
  let minFloat = Infinity;
  for (const id of usedCells) {
    const c = pack.cell(id);
    if (c.x < 0 || c.y < 0 || c.x + c.w > atlas.w || c.y + c.h > atlas.h) {
      err(
        `cell ${id} (${c.x},${c.y} ${c.w}x${c.h}) falls outside the ${atlas.w}x${atlas.h} atlas`,
      );
      continue;
    }
    const [ax, ay] = c.anchor;
    if (ax < 0 || ax > c.w || ay < 0 || ay > c.h) {
      err(`cell ${id} anchor [${ax}, ${ay}] is outside its own ${c.w}x${c.h} bounds`);
    }
    const content = trimBox(crop(atlas, c.x, c.y, c.w, c.h));
    if (!content) {
      warn(`cell ${id} is completely transparent — a frame of nothing`);
    } else {
      minFloat = Math.min(minFloat, Math.max(0, Math.round(ay) - content.y1));
    }
  }
  if (minFloat !== Infinity && minFloat > 1) {
    warn(
      `every frame's content stops ≥${minFloat}px above its anchor row — ` +
        `the pet will float that far above everything it stands on`,
    );
  }

  // --- animations ----------------------------------------------------------
  // "Missing" means neither provided nor deliberately aliased to something
  // that exists — those are the ones that silently land on the idle fallback.
  const reachable = (name: string): boolean => {
    let cursor = name;
    for (let hops = 0; hops < 8; hops++) {
      if (pack.animations.has(cursor)) return true;
      const next = pack.manifest.aliases[cursor];
      if (next === undefined) return false;
      cursor = next;
    }
    return false;
  };
  const missing = KNOWN_ANIMATIONS.filter((name) => !reachable(name));
  if (missing.length > 0) {
    info(
      `not provided (falls back gracefully): ${missing.join(', ')} — ` +
        `add art or an alias for any that matter`,
    );
  }

  for (const [from, to] of Object.entries(pack.manifest.aliases)) {
    // Walk the whole chain — a one-hop check let an alias CYCLE (a→b, b→a,
    // neither real) pass silently, which is deader than a plain dead alias.
    if (!reachable(to)) {
      warn(`alias "${from}" points at "${to}", which never reaches a real animation — it will use the fallback`);
    }
  }

  const walk = pack.animations.get('walk');
  if (walk && walk.designSpeed === undefined) {
    info(
      `walk has no designSpeed — the feet may skate. ` +
        `Set it to the px/s the walk cycle was drawn for.`,
    );
  }

  // --- pixel-art sanity ----------------------------------------------------
  const verdict = detectPixelArt(atlas);
  if (verdict.pixelArt && !pack.pixelArt) {
    warn(
      `the atlas looks like pixel art but "pixelArt" is false — ` +
        `it will render smoothed instead of crisp`,
    );
  }
  if (verdict.pixelArt && verdict.scale >= 2) {
    warn(
      `the atlas looks like pixel art upscaled ${verdict.scale}x — ` +
        `import at native resolution instead (docs/pet-art.md)`,
    );
  }

  return done(pack);
}

const MARKS: Record<Severity, string> = { error: 'x', warn: '!', info: 'i' };

export async function doctor(packDir: string): Promise<number> {
  const d = await diagnosePack(packDir);
  for (const f of d.findings) {
    console.log(` ${MARKS[f.severity]}  ${f.message}`);
  }
  if (d.pack) {
    const anims = [...d.pack.animations.keys()].join(', ');
    console.log(
      `\n${d.pack.id}: ${d.pack.cells.size} cells, animations: ${anims || '(none)'}`,
    );
  }
  console.log(
    d.errors > 0
      ? `${d.errors} error(s), ${d.warnings} warning(s) — this pack will not work correctly.`
      : d.warnings > 0
        ? `${d.warnings} warning(s), no errors — usable.`
        : 'clean.',
  );
  return d.errors > 0 ? 1 : 0;
}
