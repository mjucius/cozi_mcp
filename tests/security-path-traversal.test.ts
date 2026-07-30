import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoziClient, ValidationError } from '../src/cozi/index.js';
import { ID_RE, idSeg } from '../src/cozi/client.js';
import { HttpClient } from '../src/cozi/http.js';

// VULN-001 / VULN-002 (CWE-22): caller-supplied ids must be validated at the
// method entry — before any authentication or network I/O — so a traversal /
// query-injection id can never be concatenated into a rest.cozi.com path.

afterEach(() => {
  vi.restoreAllMocks();
});

describe('idSeg boundary validation', () => {
  it('rejects a path-traversal id', () => {
    expect(() => idSeg('../../evil')).toThrow(ValidationError);
  });

  it('rejects an id carrying a slash, dot-dot, query or percent', () => {
    for (const bad of ['a/b', '..', 'x?y', 'a%2e', 'a#b', '']) {
      expect(() => idSeg(bad)).toThrow(ValidationError);
    }
  });

  it('accepts and percent-encodes a GUID-shaped id', () => {
    const id = 'AbC_123-def';
    expect(ID_RE.test(id)).toBe(true);
    expect(idSeg(id)).toBe(encodeURIComponent(id));
  });
});

describe('deleteList path traversal', () => {
  it('rejects with ValidationError WITHOUT any network call', async () => {
    const requestSpy = vi.spyOn(HttpClient.prototype, 'request');
    const client = new CoziClient('user', 'pass');
    await expect(client.deleteList('../../evil')).rejects.toBeInstanceOf(ValidationError);
    // idSeg runs before ensureAuthenticated: no auth, no request.
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('accepts a valid GUID-shaped id (mock http)', async () => {
    const requestSpy = vi
      .spyOn(HttpClient.prototype, 'request')
      .mockImplementation(async (opts) => {
        if (opts.endpoint.includes('/auth/login')) {
          return { accessToken: 'tok', accountId: 'acct_1' };
        }
        return true;
      });
    const client = new CoziClient('user', 'pass');
    const ok = await client.deleteList('list-GUID_1');
    expect(ok).toBe(true);
    const deleteCall = requestSpy.mock.calls.find(([o]) => o.method === 'DELETE');
    expect(deleteCall?.[0].endpoint).toContain('/list/list-GUID_1');
  });
});

describe('updateItemText path traversal', () => {
  it('rejects a traversal item_id with ValidationError WITHOUT any network call', async () => {
    const requestSpy = vi.spyOn(HttpClient.prototype, 'request');
    const client = new CoziClient('user', 'pass');
    await expect(
      client.updateItemText('L1', '../../../other-account/list', 'pwned'),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('rejects a traversal list_id with ValidationError WITHOUT any network call', async () => {
    const requestSpy = vi.spyOn(HttpClient.prototype, 'request');
    const client = new CoziClient('user', 'pass');
    await expect(client.updateItemText('../evil', 'item_1', 'x')).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('accepts valid ids and issues a PUT scoped to those segments (mock http)', async () => {
    // updateItemText goes through requestWithStatus (it must distinguish a 200
    // update from a 201 upsert), so stub that; login still goes through request.
    vi.spyOn(HttpClient.prototype, 'request').mockImplementation(async (opts) => {
      if (opts.endpoint.includes('/auth/login')) return { accessToken: 'tok', accountId: 'acct_1' };
      return { itemId: 'item_1', text: 'renamed', status: 'incomplete' };
    });
    const withStatusSpy = vi
      .spyOn(HttpClient.prototype, 'requestWithStatus')
      .mockImplementation(async (opts) => {
        if (opts.endpoint.includes('/auth/login')) {
          return { status: 200, body: { accessToken: 'tok', accountId: 'acct_1' } };
        }
        return { status: 200, body: { itemId: 'item_1', text: 'renamed', status: 'incomplete' } };
      });
    const client = new CoziClient('user', 'pass');
    const item = await client.updateItemText('list_1', 'item_1', 'renamed');
    expect(item.id).toBe('item_1');
    const putCall = withStatusSpy.mock.calls.find(([o]) => o.method === 'PUT');
    expect(putCall?.[0].endpoint).toContain('/list/list_1/item/item_1');
  });
});
