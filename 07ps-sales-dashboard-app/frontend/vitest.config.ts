import path from 'node:path';
import { defineConfig } from 'vitest/config';

/** Frontend unit tests: pure helpers run in Node, component tests (*.test.tsx) in jsdom with React Testing Library. */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environmentMatchGlobs: [['src/**/*.test.tsx', 'jsdom']],
  },
});
