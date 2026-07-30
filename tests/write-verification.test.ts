import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CoziClient,
  ItemStatus,
  ResourceNotFoundError,
  WriteVerificationError,
  makeAppointment,
} from '../src/cozi/index.js';
import { HttpClient } from '../src/cozi/http.js';

// Cozi answers HTTP 200 for calendar operations it silently discards, naming the
// reason in `rejectedItems`. It also upserts on PUT: updating a non-existent item
// id returns 201 and creates a phantom item. Both behaviours were captured against
// live Cozi on 2026-07-24. These tests pin the client's handling of them.

afterEach(() => {
  vi.restoreAllMocks();
});

const AUTH = { accessToken: 'tok', accountId: 'acct_1' };

type MockOpts = { method: string; endpoint: string; body?: unknown };
type MockResult = { status?: number; body: unknown };

/**
 * Stub both HTTP entry points from one handler, mirroring production: `request`
 * returns just the body, `requestWithStatus` returns body plus status.
 */
function mockHttp(handler: (opts: MockOpts) => MockResult) {
  const respond = (opts: MockOpts): { status: number; body: unknown } => {
    if (opts.endpoint.includes('/auth/login')) return { status: 200, body: AUTH };
    const r = handler(opts);
    return { status: r.status ?? 200, body: r.body };
  };
  vi.spyOn(HttpClient.prototype, 'requestWithStatus').mockImplementation(
    async (opts) => respond(opts as MockOpts) as never,
  );
  vi.spyOn(HttpClient.prototype, 'request').mockImplementation(
    async (opts) => respond(opts as MockOpts).body as never,
  );
}

describe('calendar writes surface rejectedItems (CWE-573 class)', () => {
  const REJECTION = {
    rejectedItems: [
      {
        operation: 'edit',
        id: 'appt_1',
        itemType: 'appointment',
        error:
          "Operation rejected due to request data problem. Detail: Unexpected attribute 'item_version' for AppointmentResource",
      },
    ],
  };

  it('updateAppointment throws when Cozi rejects the edit', async () => {
    mockHttp(() => ({ body: REJECTION }));
    const client = new CoziClient('u', 'p');
    const appt = makeAppointment({ id: 'appt_1', subject: 'S', startDay: '2026-12-04' });

    await expect(client.updateAppointment(appt)).rejects.toThrow(WriteVerificationError);
    await expect(client.updateAppointment(appt)).rejects.toThrow(/item_version/);
  });

  it('updateAppointment succeeds when there is no rejection', async () => {
    mockHttp(() => ({ body: { items: {} } }));
    const client = new CoziClient('u', 'p');
    const appt = makeAppointment({ id: 'appt_1', subject: 'S', startDay: '2026-12-04' });
    await expect(client.updateAppointment(appt)).resolves.toMatchObject({ id: 'appt_1' });
  });

  it('deleteAppointment throws when Cozi rejects the delete', async () => {
    mockHttp(() => ({
      body: { rejectedItems: [{ operation: 'delete', id: 'appt_9', error: 'Operation rejected' }] },
    }));
    const client = new CoziClient('u', 'p');
    await expect(client.deleteAppointment('appt_9', 2026, 12)).rejects.toThrow(
      WriteVerificationError,
    );
  });

  it('createAppointment throws when Cozi rejects the create', async () => {
    mockHttp(() => ({
      body: { rejectedItems: [{ operation: 'create', error: 'Operation rejected: bad payload' }] },
    }));
    const client = new CoziClient('u', 'p');
    const appt = makeAppointment({ subject: 'S', startDay: '2026-12-04' });
    await expect(client.createAppointment(appt)).rejects.toThrow(WriteVerificationError);
  });

  it('ignores a rejection that names a different appointment', async () => {
    mockHttp(() => ({
      body: { rejectedItems: [{ operation: 'edit', id: 'someone_else', error: 'nope' }] },
    }));
    const client = new CoziClient('u', 'p');
    const appt = makeAppointment({ id: 'appt_1', subject: 'S', startDay: '2026-12-04' });
    await expect(client.updateAppointment(appt)).resolves.toBeTruthy();
  });
});

