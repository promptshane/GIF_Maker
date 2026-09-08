import { defineConfig } from 'vitest/config';

// Deliberately separate from vite.config.ts: the unit suite is pure Node and
// must not pull in the PWA/service-worker plugin.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
