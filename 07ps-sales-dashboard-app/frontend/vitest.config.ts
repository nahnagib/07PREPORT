import path from 'node:path';
import { defineConfig } from 'vitest/config';

/** Frontend (and packages/ui) unit tests: pure helpers run in Node, component tests (*.test.tsx) in jsdom with React Testing Library. */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    // packages/ui has no runner of its own: its component tests run here (the old Gauge script is not a vitest file).
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', '../packages/ui/src/**/__tests__/!(*.regression).test.tsx'],
    environmentMatchGlobs: [['src/**/*.test.tsx', 'jsdom'], ['../packages/ui/src/**/*.test.tsx', 'jsdom']],
  },
});
