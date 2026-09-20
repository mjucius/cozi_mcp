import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The live suite needs real credentials; see vitest.live.config.ts / `npm run test:live`.
    exclude: ['tests/live/**', 'node_modules/**'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/bin.ts'],
      reporter: ['text', 'html'],
    },
  },
});
