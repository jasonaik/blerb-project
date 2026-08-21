/**
 * Batch-import HeartGold/SoulSilver overworld follower sprites from a LOCAL
 * clone of https://github.com/jakobhoeg/vscode-pokemon into blerb packs.
 *
 *   git clone --depth 1 https://github.com/jakobhoeg/vscode-pokemon
 *   pnpm pokemon ./vscode-pokemon                # gens 1-4, normal colours
 *   pnpm pokemon ./vscode-pokemon --shiny        # also import shiny variants
 *   pnpm pokemon ./vscode-pokemon --gens 1,2 --only pikachu,gyarados --force
 *
 * This script does NO network I/O — you clone, it reads. That keeps the
 * "there is no network code in this project" claim in the README literally
 * true, and keeps the choice to fetch third-party art a human action.
 *
 * IP note (CLAUDE.md §13): the sprites are © Nintendo / Creatures / GAME
 * FREAK — official art from the HGSS follower feature, ripped by fans. The
 * packs this writes live in your gitignored packs/ folder, on your machine,
 * and MUST never be committed or redistributed. blerb ships only blob.
 */

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromGif } from '../src/commands/fromGif.js';

// The walk gifs face right and cycle two steps per ~0.6s at their encoded
// 300ms frame delay; 27px/s puts a footfall every ~8px, which reads as feet
// gripping the taskbar instead of skating. Same value the hand-tuned quagsire
// pack used.
const WALK_SPEED = 27;

// No climb/cling art exists in HGSS rips. Aliasing climb and hang to walk
// lets the renderer's ±90° rotation do the work: a side-view walk with its
// feet against the wall reads as scaling it, Shimeji-style. cling is left to
// the resolver's idle fallback — a walk loop playing while the pet is
// STATIONARY on a wall would treadmill.
const ALIASES = { climb: 'walk', hang: 'walk' };

const AUTHOR = 'Game Freak (HGSS overworld); rip via jakobhoeg/vscode-pokemon';
const LICENSE = '© Nintendo/Creatures/GAME FREAK — personal use only, never redistribute';

/**
 * Repo dir names are mostly lowercase but not uniformly: `mimeJr`,
 * `nidoran_female`, `unown_a`. The pack id must be a clean slug — camelCase
 * gets a hyphen at each case boundary, underscores become hyphens.
 */
