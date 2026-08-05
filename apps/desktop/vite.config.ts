import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Renderer build only (the overlay page). Main + preloads are tsup's job.
// Aliases point at package *sources* so no pre-build of the workspace is
// needed — same trick as the petgen preview.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  resolve: {
    alias: {
      '@blerb/pack': resolve(__dirname, '../../packages/pack/src/index.ts'),
      '@blerb/core': resolve(__dirname, '../../packages/core/src/index.ts'),
      '@blerb/render-canvas': resolve(__dirname, '../../packages/render-canvas/src/index.ts'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome120',
    rollupOptions: {
      input: { overlay: resolve(__dirname, 'src/renderer/overlay.html') },
    },
  },
});
