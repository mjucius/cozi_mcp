import { describe, expect, it, vi } from 'vitest';
import { AuthenticationError, NetworkError } from '../src/cozi/index.js';
import {
  CLAUDE_CLIENT_ID,
  authorizeGate,
  handleAuthorize,
  handleMcp,
  landingPage,
  refreshProps,
  tokenGate,
  type RemoteProps,
  type SignInEnv,
} from '../src/remote.js';
import { makeList } from './helpers/factories.js';
import { asClient, makeMockClient } from './helpers/mock-client.js';

// The remote Worker's gates and pages, driven without the OAuth provider or workerd.

const ORIGIN = 'https://calendar-connector.example.workers.dev';
const AUTH_QUERY = `client_id=${encodeURIComponent(CLAUDE_CLIENT_ID)}&redirect_uri=${encodeURIComponent(
  'https://claude.ai/api/mcp/auth_callback',
)}&response_type=code&state=s1&code_challenge=c&code_challenge_method=S256`;
const SESSION = { accessToken: 't', accountId: 'a', expiresIn: 14400, issuedAt: 1 };
const AUTH_REQUEST = {
  responseType: 'code',
  clientId: CLAUDE_CLIENT_ID,
  redirectUri: 'https://claude.ai/api/mcp/auth_callback',
  scope: [],
  state: 's1',
};

function signInEnv(overrides: Partial<SignInEnv> = {}) {
  const completeAuthorization = vi.fn(async () => ({ redirectTo: 'https://claude.ai/api/mcp/auth_callback?code=x' }));
  const env: SignInEnv = {
    ALLOWED_EMAIL: 'Parent@Example.com',
    OAUTH_PROVIDER: { parseAuthRequest: vi.fn(async () => AUTH_REQUEST), completeAuthorization },
    ...overrides,
  };
  return { env, completeAuthorization };
}

const post = (fields: Record<string, string>) =>
  new Request(`${ORIGIN}/authorize?${AUTH_QUERY}`, { method: 'POST', body: new URLSearchParams(fields) });

describe('client gates', () => {
  it('only Claude may open the sign-in page', () => {
    expect(authorizeGate(new URL(`${ORIGIN}/authorize?${AUTH_QUERY}`))).toBeNull();
    const refused = authorizeGate(new URL(`${ORIGIN}/authorize?client_id=https://evil.example/cimd.json`));
    expect(refused?.status).toBe(400);
    expect(refused?.headers.get('location')).toBeNull();
  });

  it("refuses token requests that are not Claude's public client", async () => {
    const token = (body: Record<string, string>, headers: Record<string, string> = {}) =>
      tokenGate(new Request(`${ORIGIN}/token`, { method: 'POST', body: new URLSearchParams(body), headers }));
    expect(await token({ grant_type: 'refresh_token', client_id: CLAUDE_CLIENT_ID })).toBeNull();
    for (const refused of [
      await token({ grant_type: 'refresh_token', client_id: 'https://evil.example/cimd.json' }),
      await token({ grant_type: 'refresh_token' }),
      await token({ client_id: CLAUDE_CLIENT_ID, client_assertion: 'jwt' }),
      await token({ client_id: CLAUDE_CLIENT_ID }, { Authorization: 'Basic eDp5' }),
    ]) {
      expect(refused?.status).toBe(401);
      expect(await refused?.json()).toMatchObject({ error: 'invalid_client' });
    }
  });
});

