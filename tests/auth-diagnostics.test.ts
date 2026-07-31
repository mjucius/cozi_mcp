import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthenticationError, CoziClient, NetworkError } from '../src/cozi/index.js';
import { _resetClientCache, getClient } from '../src/server.js';

// Credentials are captured once at process start (bin.ts), so a corrected
// password does nothing until the client respawns the server. A bare
// 'Authentication failed' hides that entirely; these tests pin the guidance.

afterEach(() => {
  vi.restoreAllMocks();
  _resetClientCache();
});

const rejectAuthWith = (err: unknown) =>
  vi.spyOn(CoziClient.prototype, 'authenticate').mockRejectedValue(err);

describe('auth failure diagnostics', () => {
  it('explains that credentials are captured at startup when Cozi rejects them', async () => {
    rejectAuthWith(new AuthenticationError('Authentication failed', 401, { error: 'bad creds' }));

    const err = await getClient('user@example.com', 'wrong-password').catch((e) => e);

    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.message).toContain('Authentication failed');
    expect(err.message).toContain('read once when the process starts');
    expect(err.message).toContain('restart');
  });

  it('carries the original status code and response data through untouched', async () => {
    rejectAuthWith(new AuthenticationError('Authentication failed', 401, { error: 'bad creds' }));

    const err = await getClient('user@example.com', 'wrong-password').catch((e) => e);

    expect(err.statusCode).toBe(401);
    expect(err.responseData).toEqual({ error: 'bad creds' });
  });

  it('never echoes the credentials into the enriched message', async () => {
    const password = 'SUPER-SECRET-PASSWORD';
    rejectAuthWith(new AuthenticationError('Authentication failed', 401));

    const err = await getClient('user@example.com', password).catch((e) => e);

    expect(err.message).not.toContain(password);
  });

  it('leaves non-auth failures untouched', async () => {
    const network = new NetworkError('socket hang up');
    rejectAuthWith(network);

    const err = await getClient('user@example.com', 'pw').catch((e) => e);

    expect(err).toBe(network);
  });

  it('reports the remaining wait once the lockout trips', async () => {
    rejectAuthWith(new AuthenticationError('Authentication failed', 401));

    for (let i = 0; i < 5; i += 1) {
      await getClient('locked@example.com', 'wrong-password').catch(() => undefined);
    }
    const err = await getClient('locked@example.com', 'wrong-password').catch((e) => e);

    expect(err.message).toMatch(/try again in \d+s/);
    expect(err.message).toContain('restart');
  });

  it('still rejects empty credentials before any network call', async () => {
    const spy = rejectAuthWith(new AuthenticationError('should not be reached', 401));

    const err = await getClient('', '').catch((e) => e);

    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.message).toContain('must be provided');
    expect(spy).not.toHaveBeenCalled();
  });
});
