import tseslint from 'typescript-eslint';

// ---------------------------------------------------------------------------
// Import-boundary zones (ARCHITECTURE.md §1.2/§1.3, DECISIONS.md D008 A-06).
//
// Zone rules, mechanically enforced:
//   core/**      imports NOTHING outside core (no other zone, no globals)
//   wad/**       pure decoders: may import core only; no sim/render/platform
//   sim/**       HARD rule: may import core + wad only; never render/platform;
//                no DOM/wall-clock globals, no Math.random (determinism)
//   render/**    may import core + wad + read-only sim state (sim/state*);
//                never platform; no DOM/wall-clock globals (platform owns them)
//   platform/**  top of the wiring graph: may import everything; never debug.ts
//   (src/debug.ts and src/main.ts live at src/ root and are outside zones.)
//
// `group` globs below are matched against the raw import specifier with the
// gitignore-style matcher (ESLint no-restricted-imports uses `ignore` with
// allowRelativePaths). `!`-prefixed entries re-allow specifiers matched by an
// earlier entry. Bare `**/<zone>` + `**/<zone>/**` cover directory-index and
// file imports at any relative depth.
// ---------------------------------------------------------------------------

/** @param {string} zoneName */
const zone = (zoneName) => [`**/${zoneName}`, `**/${zoneName}/**`];

const ZONE_LIST = ['core', 'wad', 'sim', 'render', 'platform'];

// src/debug.ts (the window.__doom installer) must never be imported by zone
// code (it is the wiring endpoint, and would cycle); src/types/debug.ts
// (pure type declarations) stays importable.
const DEBUG_ENTRY = [
  '**/debug',
  '**/debug.ts',
  '**/debug.js',
  '!**/types/debug',
  '!**/types/debug.ts',
  '!**/types/debug.js'
];

// Globals that only src/platform/** may touch (ARCHITECTURE §1: platform is
// "the ONLY place DOM/Web APIs are touched"; clock.ts owns wall-clock).
const PLATFORM_ONLY_GLOBALS = [
  'window',
  'document',
  'navigator',
  'location',
  'performance',
  'Date',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'fetch',
  'XMLHttpRequest',
  'localStorage',
  'sessionStorage',
  'indexedDB'
].map((name) => ({
  name,
  message:
    `'${name}' is a DOM/wall-clock API reserved for src/platform/** ` +
    '(ARCHITECTURE.md §1.2; determinism rules §1.3).'
}));

// Math.random would silently break sim determinism; use core/random.ts
// M_Random/P_Random streams instead (R04 §5).
const NO_MATH_RANDOM = {
  selector:
    'CallExpression[callee.object.name="Math"][callee.property.name="random"]',
  message:
    'Math.random() is forbidden in deterministic zones (sim/core/wad); ' +
    'use the P_Random/M_Random streams from core/random.ts (ARCHITECTURE §1.3, R04 §5).'
};

/**
 * Build the no-restricted-imports pattern list for a zone: every zone it may
 * not import plus the debug.ts cycle guard.
 * @param {string[]} forbiddenZones
 * @param {Array<{group: string[], message: string}>} [extra]
 */
const importPatterns = (forbiddenZones, extra = []) => [
  ...(forbiddenZones.length === 0
    ? []
    : [
        {
          group: forbiddenZones.flatMap(zone),
          message:
            'Cross-zone import violates the one-way dependency graph ' +
            '(ARCHITECTURE.md §1.2/§1.3).'
        }
      ]),
  ...extra,
  {
    group: DEBUG_ENTRY,
    message:
      'src/debug.ts is the wiring endpoint (window.__doom); zone code must ' +
      'not import it (ARCHITECTURE.md §1.1).'
  }
];

const deterministicRules = /** @type {const} */ ({
  'no-restricted-globals': ['error', ...PLATFORM_ONLY_GLOBALS],
  'no-restricted-syntax': ['error', NO_MATH_RANDOM]
});

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      'wads/**',
      'docs/**'
    ]
  },
  tseslint.configs.recommended,
  {
    // Global identifiers in plain JS / node scripts are verified by tsc for TS
    // files and by the node runtime for scripts; ESLint's no-undef mostly
    // duplicates TypeScript checking and needs a globals registry to stay in
    // sync, so disable it (the typescript-eslint team also recommends this).
    rules: {
      'no-undef': 'off'
    }
  },

  // --- A-INT1 import-boundary zones -----------------------------------------
  {
    name: 'doom/zones/core',
    files: ['src/core/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          // core imports nothing outside core (ARCHITECTURE §1.2: "core/ imports
          // nothing").
          patterns: importPatterns(
            ZONE_LIST.filter((z) => z !== 'core')
          )
        }
      ],
      ...deterministicRules
    }
  },
  {
    name: 'doom/zones/wad',
    files: ['src/wad/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          // Pure decoders: bytes in, typed data out. core allowed (tables/
          // constants); sim/render/platform forbidden.
          patterns: importPatterns(['sim', 'render', 'platform'])
        }
      ],
      ...deterministicRules
    }
  },
  {
    name: 'doom/zones/sim',
    files: ['src/sim/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          // HARD rule (ARCHITECTURE §1): the deterministic core never imports
          // render/ or platform/; it may import core/ and wad/ (load-time data).
          patterns: importPatterns(['render', 'platform'])
        }
      ],
      ...deterministicRules
    }
  },
  {
    name: 'doom/zones/render',
    files: ['src/render/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: importPatterns(['platform'], [
            {
              // Read-only convention (ARCHITECTURE §1.3): render may reach sim
              // only through the state module (read-views live there); every
              // other sim module exposes mutators and is banned.
              group: ['**/sim/**', '!**/sim/state', '!**/sim/state.*'],
              message:
                'render/ may import sim state only via sim/state (read-only ' +
                'convention, ARCHITECTURE.md §1.3).'
            }
          ])
        }
      ],
      // No Math.random ban: render may use non-reproducible effects without
      // affecting sim determinism, but DOM/wall-clock stay platform-only.
      'no-restricted-globals': ['error', ...PLATFORM_ONLY_GLOBALS]
    }
  },
  {
    name: 'doom/zones/platform',
    files: ['src/platform/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          // Platform sits on top of the graph (calls sim api, reads sim/render
          // state); only src/debug.ts is off-limits (it wires platform modules
          // together; importing it back would cycle).
          patterns: importPatterns([])
        }
      ]
    }
  }
);
