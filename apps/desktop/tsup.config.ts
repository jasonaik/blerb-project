import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    main: 'src/main/main.ts',
    'preload/overlay': 'src/preload/overlay.ts',
    'preload/settings': 'src/preload/settings.ts',
  },
  outDir: 'dist',
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  // koffi is a native (N-API) module and must load from node_modules at
  // runtime; electron is provided by the runtime itself.
  external: ['electron', 'koffi'],
  // Never `clean` — vite owns dist/renderer and builds after us.
  clean: false,
  sourcemap: true,
});
