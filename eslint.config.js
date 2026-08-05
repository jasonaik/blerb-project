// @ts-check
import tseslint from 'typescript-eslint';

/**
 * The load-bearing rule in this file is `pure-packages` below.
 *
 * @blerb/core and @blerb/game are the two packages that must stay portable and
 * deterministic — they are the pet's brain and the game's rules, and every host
 * (today Electron, tomorrow whatever) drives the same code. The moment one of
 * them reaches for `electron`, `node:fs`, or `document`, that portability is
 * gone and it is very hard to get back.
 *
 * See CLAUDE.md § "Monorepo map + import rules".
 */

const PLATFORM_IMPORTS = [
  { name: 'electron', message: 'Platform import in a pure package. Adapters live in apps/.' },
  { name: 'sharp', message: 'Node-only import in a pure package. Belongs in @blerb/petgen.' },
  { name: '@napi-rs/canvas', message: 'Node-only import in a pure package. Belongs in @blerb/petgen.' },
];

const PLATFORM_PATTERNS = [
  { group: ['node:*'], message: 'Node builtin in a pure package. Inject the capability instead.' },
  { group: ['electron/*'], message: 'Platform import in a pure package. Adapters live in apps/.' },
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo'] },

  ...tseslint.configs.recommended,

  {
    name: 'pure-packages',
    files: ['packages/core/src/**/*.ts', 'packages/game/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: PLATFORM_IMPORTS, patterns: PLATFORM_PATTERNS },
      ],
      // The sim must never read ambient browser state. Everything it knows
      // arrives through World or PetEvent, which is what makes it testable
      // without a DOM and reproducible from a seed.
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'The sim receives state via World/PetEvent. It does not observe.' },
        { name: 'document', message: 'The sim receives state via World/PetEvent. It does not observe.' },
        { name: 'navigator', message: 'The sim receives state via World/PetEvent. It does not observe.' },
        { name: 'localStorage', message: 'Persistence is the host adapter\'s job.' },
        { name: 'fetch', message: 'Inject a fetcher (see loadPack) rather than reaching for a global.' },
      ],
      // Non-determinism breaks snapshot tests and makes bugs unreproducible.
      // The sim carries its own seeded rng in PetState; time arrives as dt.
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use the seeded rng in PetState. See mulberry32.' },
        { object: 'Date', property: 'now', message: 'Time arrives as dt in step(). The sim owns no clock.' },
      ],
    },
  },
);