describe('item update rejects the phantom-create upsert', () => {
  it('updateItemText throws on 201 and deletes the phantom', async () => {
    const calls: { method: string; endpoint: string; body?: unknown }[] = [];
    mockHttp((opts) => {
      calls.push(opts);
      if (opts.method === 'PUT') {
        return { status: 201, body: { itemId: 'ghost', text: 'x', status: 'incomplete' } };
      }
      // the compensating PATCH that removes the phantom
      return { status: 200, body: { items: [] } };
    });

    const client = new CoziClient('u', 'p');
    await expect(client.updateItemText('list_1', 'ghost', 'x')).rejects.toThrow(
      ResourceNotFoundError,
    );

    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch, 'phantom cleanup PATCH was not issued').toBeDefined();
    expect(JSON.stringify(patch?.body)).toContain('ghost');
  });

  it('reports that the phantom remains when cleanup fails', async () => {
    mockHttp((opts) => {
      if (opts.method === 'PUT') {
        return { status: 201, body: { itemId: 'ghost', text: 'x', status: 'incomplete' } };
      }
      throw new Error('cleanup failed');
    });
    const client = new CoziClient('u', 'p');
    await expect(client.updateItemText('list_1', 'ghost', 'x')).rejects.toThrow(
      /could NOT be removed/,
    );
  });

  it('markItem also rejects a 201 upsert', async () => {
    mockHttp((opts) => {
      if (opts.method === 'PUT') {
        return { status: 201, body: { itemId: 'ghost', text: 'x', status: 'complete' } };
      }
      return { status: 200, body: { items: [] } };
    });
    const client = new CoziClient('u', 'p');
    await expect(client.markItem('list_1', 'ghost', ItemStatus.COMPLETE)).rejects.toThrow(
      ResourceNotFoundError,
    );
  });

  it('a normal 200 update passes through', async () => {
    mockHttp(() => ({
      status: 200,
      body: { itemId: 'item_1', text: 'new text', status: 'incomplete' },
    }));
    const client = new CoziClient('u', 'p');
    await expect(client.updateItemText('list_1', 'item_1', 'new text')).resolves.toMatchObject({
      text: 'new text',
    });
  });
});

describe('write responses must reflect the request', () => {
  it('addItem throws when the server returns different text', async () => {
    mockHttp(() => ({
      status: 201,
      body: { itemId: 'i1', text: 'SOMETHING ELSE', status: 'incomplete' },
    }));
    const client = new CoziClient('u', 'p');
    await expect(client.addItem('list_1', 'milk', 0)).rejects.toThrow(WriteVerificationError);
  });

  it('markItem throws when the returned status does not match', async () => {
    mockHttp(() => ({
      status: 200,
      body: { itemId: 'i1', text: 't', status: 'incomplete' },
    }));
    const client = new CoziClient('u', 'p');
    await expect(client.markItem('list_1', 'i1', ItemStatus.COMPLETE)).rejects.toThrow(
      WriteVerificationError,
    );
  });

  it('removeItems throws when a removed id is still present in the post-state', async () => {
    mockHttp(() => ({
      status: 200,
      body: { items: [{ itemId: 'still_here', text: 't', status: 'incomplete' }] },
    }));
    const client = new CoziClient('u', 'p');
    await expect(client.removeItems('list_1', ['still_here'])).rejects.toThrow(
      WriteVerificationError,
    );
  });

  it('removeItems succeeds when the ids are gone from the post-state', async () => {
    mockHttp(() => ({ status: 200, body: { items: [{ itemId: 'other', text: 't', status: 'incomplete' }] } }));
    const client = new CoziClient('u', 'p');
    await expect(client.removeItems('list_1', ['removed_one'])).resolves.toBe(true);
  });
});
