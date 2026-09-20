import { defineConfig } from 'vitest/config';

// Live conformance suite: runs against the REAL Cozi API with the credentials in
// creds.env (or COZI_USERNAME / COZI_PASSWORD). Serial, slow, self-cleaning.
//   npm run test:live
export default defineConfig({
  test: {
    include: ['tests/live/**/*.test.ts'],
    environment: 'node',
    globals: false,
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
