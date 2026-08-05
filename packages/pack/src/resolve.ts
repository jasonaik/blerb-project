import { PetManifest, type Animation, type Cell } from './schema.js';

/**
 * Turns a validated manifest into something a renderer can draw without making
 * any more decisions: every cell has explicit geometry and an anchor, every
 * animation frame is a concrete cell id, and every animation lookup resolves
 * to *something* so a sparse pack can't crash the sim mid-frame.
 *
 * Deliberately does no IO and decodes no images. The atlas bitmap is the host's
 * problem — Electron and the preview page load it differently, and this package
 * stays usable from a plain unit test because of that.
 */

export class PackError extends Error {
  override name = 'PackError';
  constructor(
    message: string,
    readonly packId?: string,
  ) {
    super(packId ? `[${packId}] ${message}` : message);
  }
}

export interface ResolvedCell {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Cell-local px. The pet's feet — every transform in the renderer is about this point. */
  anchor: readonly [number, number];
}

export interface ResolvedAnimation {
  name: string;
  /** Concrete cell ids, in play order. Never empty. */
  frames: string[];
  fps: number;
  loop: boolean;
  next: string | undefined;
  designSpeed: number | undefined;
  /** Total run length in ms. Precomputed because the sim asks every tick. */
  durationMs: number;
}

export interface ResolvedPack {
  manifest: PetManifest;
  id: string;
  name: string;
  pixelArt: boolean;
  /** Resolved against the manifest's own location. */
  atlasUrl: string;
  atlasScale: number;
  facing: 'mirror' | 'none';
  cells: ReadonlyMap<string, ResolvedCell>;
  animations: ReadonlyMap<string, ResolvedAnimation>;
  behavior: PetManifest['behavior'];
  rig: PetManifest['rig'];
  /**
   * Never throws and never returns undefined. Follows `aliases`, then falls
   * back to whatever the pack does have. A missing animation should look
   * slightly wrong, not take the app down.
   */
  animation(name: string): ResolvedAnimation;
  cell(id: string): ResolvedCell;
}

const GRID_PREFIX = 'grid:';

/** Default anchor: bottom-centre. Feet on the ground, horizontally centred. */
function defaultAnchor(w: number, h: number): [number, number] {
  return [w / 2, h - 1];
}

function toResolvedCell(id: string, c: Cell): ResolvedCell {
  return {
    id,
    x: c.x,
    y: c.y,
    w: c.w,
    h: c.h,
    anchor: c.anchor ?? defaultAnchor(c.w, c.h),
  };
}

/**
 * Grid cells are generated on demand for exactly the indices the animations
 * reference, which means we never need to know the atlas dimensions here.
 * Whether an index actually falls inside the image is a `petgen doctor` check —
 * that tool has the decoded atlas and can say so precisely.
 */
function gridCell(manifest: PetManifest, index: number): ResolvedCell {
  const g = manifest.grid;
  if (!g) {
    throw new PackError(
      `animation frame ${index} is a grid index, but this pack has no "grid" block. ` +
        `Either add one, or refer to cells by name.`,
      manifest.id,
    );
  }
  if (g.count !== undefined && index >= g.count) {
    throw new PackError(`grid index ${index} is past the declared count of ${g.count}.`, manifest.id);
  }
  const col = index % g.cols;
  const row = Math.floor(index / g.cols);
  return {
    id: `${GRID_PREFIX}${index}`,
    x: g.margin + col * (g.w + g.spacing),
    y: g.margin + row * (g.h + g.spacing),
    w: g.w,
    h: g.h,
    anchor: defaultAnchor(g.w, g.h),
  };
}

function resolveBaseUrl(src: string, manifestUrl: string): string {
  // Absolute URL or data URI — take it as-is.
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return src;
  const slash = manifestUrl.lastIndexOf('/');
  return slash === -1 ? src : manifestUrl.slice(0, slash + 1) + src;
}

/**
 * @param manifestUrl Location the manifest came from, used to resolve `atlas.src`.
 *   A bare directory-less string is fine for tests.
 */
export function resolvePack(input: unknown, manifestUrl = './pet.json'): ResolvedPack {
  const parsed = PetManifest.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new PackError(`invalid pet.json:\n${issues}`);
  }
  const m = parsed.data;

  const cells = new Map<string, ResolvedCell>();
  for (const [id, c] of Object.entries(m.cells)) {
    cells.set(id, toResolvedCell(id, c));
  }

  // Walk the animations and materialise whatever cells they reference.
  // Explicit named cells always win over grid indices, so an author can
  // override a single frame's anchor without abandoning the grid shorthand.
  const animations = new Map<string, ResolvedAnimation>();
  for (const [name, a] of Object.entries(m.animations)) {
    animations.set(name, resolveAnimation(m, name, a, cells));
  }

  if (animations.size === 0) {
    throw new PackError('pack defines no animations.', m.id);
  }

  // Fallback target for anything missing: prefer idle, else whatever is first.
  const fallbackName = animations.has('idle')
    ? 'idle'
    : (animations.keys().next().value as string);
  const fallback = animations.get(fallbackName)!;

  const resolved: ResolvedPack = {
    manifest: m,
    id: m.id,
    name: m.name,
    pixelArt: m.pixelArt,
    atlasUrl: resolveBaseUrl(m.atlas.src, manifestUrl),
    atlasScale: m.atlas.scale,
    facing: m.facing,
    cells,
    animations,
    behavior: m.behavior,
    rig: m.rig,

    animation(name: string): ResolvedAnimation {
      const direct = animations.get(name);
      if (direct) return direct;

      // Follow the alias chain, with a hop limit so a cycle in a hand-written
      // pet.json degrades to the fallback instead of hanging the render loop.
      let cursor = name;
      for (let hops = 0; hops < 8; hops++) {
        const next = m.aliases[cursor];
        if (next === undefined) break;
        const hit = animations.get(next);
        if (hit) return hit;
        cursor = next;
      }
      return fallback;
    },

    cell(id: string): ResolvedCell {
      const hit = cells.get(id);
      if (hit) return hit;
      // Only reachable if a caller invents an id; animations are pre-resolved.
      throw new PackError(`no such cell: ${id}`, m.id);
    },
  };

  return resolved;
}

function resolveAnimation(
  m: PetManifest,
  name: string,
  a: Animation,
  cells: Map<string, ResolvedCell>,
): ResolvedAnimation {
  const frames = a.frames.map((f) => {
    if (typeof f === 'number') {
      const id = `${GRID_PREFIX}${f}`;
      if (!cells.has(id)) cells.set(id, gridCell(m, f));
      return id;
    }
    if (!cells.has(f)) {
      throw new PackError(
        `animation "${name}" refers to cell "${f}", which is not defined in "cells".`,
        m.id,
      );
    }
    return f;
  });

  return {
    name,
    frames,
    fps: a.fps,
    loop: a.loop,
    next: a.next,
    designSpeed: a.designSpeed,
    durationMs: (frames.length / a.fps) * 1000,
  };
}

/**
 * Which cell of `anim` is showing after `tMs` of play.
 * Non-looping animations hold on their last frame; the sim decides when to
 * move on via `anim.next`.
 */
export function frameAt(anim: ResolvedAnimation, tMs: number): string {
  const i = Math.floor((tMs / 1000) * anim.fps);
  const last = anim.frames.length - 1;
  const idx = anim.loop ? ((i % anim.frames.length) + anim.frames.length) % anim.frames.length : Math.min(i, last);
  return anim.frames[idx]!;
}
