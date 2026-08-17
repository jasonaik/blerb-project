import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Test against sources, not build output — otherwise a green test run only
    // proves the last build was correct.
    alias: {
      '@blerb/pack': src('pack'),
      '@blerb/core': src('core'),
      '@blerb/game': src('game'),
      '@blerb/render-canvas': src('render-canvas'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
  },
});
