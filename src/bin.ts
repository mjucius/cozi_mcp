#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import createServer from './server.js';

const username = process.env.COZI_USERNAME ?? '';
const password = process.env.COZI_PASSWORD ?? '';
const readOnly = parseBooleanEnv(process.env.COZI_READ_ONLY);

function parseBooleanEnv(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
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
