import { defineConfig } from 'vitest/config';
import path from 'path';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // The React plugin transforms .tsx (automatic JSX runtime) so renderer component/hook tests
  // run. Node-based .test.ts files are unaffected. Renderer tests opt into the DOM via a
  // `// @vitest-environment jsdom` docblock on the first line, keeping the default env as node.
  plugins: [react()],
  test: {
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/*.spec.ts', 'tests/**/*.test.ts'],
    alias: {
      electron: path.resolve(__dirname, 'src/server/electron-stub.ts'),
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer'),
    },
  },
});