describe('sign-in', () => {
  it('GET renders a framing-proof form that posts back to the same request', async () => {
    const { env } = signInEnv();
    const res = await handleAuthorize(new Request(`${ORIGIN}/authorize?${AUTH_QUERY}`), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    // Chrome blocks the redirect back to Claude unless form-action allows its origin.
    expect(res.headers.get('content-security-policy')).toContain("form-action 'self' https://claude.ai;");
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain(`action="/authorize?${AUTH_QUERY.replaceAll('&', '&amp;')}"`);
  });

  it('an invalid authorization request is refused without a redirect', async () => {
    const { env } = signInEnv();
    env.OAUTH_PROVIDER.parseAuthRequest = vi.fn(async () => {
      throw new Error('redirect_uri not registered');
    });
    const res = await handleAuthorize(new Request(`${ORIGIN}/authorize?${AUTH_QUERY}`), env);
    expect(res.status).toBe(400);
  });

  it('a different email never reaches Cozi', async () => {
    const { env, completeAuthorization } = signInEnv();
    const login = vi.fn();
    const res = await handleAuthorize(post({ email: 'someone@else.com', password: 'pw' }), env, login);
    expect(await res.text()).toContain('did not work');
    expect(login).not.toHaveBeenCalled();
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it('refuses everything until ALLOWED_EMAIL is set', async () => {
    const { env } = signInEnv({ ALLOWED_EMAIL: '' });
    const login = vi.fn();
    const res = await handleAuthorize(post({ email: 'parent@example.com', password: 'pw' }), env, login);
    expect(res.status).toBe(503);
    expect(login).not.toHaveBeenCalled();
  });

  it('rate-limits only attempts with the right email', async () => {
    const limit = vi.fn(async () => ({ success: false }));
    const { env } = signInEnv({ SIGNIN_LIMIT: { limit } });
    const login = vi.fn();
    await handleAuthorize(post({ email: 'stranger@x.com', password: 'pw' }), env, login);
    expect(limit).not.toHaveBeenCalled();
    const res = await handleAuthorize(post({ email: 'parent@example.com', password: 'pw' }), env, login);
    expect(await res.text()).toContain('Too many attempts');
    expect(login).not.toHaveBeenCalled();
  });

  it('a password Cozi rejects completes nothing', async () => {
    const { env, completeAuthorization } = signInEnv();
    const login = vi.fn(async () => {
      throw new AuthenticationError('Authentication failed', 401);
    });
    const res = await handleAuthorize(post({ email: 'parent@example.com', password: 'bad' }), env, login);
    expect(await res.text()).toContain('did not work');
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it('signs in as the configured account and keeps other family grants', async () => {
    const { env, completeAuthorization } = signInEnv();
    const login = vi.fn(async () => SESSION);
    const res = await handleAuthorize(
      post({ email: '  PARENT@example.com ', password: 'pw', tz: 'America/Chicago' }),
      env,
      login,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://claude.ai/api/mcp/auth_callback?code=x');
    expect(login).toHaveBeenCalledWith('Parent@Example.com', 'pw');
    expect(completeAuthorization).toHaveBeenCalledWith({
      request: AUTH_REQUEST,
      userId: 'owner',
      metadata: {},
      scope: [],
      props: { u: 'Parent@Example.com', p: 'pw', tz: 'America/Chicago', session: SESSION },
      revokeExistingGrants: false,
    });
  });

  it('drops a time zone the runtime does not know', async () => {
    const { env, completeAuthorization } = signInEnv();
    await handleAuthorize(post({ email: 'parent@example.com', password: 'pw', tz: 'Mars/Olympus' }), env, async () => SESSION);
    const calls = completeAuthorization.mock.calls as unknown as [{ props: RemoteProps }][];
    expect(calls[0]![0].props).not.toHaveProperty('tz');
  });
});

describe('token refresh', () => {
  const props: RemoteProps = { u: 'a@b.c', p: 'pw', tz: 'UTC', session: { ...SESSION, accessToken: 'old' } };

  it('logs in again and carries the fresh session', async () => {
    expect(await refreshProps(props, async () => SESSION)).toEqual({ ...props, session: SESSION });
  });

  it('a failed login issues nothing', async () => {
    await expect(
      refreshProps(props, async () => {
        throw new NetworkError('down');
      }),
    ).rejects.toThrow('down');
  });
});

describe('/mcp', () => {
  const props: RemoteProps = { u: 'a@b.c', p: 'pw', tz: 'America/Denver', session: SESSION };
  const rpc = (body: unknown, headers: Record<string, string> = {}) =>
    new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(body),
    });
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  };

  it('accepts only POST', async () => {
    const res = await handleMcp(new Request(`${ORIGIN}/mcp`), props);
    expect(res.status).toBe(405);
  });

  it("rejects a browser origin that is neither this Worker nor Claude's", async () => {
    expect((await handleMcp(rpc(initialize, { Origin: 'https://evil.example' }), props)).status).toBe(403);
    expect((await handleMcp(rpc(initialize, { Origin: 'https://claude.ai' }), props)).status).toBe(200);
  });

  it('serves initialize, tools/list and a tool call statelessly with one client per request', async () => {
    const init = await handleMcp(rpc(initialize), props);
    expect(init.headers.get('mcp-session-id')).toBeNull();
    expect(await init.json()).toMatchObject({ result: { serverInfo: { name: 'cozi-mcp' } } });

    const list = (await (await handleMcp(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), props)).json()) as {
      result: { tools: unknown[] };
    };
    expect(list.result.tools).toHaveLength(16);

    const mock = makeMockClient();
    mock.getLists.mockResolvedValue([makeList({ id: 'L1', title: 'Groceries' })]);
    const makeClient = vi.fn(() => asClient(mock));
    const call = await handleMcp(
      rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_lists', arguments: {} } }),
      props,
      { makeClient },
    );
    const text = JSON.stringify(await call.json());
    expect(text).toContain('Groceries');
    expect(text).toContain('(America/Denver)');
    expect(makeClient).toHaveBeenCalledWith(props);
  });
});

describe('landing page', () => {
  it('shows the connector URL and escapes what it prints', async () => {
    const res = landingPage(ORIGIN, { enabled: true, status: { at: '2026-10-28T09:17:00.000Z', result: '<b>x</b>' } });
    const html = await res.text();
    expect(html).toContain(`${ORIGIN}/mcp`);
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>x</b>');
  });

  it('links straight to Claude with this server filled in', async () => {
    const html = await landingPage(ORIGIN, { enabled: false, status: null }).text();
    const href = html.match(/class="add" href="([^"]+)"/)![1]!.replaceAll('&amp;', '&');
    const url = new URL(href);
    expect(url.origin + url.pathname).toBe('https://claude.ai/customize/connectors');
    expect(url.searchParams.get('modal')).toBe('add-custom-connector');
    expect(url.searchParams.get('connectorUrl')).toBe(`${ORIGIN}/mcp`);
  });

  it('says when automatic updates are off', async () => {
    expect(await landingPage(ORIGIN, { enabled: false, status: null }).text()).toContain('Automatic updates: off');
  });

  it('does not show a stale "off" once the token is set', async () => {
    const html = await landingPage(ORIGIN, { enabled: true, status: { at: '2026-10-30T01:50:00.000Z', result: 'off' } }).text();
    expect(html).toContain('Automatic updates: on, not checked yet');
  });
});
