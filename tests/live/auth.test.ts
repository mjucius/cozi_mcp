// Live conformance: token refresh and the every-request apikey against the REAL Cozi API.
// The client falls back to a password login when the cookie refresh fails, so a broken
// refresh would never surface as an error — this test is what notices it.

import { describe, expect, it, vi } from 'vitest';

import { Live, haveCreds } from './harness.js';

describe.skipIf(!haveCreds)('live auth conformance', () => {
  it('renews the token through the refresh cookie, without the password', async () => {
    const live = new Live();
    await live.authenticate();
    const client = live.client as unknown as { refresh(): Promise<void>; accessToken: string | null };
    const login = vi.spyOn(live.client, 'authenticate');

    await client.refresh();

    // A still-valid token may come back unchanged, so the proof is that the password
    // path never ran. Never assert on the token's value: a failure would print it.
    expect(login).not.toHaveBeenCalled();
    expect(typeof client.accessToken === 'string' && client.accessToken.length > 0).toBe(true);
    // The new token works, on a resource call that now also carries the apikey.
    expect(Array.isArray(await live.client.getFamilyMembers())).toBe(true);
  });
});
