/**
 * Parsers for the small command-line languages the import commands speak.
 * Pure string → data, so every corner is unit-tested.
 */

export interface AnimSpec {
  name: string;
  /** Source frame indices, in play order. May repeat. */
  indices: number[];
  fps: number;
}

const DEFAULT_FPS = 8;

/**
 * `walk=0-3@8` · `idle=0,1@2` · `sit=4` · ranges may descend (`3-0`).
 */
export function parseAnimSpec(spec: string): AnimSpec {
  const m = /^([a-zA-Z][\w-]*)=([\d,-]+)(?:@([\d.]+))?$/.exec(spec);
  if (!m) {
    throw new Error(
      `bad --anim "${spec}" — expected name=frames[@fps], e.g. walk=0-3@8 or idle=0,1@2`,
    );
  }
  const [, name, list, fpsStr] = m;
  const indices: number[] = [];
  for (const part of list!.split(',')) {
    if (part === '') throw new Error(`bad --anim "${spec}" — empty frame entry`);
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      // A typo like 0-999999999 would allocate the array long before any
      // bounds check against the actual sheet could reject it.
      if (Math.abs(b - a) >= 4096) {
        throw new Error(`bad --anim "${spec}" — range ${part} spans over 4096 frames`);
      }
      const step = a <= b ? 1 : -1;
      for (let i = a; i !== b + step; i += step) indices.push(i);
    } else if (/^\d+$/.test(part)) {
      indices.push(Number(part));
    } else {
      throw new Error(`bad --anim "${spec}" — "${part}" is not a frame index or range`);
    }
  }
  const fps = fpsStr === undefined ? DEFAULT_FPS : Number(fpsStr);
  if (!(fps > 0)) throw new Error(`bad --anim "${spec}" — fps must be positive`);
  return { name: name!, indices, fps };
}

/**
 * `--fps 8` (default for every animation) and `--fps walk=10` (one animation),
 * both repeatable. Later entries win.
 */
export function parseFpsFlags(flags: readonly string[]): {
  byAnim: Map<string, number>;
  fallback: number;
} {
  const byAnim = new Map<string, number>();
  let fallback = DEFAULT_FPS;
  for (const f of flags) {
    const named = /^([a-zA-Z][\w-]*)=([\d.]+)$/.exec(f);
    if (named) {
      const fps = Number(named[2]);
      if (!(fps > 0)) throw new Error(`bad --fps "${f}" — fps must be positive`);
      // Animation names parsed from filenames are lowercased; match them,
      // or `--fps Walk=10` silently applies to nothing.
      byAnim.set(named[1]!.toLowerCase(), fps);
    } else if (/^[\d.]+$/.test(f) && Number(f) > 0) {
      fallback = Number(f);
    } else {
      throw new Error(`bad --fps "${f}" — expected a number or name=number`);
    }
  }
  return { byAnim, fallback };
}

export interface FrameName {
  anim: string;
  index: number;
}

/**
 * Turn a `--pattern "{anim}_{i}.png"` into a matcher. Without a pattern, the
 * default accepts `walk_3.png`, `walk-3.png`, `walk3.png`, `walk 3.png`.
 */
export function makeNameParser(pattern?: string): (filename: string) => FrameName | null {
  if (pattern === undefined) {
    return (filename) => {
      const m = /^([a-zA-Z][\w-]*?)[-_ ]?(\d+)\.(png|webp)$/i.exec(filename);
      if (!m) return null;
      return { anim: m[1]!.toLowerCase(), index: Number(m[2]) };
    };
  }

  if (!pattern.includes('{anim}') || !pattern.includes('{i}')) {
    throw new Error(`--pattern must contain {anim} and {i}, got "${pattern}"`);
  }
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) =>
    c === '{' || c === '}' ? c : `\\${c}`,
  );
  const source = escaped.replace('{anim}', '([a-zA-Z][\\w-]*?)').replace('{i}', '(\\d+)');
  const animFirst = pattern.indexOf('{anim}') < pattern.indexOf('{i}');
  const re = new RegExp(`^${source}$`, 'i');
  return (filename) => {
    const m = re.exec(filename);
    if (!m) return null;
    const anim = (animFirst ? m[1] : m[2])!;
    const idx = (animFirst ? m[2] : m[1])!;
    return { anim: anim.toLowerCase(), index: Number(idx) };
  };
}

/** Numeric sort — walk_10 belongs after walk_9, which lexical sort gets wrong. */
export function byIndex(a: FrameName, b: FrameName): number {
  return a.index - b.index;
}

/** File basename → animation-name slug, for from-gif: `Walk Cycle.gif` → walk-cycle. */
export function slugFromFilename(file: string): string {
  const base = file.replace(/\\/g, '/').split('/').pop()!.replace(/\.[^.]+$/, '');
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return /^[a-zA-Z]/.test(slug) ? slug : `anim-${slug || 'a'}`;
}
