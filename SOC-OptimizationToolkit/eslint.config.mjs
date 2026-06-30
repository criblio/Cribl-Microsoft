// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Flat ESLint config. The load-bearing rule is the hexagonal boundary:
 * packages/core must not import infrastructure (Azure/AWS/Cribl SDKs, electron, fs,
 * child_process, the Anthropic/Graph SDKs). The core depends only on ports.
 * See docs/adr/0003-hexagonal-ports-and-adapters.md and docs/adr/0010-*.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/coverage/**',
      'packages/core/assets/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Node globals for plain-JS files (Electron main, scripts). typescript-eslint already
  // disables no-undef for .ts, so this only matters for .js/.cjs/.mjs.
  {
    files: ['**/*.{js,cjs,mjs}'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        __dirname: 'readonly',
        __filename: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },

  // Boundary rule: the pure core may not reach for infrastructure.
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'fs',
              message: 'core must not do IO — depend on a FileSystem/ContentRepo port.',
            },
            {
              name: 'node:fs',
              message: 'core must not do IO — depend on a FileSystem/ContentRepo port.',
            },
            {
              name: 'electron',
              message: 'core must not import electron — it is a frontend detail.',
            },
            { name: 'child_process', message: 'core must not spawn processes — depend on a port.' },
            {
              name: 'node:child_process',
              message: 'core must not spawn processes — depend on a port.',
            },
          ],
          patterns: [
            {
              group: [
                '@azure/*',
                '@aws-sdk/*',
                'aws-sdk',
                '@anthropic-ai/*',
                '@microsoft/microsoft-graph-client',
              ],
              message:
                'core must not import infrastructure SDKs — depend on a port (CloudClient/CriblClient/AiClient/...).',
            },
          ],
        },
      ],
    },
  },

  // Electron main/preload are CommonJS by design (Phase 0 stub); allow require() there.
  {
    files: ['apps/desktop/**/*.{js,cjs}'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // The desktop renderer is a thin shell: it talks to usecases through window.api,
  // never importing adapters or core internals directly. (Composition root in main is exempt.)
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@soc/adapters-*'],
              message: 'The GUI is a thin shell — go through window.api / usecases, not adapters.',
            },
          ],
        },
      ],
    },
  },
);
