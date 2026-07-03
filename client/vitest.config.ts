import { defineConfig } from 'vitest/config';

// Client unit tests (pure logic — no DOM). Node environment; picks up src/**/*.test.ts.
// Kept separate from the app build (tsconfig.app.json excludes *.test.ts) and from the
// server gate (root `npm test` runs node:test over server/**). Run: `npm test` in client/,
// or `npx vitest run` from the repo root.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
