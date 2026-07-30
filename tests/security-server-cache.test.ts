import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthenticationError } from '../src/cozi/index.js';
import * as clientModule from '../src/cozi/client.js';
import { _resetClientCache, getClient } from '../src/server.js';

// FakeClient mirrors tests/client-cache.test.ts, plus tokenLifetimeMs so the
// server's expiry re-validation (VULN-004) can be exercised deterministically.
const HOUR_MS = 60 * 60 * 1000;

class FakeClient {
  username: string;
  password: string;
  tokenLifetimeMs: number | null = HOUR_MS;
  authenticate = vi.fn(async () => undefined);
  constructor(username: string, password: string) {
    this.username = username;
    this.password = password;
  }
}

function spyConstruct(): FakeClient[] {
  const constructed: FakeClient[] = [];
  vi.spyOn(clientModule, 'CoziClient').mockImplementation(((u: string, p: string) => {
    const c = new FakeClient(u, p);
    constructed.push(c);
    return c;
  }) as unknown as typeof clientModule.CoziClient);
  return constructed;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  _resetClientCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  _resetClientCache();
});

describe('VULN-004: credential cache TTL / re-validation', () => {
  it('reuses the cached client while the token is fresh', async () => {
    const constructed = spyConstruct();
    const c1 = await getClient('alice', 'pw');
    vi.setSystemTime(1000); // 1s later — well within lifetime
    const c2 = await getClient('alice', 'pw');
    expect(c2).toBe(c1);
    expect(constructed.length).toBe(1);
    expect(constructed[0]?.authenticate).toHaveBeenCalledOnce();
  });

  it('re-authenticates once the token nears expiry (hit past lifetime)', async () => {
    const constructed = spyConstruct();
    const c1 = await getClient('alice', 'pw');
    // Advance past 0.9 * lifetime so the cached entry is considered stale.
    vi.setSystemTime(HOUR_MS * 0.95);
    const c2 = await getClient('alice', 'pw');
    expect(c2).not.toBe(c1);
    expect(constructed.length).toBe(2);
    expect(constructed[1]?.authenticate).toHaveBeenCalledOnce();
  });

  it('does not expire before the safety-margined threshold', async () => {
    const constructed = spyConstruct();
    const c1 = await getClient('alice', 'pw');
    vi.setSystemTime(HOUR_MS * 0.5); // half a lifetime — still fresh
    const c2 = await getClient('alice', 'pw');
    expect(c2).toBe(c1);
    expect(constructed.length).toBe(1);
  });

  it('never-expiring lifetime (null) still serves the same client', async () => {
    const constructed: FakeClient[] = [];
    vi.spyOn(clientModule, 'CoziClient').mockImplementation(((u: string, p: string) => {
      const c = new FakeClient(u, p);
      c.tokenLifetimeMs = null;
      constructed.push(c);
      return c;
    }) as unknown as typeof clientModule.CoziClient);
    const c1 = await getClient('alice', 'pw');
    vi.setSystemTime(1000);
    const c2 = await getClient('alice', 'pw');
    expect(c2).toBe(c1);
    expect(constructed.length).toBe(1);
  });
});

describe('VULN-007: per-username failed-login lockout', () => {
  it('eventually throws the lockout error after repeated failures', async () => {
    const constructed: FakeClient[] = [];
    vi.spyOn(clientModule, 'CoziClient').mockImplementation(((u: string, p: string) => {
      const c = new FakeClient(u, p);
      c.authenticate = vi.fn(async () => {
        throw new AuthenticationError('Authentication failed');
      });
      constructed.push(c);
      return c;
    }) as unknown as typeof clientModule.CoziClient);

    // The first LOCKOUT_THRESHOLD (5) attempts surface the underlying auth error.
    for (let i = 0; i < 5; i++) {
      await expect(getClient('bob', 'wrong')).rejects.toThrow(/Authentication failed/);
    }
    // The next attempt is refused by the lockout gate before any auth call.
    const attemptsBeforeLockout = constructed.length;
    await expect(getClient('bob', 'wrong')).rejects.toThrow(/Too many failed login attempts/);
    // Lockout short-circuits before constructing/authenticating a new client.
    expect(constructed.length).toBe(attemptsBeforeLockout);
  });

  it('a successful login clears the failure counter', async () => {
    let failNext = true;
    vi.spyOn(clientModule, 'CoziClient').mockImplementation(((u: string, p: string) => {
      const c = new FakeClient(u, p);
      c.authenticate = vi.fn(async () => {
        if (failNext) throw new AuthenticationError('Authentication failed');
      });
      return c;
    }) as unknown as typeof clientModule.CoziClient);

    // A couple of failures (below threshold), then a success resets the counter.
    await expect(getClient('carol', 'wrong')).rejects.toThrow(/Authentication failed/);
    await expect(getClient('carol', 'wrong')).rejects.toThrow(/Authentication failed/);
    failNext = false;
    await expect(getClient('carol', 'right')).resolves.toBeDefined();

    // Counter cleared: fresh failures start over and are NOT immediately locked out.
    failNext = true;
    await expect(getClient('carol', 'wrong2')).rejects.toThrow(/Authentication failed/);
  });
});
