import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { KNOWN_ANIMATIONS } from '@blerb/pack';

/**
 * The GUI import path: a handful of files from a file picker become a pack in
 * the user-writable packs root, through exactly the same pipeline as the
 * petgen CLI. petgen is imported lazily so sharp — the one native module in
 * that pipeline — is loaded the first time someone actually imports, never at
 * app startup. A broken sharp install then costs an error message in the
 * settings window instead of the whole app.
 */

export interface ImportOutcome {
  ok: boolean;
  /** True when the user dismissed the file picker — not an error. */
  canceled?: boolean;
  id?: string;
  name?: string;
  error?: string;
}

const ANIMATED = /\.(gif|webp)$/i;
const STILL = /\.(png|jpe?g)$/i;

/** Filename noise that shouldn't end up in a pet's name. */
const NOISE = new Set(['default', 'shiny', 'sprite', 'anim', 'animation']);
const KNOWN = new Set<string>(KNOWN_ANIMATIONS);

/** "default_walk_8fps.gif" → "walk"; "quagsire-idle.gif" → "idle"; else null. */
function animFromFilename(slug: string): string | null {
  if (KNOWN.has(slug)) return slug;
  const words = slug.split('-');
  for (const w of words) if (KNOWN.has(w)) return w;
  return null;
}

/** The words of the first filename that are NOT animation names or noise. */
function petWordsFrom(slug: string): string[] {
  return slug.split('-').filter((w) => w && !KNOWN.has(w) && !NOISE.has(w) && !/^\d+fps$/.test(w));
}

const titleCase = (words: string[]): string =>
  words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');

/**
 * First free directory name: quagsire, quagsire-2, quagsire-3… `taken` is the
 * caller's view of ids that exist ANYWHERE — in the packaged app the roots are
 * user-writable AND bundled, searched user-first, so probing only the output
 * root would let an import named "blob" silently shadow the bundled default
 * (and poison the startup fallback that loads blob when a pack breaks).
 */
function freeId(root: string, base: string, taken: (id: string) => boolean): string {
  const free = (id: string) => !existsSync(join(root, id)) && !taken(id);
  if (free(base)) return base;
  for (let n = 2; ; n++) {
    if (free(`${base}-${n}`)) return `${base}-${n}`;
  }
}

export async function importPet(
  files: string[],
  outRoot: string,
  rawName?: string,
  idTaken: (id: string) => boolean = () => false,
): Promise<ImportOutcome> {
  try {
    const petgen = await import('@blerb/petgen');

    let animated = files.filter((f) => ANIMATED.test(f));
    let stills = files.filter((f) => STILL.test(f));
    const other = files.filter((f) => !ANIMATED.test(f) && !STILL.test(f));
    if (other.length > 0) {
      return fail(`can't import ${other.map(shortName).join(', ')} — GIF, WebP, PNG or JPG only.`);
    }
    if (animated.length > 0 && stills.length > 0) {
      return fail('pick either animated GIFs (one per animation) or ONE picture — not a mix.');
    }
    if (stills.length > 1) {
      return fail('one picture at a time — it becomes a walking pet on its own. (Folders of frames: petgen from-frames.)');
    }
    if (animated.length === 0 && stills.length === 0) return fail('nothing selected.');

    // A lone .gif/.webp holding ONE frame is a picture in an animation
    // container. Routed by extension it becomes a one-frame "walk" — an
    // import that reports success and produces a pet frozen mid-stride.
    // Routed by what the file actually contains, it gets the procedural rig.
    if (animated.length === 1 && stills.length === 0 && (await petgen.countFrames(animated[0]!)) < 2) {
      stills = animated;
      animated = [];
    }

    // Which animation is each animated file? From the filename when it says
    // (walk.gif, default_idle_8fps.gif); a single unnamed file is the walk.
    const slugs = animated.map((f) => petgen.slugFromFilename(f));
    const anims = slugs.map(animFromFilename);
    if (animated.length === 1 && anims[0] === null) anims[0] = 'walk';
    const unnamed = anims
      .map((a, i) => (a === null ? shortName(animated[i]!) : null))
      .filter((x): x is string => x !== null);
    if (unnamed.length > 0) {
      return fail(
        `can't tell which animation ${unnamed.join(' and ')} is — ` +
          `name the files after animations (walk.gif, idle.gif, climb.gif…).`,
      );
    }

    // Pet name: the text box wins verbatim; otherwise whatever the filenames
    // say the pet is called, falling back to a plain default.
    const typed = rawName ? slugify(rawName).split('-').filter(Boolean) : [];
    const derived = petWordsFrom(slugs[0] ?? petgen.slugFromFilename(stills[0]!));
    const words = typed.length > 0 ? typed : derived.length > 0 ? derived : ['my', 'pet'];
    const base = words.join('-');
    const id = freeId(outRoot, base, idTaken);
    const name = titleCase(words) + (id === base ? '' : ` (${id.slice(base.length + 1)})`);
    const outDir = join(outRoot, id);

    if (stills.length === 1) {
      await petgen.fromImage({ input: stills[0]!, outDir, id, name, author: 'imported', license: 'unknown' });
    } else {
      const provided = new Set(anims as string[]);
      // The same graceful default the batch importer uses: side-view walk
      // rotated by the renderer reads as climbing, so packs without climb art
      // still climb credibly. Only for animations the user didn't supply.
      const aliases: Record<string, string> = {};
      if (provided.has('walk')) {
        for (const target of ['climb', 'hang'] as const) {
          if (!provided.has(target)) aliases[target] = 'walk';
        }
      }
      await petgen.fromGif({
        inputs: animated,
        animNames: anims as string[],
        outDir,
        id,
        name,
        author: 'imported',
        license: 'unknown',
        aliases,
      });
    }
    return { ok: true, id, name };
  } catch (err) {
    return fail(err instanceof Error ? err.message.split('\n')[0]! : String(err));
  }
}

const fail = (error: string): ImportOutcome => ({ ok: false, error });
const shortName = (f: string): string => f.replace(/\\/g, '/').split('/').pop() ?? f;
const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
