import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SERVER_VERSION } from '../src/server.js';

// The version is stated in three places that ship independently: package.json
// (npx), manifest.json (MCPB), and the MCP handshake the client actually reads.
// When they drift, a running server misreports which build it is — which makes
// "did my update take effect?" unanswerable from the outside.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (name: string): { version: string } =>
  JSON.parse(readFileSync(join(repoRoot, name), 'utf8'));

describe('version consistency', () => {
  it('package.json, manifest.json and the advertised server version agree', () => {
    expect(readJson('package.json').version).toBe(SERVER_VERSION);
    expect(readJson('manifest.json').version).toBe(SERVER_VERSION);
  });

  it('SERVER_VERSION is a plain semver triple', () => {
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
