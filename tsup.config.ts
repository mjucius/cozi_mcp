import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { server: 'src/server.ts', bin: 'src/bin.ts', worker: 'src/worker.ts' },
  format: ['esm'],
  // Only the npm library entry has consumers that need types; the Worker entry is bundled by wrangler.
  dts: { entry: { server: 'src/server.ts' } },
  sourcemap: true,
  clean: true,
  target: 'node22',
  splitting: false,
  shims: false,
  // Bundle all runtime deps into dist/* so the MCPB bundle ships ~120KB total
  // instead of a 46MB node_modules tree. Keep Node built-ins external, and the
  // Workers runtime module the OAuth provider imports.
  noExternal: [/^(?!node:|cloudflare:)/],
  external: ['cloudflare:workers'],
});
