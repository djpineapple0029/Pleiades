import js from '@eslint/js'
import globals from 'globals'

// V2.md §2.7.4: recommended rules plus a few that catch real bugs. Formatting
// is Prettier's job, not ESLint's. The viewer's "view-only" boundary is
// enforced by the bundle check (§2.4.6), not here.
export default [
  { ignores: ['node_modules/', 'test-results/', 'playwright-report/', '.viewer-build/'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-shadow': 'warn',
    },
  },
  {
    // Node-side code: configs, build scripts, Playwright specs and helpers
    // (page.evaluate bodies still run in the browser, so keep those globals).
    files: ['*.config.js', 'scripts/**', 'tests/**'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
]
