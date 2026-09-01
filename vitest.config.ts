import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts'],
    // The grading pipeline test suite drives the whole pipeline end to end,
    // including PDF parsing, so give it more than the 5s default.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    reporters: ['verbose'],
  },
  resolve: {
    alias: {
      '@gradesense/shared': new URL('./packages/shared/src/index.ts', import.meta.url).pathname,
    },
  },
});
