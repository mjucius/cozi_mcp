import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { server: 'src/server.ts', bin: 'src/bin.ts' },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  splitting: false,
  shims: false,
  // Bundle all runtime deps into dist/* so the MCPB bundle ships ~120KB total
  // instead of a 46MB node_modules tree. Keep Node built-ins external.
  noExternal: [/^[^node:]/],
});
