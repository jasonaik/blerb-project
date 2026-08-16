#!/usr/bin/env node
import { resolve } from 'node:path';
import { preview } from './commands/preview.js';
import { doctor } from './commands/doctor.js';
import { fromSheet } from './commands/fromSheet.js';
import { fromFrames } from './commands/fromFrames.js';
import { fromGif } from './commands/fromGif.js';
import { fromImage } from './commands/fromImage.js';

const USAGE = `
petgen — pet pack tooling

  petgen preview <packDir>     open a live preview of a pack
  petgen doctor <packDir>      validate a pack against the schema and its atlas
  petgen from-sheet <png>      import a sprite sheet
  petgen from-frames <dir>     import a folder of frames
  petgen from-gif <gif>...     import animated GIF/WebP (one animation per file)
  petgen from-image <png|jpg>  import ONE picture; a procedural rig makes it walk

Import options
  -o, --out <dir>       output pack directory (required; its name becomes the id)
  --anim <spec>         from-sheet: name=frames[@fps], e.g. walk=0-3@8 (repeatable)
                        from-gif: animation name for a single input
  --grid <WxH>          from-sheet: source cell size, e.g. 32x32 (required)
  --cols/--margin/--spacing <n>   from-sheet: source layout, if not tight
  --pattern <p>         from-frames: filename shape, default {anim}_{i}.png
  --fps <n|anim=n>      from-frames: playback rate(s), default 8 (repeatable)
  --tolerance <t>       from-image: backdrop match strictness 0..1, default 0.1
  --keep-bg             from-image: skip background removal
  --id/--name/--author/--license  pack metadata

Preview options
  --port <n>    preview port (default 5273)
  --no-open     don't open a browser

After an import, doctor runs automatically and \`petgen preview <dir>\` shows the
result. Input requirements for art are documented in docs/pet-art.md.
`.trim();

/**
 * Flags that never take a value. Without this, `--no-open packs/blob` would
 * swallow the pack directory as the flag's argument.
 */
const BOOLEAN_FLAGS = new Set(['no-open', 'help', 'debug', 'keep-bg']);

/** Short aliases, expanded before parsing. */
const SHORT: Record<string, string> = { '-o': '--out' };

interface Args {
  positional: string[];
  /** Every occurrence, in order — --anim and --fps repeat meaningfully. */
  all(key: string): string[];
  /** Last occurrence, or undefined. */
  get(key: string): string | undefined;
  has(key: string): boolean;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, (string | true)[]>();
  const push = (key: string, value: string | true) => {
    const list = flags.get(key) ?? [];
    list.push(value);
    flags.set(key, list);
  };

  for (let i = 0; i < argv.length; i++) {
    const a = SHORT[argv[i]!] ?? argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) {
        push(key, next);
        i++;
      } else {
        push(key, true);
      }
    } else {
      positional.push(a);
    }
  }

  return {
    positional,
    all: (key) => (flags.get(key) ?? []).filter((v): v is string => v !== true),
    get: (key) => {
      const list = flags.get(key);
      const last = list?.[list.length - 1];
      return typeof last === 'string' ? last : undefined;
    },
    has: (key) => flags.has(key),
  };
}

/** Shared metadata flags for every import command. */
function meta(args: Args) {
  return {
    id: args.get('id'),
    name: args.get('name'),
    author: args.get('author'),
    license: args.get('license'),
  };
}

/**
 * User-supplied paths resolve against where the user actually typed the
 * command. `pnpm petgen …` runs with cwd inside packages/petgen, but pnpm
 * records the invocation directory in INIT_CWD — without this, `-o packs/x`
 * lands in packages/petgen/packs/x.
 */
const userPath = (p: string): string => resolve(process.env.INIT_CWD ?? process.cwd(), p);

function requireOut(args: Args, command: string): string {
  const out = args.get('out');
  if (!out) throw new Error(`petgen ${command}: needs -o <packDir>, e.g. -o packs/my-pet`);
  return userPath(out);
}

const intFlag = (args: Args, key: string): number | undefined => {
  const v = args.get(key);
  return v === undefined ? undefined : Number(v);
};

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const [command, ...rest] = args.positional;

  if (!command || command === 'help' || args.has('help')) {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  switch (command) {
    case 'preview': {
      const packDir = rest[0];
      if (!packDir) {
        console.error('petgen preview: needs a pack directory, e.g. packs/blob');
        return 1;
      }
      const port = Number(args.get('port') ?? 5273);
      await preview({ packDir, port, open: !args.has('no-open') });
      return 0;
    }

    case 'doctor': {
      const packDir = rest[0];
      if (!packDir) {
        console.error('petgen doctor: needs a pack directory, e.g. packs/blob');
        return 1;
      }
      return doctor(userPath(packDir));
    }

    case 'from-sheet': {
      const input = rest[0];
      if (!input) {
        console.error('petgen from-sheet: needs a sheet image, e.g. petgen from-sheet sheet.png --grid 32x32 --anim walk=0-3@8 -o packs/x');
        return 1;
      }
      const grid = args.get('grid');
      if (!grid) {
        console.error('petgen from-sheet: needs --grid <WxH> — the source sheet cell size, e.g. --grid 32x32');
        return 1;
      }
      const manifest = await fromSheet({
        input: userPath(input),
        outDir: requireOut(args, command),
        grid,
        anims: args.all('anim'),
        spacing: intFlag(args, 'spacing'),
        margin: intFlag(args, 'margin'),
        cols: intFlag(args, 'cols'),
        ...meta(args),
      });
      return finishImport(manifest);
    }

    case 'from-frames': {
      const dir = rest[0];
      if (!dir) {
        console.error('petgen from-frames: needs a directory of frames, e.g. petgen from-frames ./frames -o packs/x');
        return 1;
      }
      const manifest = await fromFrames({
        dir: userPath(dir),
        outDir: requireOut(args, command),
        pattern: args.get('pattern'),
        fps: args.all('fps'),
        ...meta(args),
      });
      return finishImport(manifest);
    }

    case 'from-gif': {
      if (rest.length === 0) {
        console.error('petgen from-gif: needs animated image(s), e.g. petgen from-gif walk.gif idle.gif -o packs/x');
        return 1;
      }
      const manifest = await fromGif({
        inputs: rest.map(userPath),
        outDir: requireOut(args, command),
        anim: args.get('anim'),
        ...meta(args),
      });
      return finishImport(manifest);
    }

    case 'from-image': {
      const input = rest[0];
      if (!input) {
        console.error('petgen from-image: needs a picture, e.g. petgen from-image pet.png -o packs/x');
        return 1;
      }
      const manifest = await fromImage({
        input: userPath(input),
        outDir: requireOut(args, command),
        tolerance: args.get('tolerance') !== undefined ? Number(args.get('tolerance')) : undefined,
        keepBg: args.has('keep-bg'),
        ...meta(args),
      });
      return finishImport(manifest);
    }

    default:
      console.error(`petgen: unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
}

/** Every import ends the same way: say where it went, then doctor it. */
async function finishImport(manifestPath: string): Promise<number> {
  const dir = manifestPath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  console.log(`\nwrote ${manifestPath}`);
  const code = await doctor(dir);
  console.log(`\npreview it:  petgen preview ${dir}`);
  return code;
}

main().then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
