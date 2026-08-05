import { createServer } from 'vite';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
/** dist/commands/ or src/commands/ — either way, two levels up is the package root. */
const packageRoot = resolve(here, '../..');
const previewRoot = join(packageRoot, 'preview');
const repoRoot = resolve(packageRoot, '../..');

const MIME: Record<string, string> = {
  '.json': 'application/json',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

/**
 * Serves the pack under /pack/ so the preview page can fetch it by a stable
 * URL regardless of where on disk the pack actually lives. Keeps the page free
 * of any path knowledge, which is what lets `petgen preview <anything>` work.
 */
function servePack(packDir: string): Plugin {
  return {
    name: 'blerb:serve-pack',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/pack/')) return next();

        // Strip the query string and refuse anything trying to climb out.
        const rel = decodeURIComponent(url.slice('/pack/'.length).split('?')[0] ?? '');
        const target = resolve(packDir, rel);
        if (!target.startsWith(packDir) || !existsSync(target) || !statSync(target).isFile()) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }

        res.setHeader('Content-Type', MIME[extname(target).toLowerCase()] ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        createReadStream(target).pipe(res);
      });
    },
  };
}

export interface PreviewOptions {
  packDir: string;
  port: number;
  open: boolean;
}

/**
 * Accept a pack path relative to either the cwd or the repo root, so
 * `petgen preview packs/blob` means the same thing from anywhere — including
 * from inside packages/petgen, which is where `pnpm --filter` puts you.
 */
function findPack(input: string): string {
  const candidates = [resolve(process.cwd(), input), resolve(repoRoot, input)];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'pet.json'))) return dir;
  }
  throw new Error(
    `no pet.json found. Looked in:\n${candidates.map((c) => `  ${c}`).join('\n')}`,
  );
}

export async function preview(opts: PreviewOptions): Promise<void> {
  const packDir = findPack(opts.packDir);

  const server = await createServer({
    root: previewRoot,
    configFile: false,
    resolve: {
      /**
       * Point the workspace packages at their sources rather than their build
       * output. Without this you'd have to `pnpm build` between every edit to
       * the sim, which would make this preview useless as an inner loop —
       * and the inner loop is the entire reason it exists.
       */
      alias: {
        '@blerb/pack': join(repoRoot, 'packages/pack/src/index.ts'),
        '@blerb/core': join(repoRoot, 'packages/core/src/index.ts'),
        '@blerb/render-canvas': join(repoRoot, 'packages/render-canvas/src/index.ts'),
      },
    },
    server: {
      port: opts.port,
      open: opts.open,
      fs: { allow: [repoRoot] },
    },
    plugins: [servePack(packDir)],
  });

  await server.listen();
  console.log(`\n  pack     ${packDir}`);
  server.printUrls();
  console.log('\n  d debug overlay · r recenter · click to call the pet · q quit\n');
}
