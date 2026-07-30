import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthenticationError, CoziClient } from '../src/cozi/index.js';
import { HttpClient } from '../src/cozi/http.js';

// VULN-006 (CWE-209): a malformed login response must never be serialized into
// the thrown error. The message names only which required field was missing —
// no token material, no response body.

afterEach(() => {
  vi.restoreAllMocks();
});

describe('login response leak', () => {
  it('missing accessToken throws without leaking the response body/tokens', async () => {
    const secretRefresh = 'REFRESH-SECRET-DO-NOT-LEAK';
    const secretSession = 'SESSION-SECRET-DO-NOT-LEAK';
    vi.spyOn(HttpClient.prototype, 'request').mockResolvedValue({
      // no accessToken — but other token-shaped material is present
      accountId: 'acct_1',
      refreshToken: secretRefresh,
      sessionToken: secretSession,
    });

    const client = new CoziClient('user', 'pass');
    let caught: unknown;
    try {
      await client.authenticate();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AuthenticationError);
    const message = (caught as Error).message;
    expect(message).toContain('accessToken');
    expect(message).not.toContain(secretRefresh);
    expect(message).not.toContain(secretSession);
    expect(message).not.toContain('acct_1');
    // The full response body must not be JSON-dumped into the message.
    expect(message).not.toContain('{');
  });

  it('missing accountId throws naming the field, not the tokens', async () => {
    const secretAccess = 'ACCESS-SECRET-DO-NOT-LEAK';
    vi.spyOn(HttpClient.prototype, 'request').mockResolvedValue({
      accessToken: secretAccess,
      // no accountId
    });

    const client = new CoziClient('user', 'pass');
    let caught: unknown;
    try {
      await client.authenticate();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AuthenticationError);
    const message = (caught as Error).message;
    expect(message).toContain('accountId');
    expect(message).not.toContain(secretAccess);
  });
});
