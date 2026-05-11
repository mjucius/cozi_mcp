#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import createServer from './server.js';

const username = process.env.COZI_USERNAME ?? '';
const password = process.env.COZI_PASSWORD ?? '';

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

const server = createServer({ config: { username, password } });
const transport = new StdioServerTransport();
await server.connect(transport);
