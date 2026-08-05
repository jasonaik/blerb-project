#!/usr/bin/env node
import { preview } from './commands/preview.js';

const USAGE = `
petgen — pet pack tooling

  petgen preview <packDir>     open a live preview of a pack        (Phase 0)
  petgen doctor <packDir>      validate a pack                      (Phase 3)
  petgen from-sheet <png>      import a sprite sheet                (Phase 3)
  petgen from-frames <dir>     import a folder of frames            (Phase 3)
  petgen from-gif <gif>        import an animated GIF/WebP          (Phase 3)
  petgen from-image <png>      import one static image + a gait rig (Phase 4)

Options
  --port <n>    preview port (default 5273)
  --no-open     don't open a browser
`.trim();

/**
 * Flags that never take a value. Without this, `--no-open packs/blob` would
 * swallow the pack directory as the flag's argument.
 */
const BOOLEAN_FLAGS = new Set(['no-open', 'help', 'debug']);

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function main(): Promise<number> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;

  if (!command || command === 'help' || flags.has('help')) {
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
      const port = Number(flags.get('port') ?? 5273);
      await preview({ packDir, port, open: flags.get('no-open') !== true });
      return 0;
    }

    case 'doctor':
    case 'from-sheet':
    case 'from-frames':
    case 'from-gif':
    case 'from-image':
      console.error(`petgen ${command}: not built yet — see the plan, Phase 3/4.`);
      return 1;

    default:
      console.error(`petgen: unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
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
