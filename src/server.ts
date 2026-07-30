import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AuthenticationError, CoziClient } from './cozi/index.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';
import { registerCoziTools } from './tools/index.js';

export const configSchema = z.object({
  username: z.string().describe('Cozi account username/email'),
  password: z.string().describe('Cozi account password'),
  readOnly: z.boolean().optional().describe('Expose read-only MCP tools and hide write tools'),
});
export type Config = z.infer<typeof configSchema>;

const clients = new Map<string, { client: CoziClient; authAt: number }>();
const cacheKey = (username: string, password: string) => `${username}\u0000${password}`;

// VULN-007: throttle repeated fresh-auth attempts per username to prevent an
// unauthenticated actor from using this server as a credential oracle/relay.
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_BASE_MS = 1_000;
const LOCKOUT_CAP_MS = 15 * 60 * 1_000;
const authFailures = new Map<string, { fails: number; lockedUntil: number }>();

export async function getClient(username: string, password: string): Promise<CoziClient> {
  if (!username || !password) {
    throw new AuthenticationError('Cozi username and password must be provided');
  }
  const key = cacheKey(username, password);

  // VULN-004: cache hits are re-validated once the token nears expiry so a
  // rotated/revoked password stops working instead of living forever.
  const entry = clients.get(key);
  if (entry) {
    const life = entry.client.tokenLifetimeMs;
    const stale = life != null && Date.now() - entry.authAt >= life * 0.9;
    if (!stale) return entry.client;
    clients.delete(key);
  }

  const failure = authFailures.get(username);
  if (failure && Date.now() < failure.lockedUntil) {
    throw new AuthenticationError('Too many failed login attempts; try again later');
  }

  const client = new CoziClient(username, password);
  try {
    await client.authenticate();
  } catch (err) {
    const current = authFailures.get(username) ?? { fails: 0, lockedUntil: 0 };
    current.fails += 1;
    if (current.fails >= LOCKOUT_THRESHOLD) {
      const backoff = Math.min(
        LOCKOUT_BASE_MS * 2 ** (current.fails - LOCKOUT_THRESHOLD),
        LOCKOUT_CAP_MS,
      );
      current.lockedUntil = Date.now() + backoff;
    }
    authFailures.set(username, current);
    throw err;
  }
  authFailures.delete(username);
  clients.set(key, { client, authAt: Date.now() });
  return client;
}

export function _resetClientCache(): void {
  clients.clear();
  authFailures.clear();
}

export default function createServer({ config }: { config: Config }): McpServer {
  const server = new McpServer(
    { name: 'cozi-mcp', version: '2.1.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerCoziTools(
    server,
    () => getClient(config.username, config.password),
    config.readOnly === true ? 'read-only' : 'read-write',
  );
  return server;
}