function slugify(dir: string): string {
  return dir
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Slugs that don't title-case cleanly. */
const NAME_OVERRIDES: Record<string, string> = {
  mrmime: 'Mr. Mime',
  'mime-jr': 'Mime Jr.',
  'ho-oh': 'Ho-Oh',
  farfetchd: "Farfetch'd",
  'porygon-z': 'Porygon-Z',
};

/** Form suffixes that read better as symbols. */
const WORD_OVERRIDES: Record<string, string> = { female: '♀', male: '♂' };

function displayName(slug: string): string {
  const hit = NAME_OVERRIDES[slug];
  if (hit) return hit;
  return slug
    .split('-')
    .map((w) => WORD_OVERRIDES[w] ?? (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

interface Args {
  clone: string;
  gens: number[];
  shiny: boolean;
  only: Set<string> | null;
  force: boolean;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const initCwd = process.env.INIT_CWD ?? process.cwd();
  let clone: string | null = null;
  let gens = [1, 2, 3, 4];
  let shiny = false;
  let only: Set<string> | null = null;
  let force = false;
  // Default output is the REPO's packs/ — the one directory the .gitignore
  // whitelist protects — regardless of where the command was typed. An
  // INIT_CWD-relative default invoked outside the repo would drop
  // never-redistribute art somewhere no ignore rule covers. --out (resolved
  // against where you typed, like every other petgen path) overrides, e.g.
  // for the installed app's packs root.
  let out = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packs');

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    // A value-taking flag must never swallow the NEXT flag as its value:
    // `--out --force` writing 565 never-redistribute packs into a directory
    // named "--force" — outside the gitignored packs/ — is the failure mode.
    const val = (flag: string): string => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`);
      i++;
      return next;
    };
    if (a === '--shiny') shiny = true;
    else if (a === '--force') force = true;
    else if (a === '--gens') gens = parseGens(val(a));
    else if (a === '--only') only = new Set(val(a).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    else if (a === '--out') out = resolve(initCwd, val(a));
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else if (clone === null) clone = resolve(initCwd, a);
    else throw new Error(`unexpected argument ${a}`);
  }

  if (!clone) {
    throw new Error(
      'usage: pnpm pokemon <path-to-vscode-pokemon-clone> [--gens 1,2,3,4] [--shiny] [--only a,b] [--out packs] [--force]\n' +
        '  Get the clone first (this script never touches the network):\n' +
        '    git clone --depth 1 https://github.com/jakobhoeg/vscode-pokemon',
    );
  }
  return { clone, gens, shiny, only, force, out };
}

function parseGens(spec: string): number[] {
  // "1,2" or "1-4" or "2"
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const range = part.match(/^(\d)\s*-\s*(\d)$/);
    if (range) for (let g = Number(range[1]); g <= Number(range[2]); g++) out.add(g);
    else if (/^\d$/.test(part.trim())) out.add(Number(part.trim()));
    else throw new Error(`--gens: can't read "${part}" (try "1-4" or "1,2,3")`);
  }
  if (out.size === 0) throw new Error('--gens named no generations');
  return [...out].sort();
}

interface Job {
  packId: string;
  packName: string;
  walk: string;
  idle: string;
}

function jobsFor(args: Args): { jobs: Job[]; missing: string[] } {
  const media = join(args.clone, 'media');
  if (!existsSync(media)) {
    throw new Error(`${args.clone} has no media/ directory — is it really a vscode-pokemon clone?`);
  }

  const jobs: Job[] = [];
  const missing: string[] = [];
  // Two source dirs can slug to one id (mimeJr and mime_jr both → mime-jr).
  // Without this the second one is counted as "skipped, already present" —
  // blaming a previous run — or silently overwrites the first under --force.
  const byId = new Map<string, string>();
  for (const gen of args.gens) {
    const genDir = join(media, `gen${gen}`);
    if (!existsSync(genDir)) {
      missing.push(`gen${gen} (no such directory)`);
      continue;
    }
    for (const entry of readdirSync(genDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const mon = entry.name;
      if (args.only && !args.only.has(mon.toLowerCase()) && !args.only.has(slugify(mon))) continue;

      for (const variant of args.shiny ? (['default', 'shiny'] as const) : (['default'] as const)) {
        const walk = join(genDir, mon, `${variant}_walk_8fps.gif`);
        const idle = join(genDir, mon, `${variant}_idle_8fps.gif`);
        if (!existsSync(walk) || !existsSync(idle)) {
          missing.push(`${mon} (${variant}: missing walk or idle gif)`);
          continue;
        }
        const slug = slugify(mon);
        const shinySuffix = variant === 'shiny';
        const packId = shinySuffix ? `${slug}-shiny` : slug;
        const clash = byId.get(packId);
        if (clash !== undefined) {
          missing.push(`${gen}/${mon} (${variant}: pack id "${packId}" already claimed by ${clash})`);
          continue;
        }
        byId.set(packId, `gen${gen}/${mon}`);
        jobs.push({
          packId,
          packName: shinySuffix ? `${displayName(slug)} (shiny)` : displayName(slug),
          walk,
          idle,
        });
      }
    }
  }
  return { jobs, missing };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const { jobs, missing } = jobsFor(args);
  console.log(`found ${jobs.length} pets to import (gens ${args.gens.join(',')}${args.shiny ? ' + shiny' : ''}) → ${args.out}`);

  let imported = 0;
  let skipped = 0;
  const failed: string[] = [];

  // fromGif chats to the console per import; keep the batch readable.
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};

  try {
    for (const job of jobs) {
      const outDir = join(args.out, job.packId);
      if (!args.force && existsSync(join(outDir, 'pet.json'))) {
        skipped++;
        continue;
      }
      try {
        await fromGif({
          inputs: [job.walk, job.idle],
          animNames: ['walk', 'idle'],
          outDir,
          id: job.packId,
          name: job.packName,
          author: AUTHOR,
          license: LICENSE,
          speeds: { walk: WALK_SPEED },
          aliases: ALIASES,
        });
        imported++;
        if (imported % 50 === 0) realLog(`  …${imported}/${jobs.length}`);
      } catch (err) {
        failed.push(`${job.packId}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      }
    }
  } finally {
    console.log = realLog;
    console.warn = realWarn;
  }

  console.log(`imported ${imported}, skipped ${skipped} already present (use --force to redo)`);
  if (missing.length > 0) console.log(`skipped by the source: ${missing.join(', ')}`);
  if (failed.length > 0) {
    console.error(`FAILED (${failed.length}):\n  ${failed.join('\n  ')}`);
    return 1;
  }
  console.log('these packs are for your machine only — packs/ is gitignored; never commit or share them.');
  return 0;
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
