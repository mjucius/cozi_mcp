import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { 'cloudflare:workers': new URL('./tests/helpers/cloudflare-workers.ts', import.meta.url).pathname },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // The live suite needs real credentials; see vitest.live.config.ts / `npm run test:live`.
    exclude: ['tests/live/**', 'node_modules/**'],
    environment: 'node',
    // Transformed so the alias above reaches its `cloudflare:workers` import.
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
    globals: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/bin.ts'],
      reporter: ['text', 'html'],
    },
  },
});
