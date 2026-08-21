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
  // koffi and sharp are native (N-API) modules and must load from
  // node_modules at runtime; electron is provided by the runtime itself.
  // @blerb/petgen (the GUI import pipeline) is bundled — it is pure JS on top
  // of sharp.
  external: ['electron', 'koffi', 'sharp'],
  // Never `clean` — vite owns dist/renderer and builds after us.
  clean: false,
  sourcemap: true,
});
