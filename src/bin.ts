#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import createServer from './server.js';

const username = process.env.COZI_USERNAME ?? '';
const password = process.env.COZI_PASSWORD ?? '';
const readOnly = parseBooleanEnv(process.env.COZI_READ_ONLY);

// Fails open toward the LESS restrictive (read-write) mode on anything that
// doesn't parse — but a security-relevant toggle must never fail open
// silently. An operator who mistypes the value should find out, not end up
// with an unrestricted server they believe is locked down.
function parseBooleanEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false;
  process.stderr.write(
    `Cozi MCP: COZI_READ_ONLY="${value}" is not a recognized boolean value ` +
      '(expected true/false, 1/0, yes/no, on/off) — defaulting to read-write mode.\n',
  );
  return false;
}

// Don't exit on missing creds — Smithery's registry scanner spins the server
// up to enumerate tools without auth. Tool calls themselves throw
// AuthenticationError when getClient() sees empty creds, which is the right
// moment for the error to surface (the user sees it via their MCP client).
if (!username || !password) {
  process.stderr.write(
    'Cozi MCP: COZI_USERNAME and COZI_PASSWORD env vars are not set. ' +
      'Tools will fail until both are configured.\n',
  );
}

const server = createServer({ config: { username, password, readOnly } });
const transport = new StdioServerTransport();
await server.connect(transport);
