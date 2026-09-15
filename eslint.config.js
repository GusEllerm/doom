import tseslint from 'typescript-eslint';

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
  }
);
