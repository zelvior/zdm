// Minimal lint setup: catch real mistakes (undefined names, accidental fall-through, empty statements) without
// imposing a style on the existing code. Style is Prettier's job and is opt-in (see format script).
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'release/**',
      'legacy/stage/**',
      'legacy/release/**',
      'vendor/**',
      'scripts/__pycache__/**',
      'assets/**',
      'build/**',
      'docs/**'
    ]
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
        chrome: 'readonly',
        browser: 'readonly',
        importScripts: 'readonly'
      }
    },
    rules: {
      // The codebase intentionally uses clever but valid loops and catches; keep those out of the way.
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-control-regex': 'off', // sanitising file names and native messages deliberately rejects control characters
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-func-assign': 'off', // renderer/app.js wraps renderDetails deliberately
      'no-preserve-caught-error': 'off',
      'preserve-caught-error': 'off', // upstream error text is deliberately rewritten to remove URLs and secrets
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-useless-assignment': 'off',
      'no-useless-escape': 'off' // several patterns escape '/' for readability across regex literals
    }
  }
];
