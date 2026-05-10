import { describe, expect, it } from 'vitest';
import {
  APIError,
  AuthenticationError,
  CoziError,
  NetworkError,
  PermissionDeniedError,
  RateLimitError,
  ResourceNotFoundError,
  ValidationError,
} from '../src/cozi/index.js';
import {
  createAppointmentHandler,
  deleteAppointmentHandler,
  getCalendarHandler,
} from '../src/tools/calendar.js';
import { familyMembersHandler } from '../src/tools/family.js';
import { addItemHandler, removeItemsHandler } from '../src/tools/items.js';
import { deleteListHandler, getListsHandler } from '../src/tools/lists.js';
import { asClient, makeMockClient } from './helpers/mock-client.js';

describe('error propagation', () => {
  const errorClasses = [
    AuthenticationError,
    APIError,
    ResourceNotFoundError,
    RateLimitError,
    ValidationError,
    PermissionDeniedError,
    NetworkError,
  ] as const;

  for (const Cls of errorClasses) {
    it(`get_lists propagates ${Cls.name}`, async () => {
      const m = makeMockClient();
      m.getLists.mockRejectedValue(new Cls('boom'));
      await expect(getListsHandler(asClient(m))).rejects.toBeInstanceOf(Cls);
    });
  }

  it('family_members propagates APIError', async () => {
    const m = makeMockClient();
    m.getFamilyMembers.mockRejectedValue(new APIError('oops'));
    await expect(familyMembersHandler(asClient(m))).rejects.toBeInstanceOf(APIError);
  });

  it('add_item propagates ValidationError', async () => {
    const m = makeMockClient();
    m.addItem.mockRejectedValue(new ValidationError('bad text'));
    await expect(addItemHandler(asClient(m), 'L1', 'Eggs', 0)).rejects.toBeInstanceOf(ValidationError);
  });

  it('remove_items propagates ResourceNotFoundError', async () => {
    const m = makeMockClient();
    m.removeItems.mockRejectedValue(new ResourceNotFoundError('missing'));
    await expect(removeItemsHandler(asClient(m), 'L1', ['i1'])).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  it('delete_list propagates PermissionDeniedError', async () => {
    const m = makeMockClient();
    m.deleteList.mockRejectedValue(new PermissionDeniedError('nope'));
    await expect(deleteListHandler(asClient(m), 'L1')).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('get_calendar propagates RateLimitError', async () => {
    const m = makeMockClient();
    m.getCalendar.mockRejectedValue(new RateLimitError('slow down'));
    await expect(getCalendarHandler(asClient(m), 2026, 5)).rejects.toBeInstanceOf(RateLimitError);
  });

  it('create_appointment propagates APIError (when ID can\'t be located)', async () => {
    const m = makeMockClient();
    m.createAppointment.mockRejectedValue(new APIError('not found in response'));
    await expect(
      createAppointmentHandler(
        asClient(m),
        'X',
        '2026-05-15T10:00:00',
        '2026-05-15T11:00:00',
        undefined,
        false,
        '',
        undefined,
      ),
    ).rejects.toBeInstanceOf(APIError);
  });

  it('delete_appointment propagates NetworkError', async () => {
    const m = makeMockClient();
    m.deleteAppointment.mockRejectedValue(new NetworkError('flaky'));
    await expect(deleteAppointmentHandler(asClient(m), 'appt', 2026, 5)).rejects.toBeInstanceOf(
      NetworkError,
    );
  });

  it('subclass caught as CoziError', async () => {
    const m = makeMockClient();
    m.getLists.mockRejectedValue(new ResourceNotFoundError('x'));
    await expect(getListsHandler(asClient(m))).rejects.toBeInstanceOf(CoziError);
  });

  it('non-Cozi errors propagate (not silently swallowed)', async () => {
    const m = makeMockClient();
    m.getLists.mockRejectedValue(new Error('unexpected'));
    await expect(getListsHandler(asClient(m))).rejects.toThrow(/unexpected/);
  });
});
