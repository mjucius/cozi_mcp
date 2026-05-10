#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import createServer from './server.js';

const username = process.env.COZI_USERNAME ?? '';
const password = process.env.COZI_PASSWORD ?? '';

if (!username || !password) {
  process.stderr.write(
    'Cozi MCP: COZI_USERNAME and COZI_PASSWORD env vars are required.\n' +
      'For Claude Desktop (MCPB) configure them in the extension settings.\n' +
      'For local use: COZI_USERNAME=you@example.com COZI_PASSWORD=… npx @mjucius/cozi-mcp\n',
  );
  process.exit(1);
}

const server = createServer({ config: { username, password } });
const transport = new StdioServerTransport();
await server.connect(transport);
