import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoziClient } from '../src/cozi/index.js';

// The Cozi web client (bundle main.c43180f9, 2026-10-13) sends the apikey on every
// request and renews its token through the `cozi_refresh` cookie instead of the
// password. These tests drive the real HttpClient against a stubbed fetch.

afterEach(() => {
  vi.restoreAllMocks();
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const LOGIN = { accessToken: 'tok1', accountId: 'acct_1', expiresIn: 3600 };

function stubCozi(route: (url: URL, n: number, init?: RequestInit) => Response | undefined) {
  const calls: URL[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    const hit = route(url, calls.filter((c) => c.pathname === url.pathname).length, init);
    if (hit) return hit;
    if (url.pathname.endsWith('/auth/login')) {
      return json(200, LOGIN, { 'set-cookie': 'cozi_refresh=r1; HttpOnly' });
    }
    return json(200, []);
  });
  return calls;
}

const logins = (calls: URL[]) => calls.filter((u) => u.pathname.endsWith('/auth/login')).length;
const reauths = (calls: URL[]) => calls.filter((u) => u.pathname.endsWith('/auth/reauth')).length;

describe('apikey and token refresh', () => {
  it('sends the apikey on every request, not only login', async () => {
    const calls = stubCozi(() => undefined);
    await new CoziClient('u', 'p').getFamilyMembers();
    expect(calls.map((u) => u.searchParams.get('apikey'))).toEqual([
      'coziwc|v251_production',
      'coziwc|v251_production',
    ]);
  });

  it('answers a 401 with a cookie reauth, not the password', async () => {
    const calls = stubCozi((url, n) => {
      if (url.pathname.endsWith('/account/person/') && n === 1) return json(401, {});
      if (url.pathname === '/api/ext/2111/acct_1/auth/reauth') return json(200, { ...LOGIN, accessToken: 'tok2' });
      return undefined;
    });
    const client = new CoziClient('u', 'p');
    await client.getFamilyMembers();
    expect(logins(calls)).toBe(1);
    expect(reauths(calls)).toBe(1);
  });

  it('falls back to the password when Cozi refuses the refresh', async () => {
    const calls = stubCozi((url, n) => {
      if (url.pathname.endsWith('/account/person/') && n === 1) return json(401, {});
      if (url.pathname.endsWith('/auth/reauth')) return json(401, {});
      return undefined;
    });
    await new CoziClient('u', 'p').getFamilyMembers();
    expect(reauths(calls)).toBe(1);
    expect(logins(calls)).toBe(2);
  });

  it('refreshes before the token expires instead of waiting for a 401', async () => {
    const calls = stubCozi((url) => {
      if (url.pathname.endsWith('/auth/login')) return json(200, { ...LOGIN, expiresIn: 30 });
      if (url.pathname.endsWith('/auth/reauth')) return json(200, LOGIN);
      return undefined;
    });
    const client = new CoziClient('u', 'p');
    await client.getFamilyMembers(); // logs in with a token already inside the margin
    await client.getFamilyMembers(); // so this call refreshes first
    expect(logins(calls)).toBe(1);
    expect(reauths(calls)).toBe(1);
  });

  it('concurrent calls on a fresh client share one login', async () => {
    const calls = stubCozi(() => undefined);
    const client = new CoziClient('u', 'p');
    await Promise.all([client.getFamilyMembers(), client.getLists()]);
    expect(logins(calls)).toBe(1);
  });

  it('a 401 that arrives after the token was renewed replays with it, without a second reauth', async () => {
    // The second request was sent with the old token; its 401 only comes back once the
    // first request's reauth has been accepted, so it must replay, not reauth again.
    let renewed!: () => void;
    const tokenRenewed = new Promise<void>((r) => (renewed = r));
    let rejected = 0;
    const calls: URL[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      calls.push(url);
      if (url.pathname.endsWith('/auth/login')) return json(200, LOGIN, { 'set-cookie': 'cozi_refresh=r1; HttpOnly' });
      if (url.pathname.endsWith('/auth/reauth')) {
        renewed();
        return json(200, { ...LOGIN, accessToken: 'tok2' });
      }
      if (new Headers(init?.headers).get('authorization') !== 'Bearer tok1') return json(200, []);
      if (rejected++ === 0) return json(401, {});
      await tokenRenewed;
      await new Promise((r) => setTimeout(r, 50)); // let the reauth's token be accepted
      return json(401, {});
    });
    const client = new CoziClient('u', 'p');
    await Promise.all([client.getFamilyMembers(), client.getLists()]);
    expect(reauths(calls)).toBe(1);
    expect(logins(calls)).toBe(1);
  });

  it('concurrent 401s share one reauth, and a request that raced it replays with the new token', async () => {
    const calls = stubCozi((url, _n, init) => {
      const auth = new Headers(init?.headers).get('authorization');
      if (!url.pathname.includes('/auth/') && auth === 'Bearer tok1') return json(401, {});
      if (url.pathname.endsWith('/auth/reauth')) return json(200, { ...LOGIN, accessToken: 'tok2' });
      return undefined;
    });
    const client = new CoziClient('u', 'p');
    await Promise.all([client.getFamilyMembers(), client.getLists()]);
    expect(logins(calls)).toBe(1);
    expect(reauths(calls)).toBe(1);
  });
});
