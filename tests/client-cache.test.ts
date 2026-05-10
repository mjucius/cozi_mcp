import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthenticationError } from '../src/cozi/index.js';
import * as clientModule from '../src/cozi/client.js';
import { _resetClientCache, getClient } from '../src/server.js';

class FakeClient {
  username: string;
  password: string;
  authenticate = vi.fn(async () => undefined);
  constructor(username: string, password: string) {
    this.username = username;
    this.password = password;
  }
}

beforeEach(() => {
  _resetClientCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetClientCache();
});

describe('per-credentials client cache', () => {
  it('same credentials reuse cached client', async () => {
    const constructed: FakeClient[] = [];
    vi.spyOn(clientModule, 'CoziClient').mockImplementation(((u: string, p: string) => {
      const c = new FakeClient(u, p);
      constructed.push(c);
      return c;
    }) as unknown as typeof clientModule.CoziClient);

    const c1 = await getClient('alice', 'pw1');
    const c2 = await getClient('alice', 'pw1');
    expect(c1).toBe(c2);
    expect(constructed.length).toBe(1);
    expect(constructed[0]?.authenticate).toHaveBeenCalledOnce();
  });

  it('different credentials get separate clients', async () => {
    const constructed: FakeClient[] = [];
    vi.spyOn(clientModule, 'CoziClient').mockImplementation(((u: string, p: string) => {
      const c = new FakeClient(u, p);
      constructed.push(c);
      return c;
    }) as unknown as typeof clientModule.CoziClient);

    const cAlice = await getClient('alice', 'pw1');
    const cBob = await getClient('bob', 'pw2');
    const cAliceAgain = await getClient('alice', 'pw1');
    expect(cAlice).not.toBe(cBob);
    expect(cAlice).toBe(cAliceAgain);
    expect((cAlice as unknown as FakeClient).username).toBe('alice');
    expect((cBob as unknown as FakeClient).username).toBe('bob');
    expect(constructed.length).toBe(2);
  });

  it('missing username raises AuthenticationError', async () => {
    await expect(getClient('', 'pw')).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('missing password raises AuthenticationError', async () => {
    await expect(getClient('alice', '')).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('same username, different password creates a new client', async () => {
    const constructed: FakeClient[] = [];
    vi.spyOn(clientModule, 'CoziClient').mockImplementation(((u: string, p: string) => {
      const c = new FakeClient(u, p);
      constructed.push(c);
      return c;
    }) as unknown as typeof clientModule.CoziClient);

    const c1 = await getClient('alice', 'old');
    const c2 = await getClient('alice', 'new');
    expect(c1).not.toBe(c2);
    expect(constructed.length).toBe(2);
  });
});
