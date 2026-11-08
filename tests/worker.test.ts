import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker.js';
import { CLAUDE_CLIENT_ID } from '../src/remote.js';

// The real Worker entry, OAuth provider included, driven end to end under Node with an
// in-memory KV and a stubbed network (Claude's client metadata document and Cozi).

const ORIGIN = 'https://calendar-connector.example.workers.dev';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

afterEach(() => vi.restoreAllMocks());

function memoryKv() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string, type?: string | { type?: string }) {
      const value = store.get(key);
      if (value === undefined) return null;
      return (typeof type === 'string' ? type : type?.type) === 'json' ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list({ prefix = '' }: { prefix?: string } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

function setup(cozi: { loginStatus: () => number } = { loginStatus: () => 200 }) {
  const kv = memoryKv();
  const env = { OAUTH_KV: kv, ALLOWED_EMAIL: 'parent@example.com', CF_API_TOKEN: 'off' };
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} };
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === CLAUDE_CLIENT_ID) {
      return Response.json({
        client_id: CLAUDE_CLIENT_ID,
        client_name: 'Claude',
        redirect_uris: [CALLBACK],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      });
    }
    if (url.pathname.endsWith('/auth/login')) {
      const status = cozi.loginStatus();
      return status === 200
        ? Response.json({ accessToken: 'cozi-tok', accountId: 'acct', expiresIn: 14400 })
        : Response.json({ error: 'This server could not verify that you are authorized' }, { status });
    }
    if (url.pathname.endsWith('/list/')) return Response.json([{ listId: 'L1', title: 'Groceries', listType: 'shopping', items: [] }]);
    return new Response('unexpected', { status: 599 });
  });
  const call = (path: string, init?: RequestInit) =>
    worker.fetch(new Request(`${ORIGIN}${path}`, init), env as never, ctx as never);
  const outbound = () => fetch.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input));
  return { call, kv, outbound };
}

const b64url = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const form = (fields: Record<string, string>) => ({ method: 'POST', body: new URLSearchParams(fields) });

async function signIn(call: ReturnType<typeof setup>['call']) {
  const verifier = 'v'.repeat(64);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: CLAUDE_CLIENT_ID,
    redirect_uri: CALLBACK,
    state: 'st',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${ORIGIN}/mcp`,
  });
  const page = await call(`/authorize?${query}`);
  expect(page.status).toBe(200);
  const done = await call(`/authorize?${query}`, form({ email: 'parent@example.com', password: 'pw', tz: 'America/Chicago' }));
  expect(done.status).toBe(302);
  const code = new URL(done.headers.get('location')!).searchParams.get('code')!;
  const tokens = await call(
    '/token',
    form({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: CLAUDE_CLIENT_ID, code_verifier: verifier, resource: `${ORIGIN}/mcp` }),
  );
  expect(tokens.status).toBe(200);
  return (await tokens.json()) as { access_token: string; refresh_token: string };
}

const mcp = (token: string | null, body: unknown) => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body),
});

describe('remote Worker', () => {
  it("remembers its own script name and account subdomain from its workers.dev address", async () => {
    const { call, kv } = setup();
    await call('/');
    await vi.waitFor(() => expect(kv.store.get('update:host')).toBe('calendar-connector.example'));
  });

  it('answers /mcp without a token with a 401 that points at the metadata, and calls nothing', async () => {
    const { call, outbound } = setup();
    const res = await call('/mcp', mcp(null, { jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    expect(outbound()).toEqual([]);
    const meta = (await (await call('/.well-known/oauth-protected-resource/mcp')).json()) as { resource: string };
    expect(meta.resource).toBe(`${ORIGIN}/mcp`);
  });

  it('turns away a token request from another client before any fetch or KV write', async () => {
    const { call, kv, outbound } = setup();
    const res = await call('/token', form({ grant_type: 'refresh_token', refresh_token: 'x', client_id: 'https://evil.example/c.json' }));
    expect(res.status).toBe(401);
    expect(outbound()).toEqual([]);
    expect(kv.store.size).toBe(0);
  });

  it('signs in, serves tools with the Cozi session it saved, and keeps the grant through a Cozi outage', async () => {
    let loginStatus = 200;
    const { call, outbound } = setup({ loginStatus: () => loginStatus });
    const { access_token, refresh_token } = await signIn(call);

    const list = await call('/mcp', mcp(access_token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_lists', arguments: {} } }));
    const text = JSON.stringify(await list.json());
    expect(text).toContain('Groceries');
    expect(text).toContain('(America/Chicago)');
    // One login at sign-in; the tool call used the session carried in the grant.
    expect(outbound().filter((u) => u.endsWith('/auth/login') || u.includes('/auth/login?'))).toHaveLength(1);

    loginStatus = 401;
    const refused = await call('/token', form({ grant_type: 'refresh_token', refresh_token, client_id: CLAUDE_CLIENT_ID }));
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ error: 'temporarily_unavailable' });

    loginStatus = 200;
    const renewed = await call('/token', form({ grant_type: 'refresh_token', refresh_token, client_id: CLAUDE_CLIENT_ID }));
    expect(renewed.status).toBe(200);
  });
});
