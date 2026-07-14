import { defineConfig } from 'vitest/config';

// Root Vitest config. Node environment by default (pure core + adapters).
// Renderer/DOM tests opt in per-file with:  // @vitest-environment jsdom
export default defineConfig({
  test: {
    globals: true,
    include: ['packages/**/src/**/*.{test,spec}.ts', 'apps/**/src/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/**/src/**'],
      exclude: ['**/*.{test,spec}.ts', '**/index.ts'],
      thresholds: {
        // Ratchets up as the core grows (Phase 1+). Starts permissive on the empty scaffold.
        'packages/core/src/**': { statements: 0, branches: 0, functions: 0, lines: 0 },
      },
    },
  },
});
