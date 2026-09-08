import { describe, expect, it } from 'vitest';
import {
  ResourceNotFoundError,
  ValidationError,
  toApiCreateFormat,
  toApiEditFormat,
  type CoziAppointment,
} from '../src/cozi/index.js';
import {
  createAppointmentHandler,
  deleteAppointmentHandler,
  getCalendarHandler,
  updateAppointmentHandler,
} from '../src/tools/calendar.js';
import { makeAppointment } from './helpers/factories.js';
import { asClient, makeMockClient } from './helpers/mock-client.js';

describe('get_calendar', () => {
  it('returns slim list', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([
      makeAppointment({
        id: 'a1',
        subject: 'Soccer',
        startDay: '2026-05-15',
        startTime: { h: 10, m: 0 },
        endTime: { h: 11, m: 0 },
        attendees: ['alice'],
        location: null,
        notes: null,
      }),
      makeAppointment({
        id: 'a2',
        subject: 'Birthday',
        startDay: '2026-05-20',
        startTime: null,
        endTime: null,
        attendees: [],
        location: null,
        notes: null,
      }),
    ]);
    const result = await getCalendarHandler(asClient(m), 2026, 5);
    expect(result[0]?.id).toBe('a1');
    expect(result[0]?.all_day).toBe(false);
    expect(result[0]?.start).toBe('2026-05-15T10:00');
    expect(result[1]?.id).toBe('a2');
    expect(result[1]?.all_day).toBe(true);
    expect('start' in (result[1] ?? {})).toBe(false);
    expect(m.getCalendar).toHaveBeenCalledOnce();
    expect(m.getCalendar).toHaveBeenCalledWith(2026, 5);
  });
});

describe('create_appointment', () => {
  it('timed event sends parsed start/end times', async () => {
    const m = makeMockClient();
    m.createAppointment.mockImplementation(async (a: CoziAppointment) => ({ ...a, id: 'new_id' }));
    await createAppointmentHandler(
      asClient(m),
      'Meeting',
      '2026-05-15T10:00:00',
      '2026-05-15T11:00:00',
      ['alice'],
      false,
      'Prep slides',
      'Room 1',
    );
    const sent = m.createAppointment.mock.calls[0]?.[0] as CoziAppointment;
    expect(sent.subject).toBe('Meeting');
    expect(sent.startDay).toBe('2026-05-15');
    expect(sent.startTime).toEqual({ h: 10, m: 0 });
    expect(sent.endTime).toEqual({ h: 11, m: 0 });
    expect(sent.attendees).toEqual(['alice']);
    expect(sent.location).toBe('Room 1');
    expect(sent.notes).toBe('Prep slides');
  });

  it('all_day=true drops times', async () => {
    const m = makeMockClient();
    m.createAppointment.mockImplementation(async (a: CoziAppointment) => ({ ...a, id: 'new_id' }));
    await createAppointmentHandler(
      asClient(m),
      'Holiday',
      '2026-07-04T00:00:00',
      '2026-07-04T00:00:00',
      undefined,
      true,
      '',
      undefined,
    );
    const sent = m.createAppointment.mock.calls[0]?.[0] as CoziAppointment;
    expect(sent.startDay).toBe('2026-07-04');
    expect(sent.startTime).toBeNull();
    expect(sent.endTime).toBeNull();
  });

  it('returns slim with id', async () => {
    const m = makeMockClient();
    m.createAppointment.mockImplementation(async (a: CoziAppointment) => ({ ...a, id: 'id_x' }));
    const result = await createAppointmentHandler(
      asClient(m),
      'X',
      '2026-05-15T10:00:00',
      '2026-05-15T11:00:00',
      undefined,
      false,
      '',
      undefined,
    );
    expect(result.id).toBe('id_x');
    expect(result.subject).toBe('X');
    expect(result.all_day).toBe(false);
    expect(result.start).toBe('2026-05-15T10:00');
    expect('description_short' in result).toBe(false);
    expect('descriptionShort' in result).toBe(false);
    expect('notes_html' in result).toBe(false);
  });

  // Issue #8: an `end` on a later day was parsed and then discarded, so a 4-day event
  // was silently created as a 1-day event with no error surfaced anywhere.
  it('multi-day event sends an inclusive dateSpan and reports the real end', async () => {
    const m = makeMockClient();
    m.createAppointment.mockImplementation(async (a: CoziAppointment) => ({ ...a, id: 'new_id' }));
    const result = await createAppointmentHandler(
      asClient(m),
      'Family trip',
      '2027-07-19T10:00:00',
      '2027-07-22T11:00:00',
      undefined,
      false,
      '',
      undefined,
    );
    const sent = m.createAppointment.mock.calls[0]?.[0] as CoziAppointment;
    expect(sent.startDay).toBe('2027-07-19');
    expect(sent.startTime).toEqual({ h: 10, m: 0 });
    expect(sent.endTime).toEqual({ h: 11, m: 0 });
    expect(sent.dateSpan).toBe(4);
    expect(result.day).toBe('2027-07-19');
    expect(result.end).toBe('2027-07-22T11:00');
    expect(result.end_day).toBe('2027-07-22');
  });

  it('same-day event sends dateSpan 1 and omits end_day', async () => {
    const m = makeMockClient();
    m.createAppointment.mockImplementation(async (a: CoziAppointment) => ({ ...a, id: 'new_id' }));
    const result = await createAppointmentHandler(
      asClient(m),
      'Meeting',
      '2026-05-15T10:00:00',
      '2026-05-15T11:00:00',
      undefined,
      false,
      '',
      undefined,
    );
    expect((m.createAppointment.mock.calls[0]?.[0] as CoziAppointment).dateSpan).toBe(1);
    expect('end_day' in result).toBe(false);
  });

  it('all_day across days keeps the span and drops times', async () => {
    const m = makeMockClient();
    m.createAppointment.mockImplementation(async (a: CoziAppointment) => ({ ...a, id: 'new_id' }));
    const result = await createAppointmentHandler(
      asClient(m),
      'Cruise',
      '2026-02-07T00:00:00',
      '2026-02-14T00:00:00',
      undefined,
      true,
      '',
      undefined,
    );
    const sent = m.createAppointment.mock.calls[0]?.[0] as CoziAppointment;
    expect(sent.startTime).toBeNull();
    expect(sent.endTime).toBeNull();
    expect(sent.dateSpan).toBe(8);
    expect(result.all_day).toBe(true);
    expect(result.end_day).toBe('2026-02-14');
  });

  it('end before start is rejected before any client call', async () => {
    const m = makeMockClient();
    await expect(
      createAppointmentHandler(
        asClient(m),
        'Backwards',
        '2027-07-22T10:00:00',
        '2027-07-19T11:00:00',
        undefined,
        false,
        '',
        undefined,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(m.createAppointment).not.toHaveBeenCalled();
  });

  it('end time before start time on the same day is rejected', async () => {
    const m = makeMockClient();
    await expect(
      createAppointmentHandler(
        asClient(m),
        'Backwards',
        '2027-07-19T11:00:00',
        '2027-07-19T10:00:00',
        undefined,
        false,
        '',
        undefined,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(m.createAppointment).not.toHaveBeenCalled();
  });

  it('end time before start time across days is allowed', async () => {
    const m = makeMockClient();
    m.createAppointment.mockImplementation(async (a: CoziAppointment) => ({ ...a, id: 'new_id' }));
    await createAppointmentHandler(
      asClient(m),
      'Dubai trip',
      '2027-02-07T17:00:00',
      '2027-02-15T15:00:00',
      undefined,
      false,
      '',
      undefined,
    );
    const sent = m.createAppointment.mock.calls[0]?.[0] as CoziAppointment;
    expect(sent.dateSpan).toBe(9);
  });
});

describe('delete_appointment', () => {
  it('passes year/month through', async () => {
    const m = makeMockClient();
    m.deleteAppointment.mockResolvedValue(true);
    const result = await deleteAppointmentHandler(asClient(m), 'appt_x', 2026, 5);
    expect(result).toBe(true);
    expect(m.deleteAppointment).toHaveBeenCalledOnce();
    expect(m.deleteAppointment).toHaveBeenCalledWith('appt_x', 2026, 5);
  });
});

describe('update_appointment fetch-then-merge (regression suite)', () => {
  it('notes only preserves attendees/location/subject/start/end', async () => {
    const m = makeMockClient();
    const existing = makeAppointment({
      id: 'appt_1',
      subject: 'Soccer practice',
      startDay: '2026-05-15',
      startTime: { h: 10, m: 0 },
      endTime: { h: 11, m: 0 },
      attendees: ['alice', 'bob'],
      location: 'Field B',
      notes: 'Bring water',
    });
    m.getCalendar.mockResolvedValue([existing]);
    m.updateAppointment.mockImplementation(async (a: CoziAppointment) => a);

    await updateAppointmentHandler(asClient(m), 'appt_1', 2026, 5, { notes: 'Bring water and snacks' });
    const sent = m.updateAppointment.mock.calls[0]?.[0] as CoziAppointment;
    expect(sent.attendees).toEqual(['alice', 'bob']);
    expect(sent.location).toBe('Field B');
    expect(sent.subject).toBe('Soccer practice');
    expect(sent.startDay).toBe('2026-05-15');
    expect(sent.startTime).toEqual({ h: 10, m: 0 });
    expect(sent.endTime).toEqual({ h: 11, m: 0 });
    expect(sent.notes).toBe('Bring water and snacks');
  });

  it('subject only preserves other fields', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([makeAppointment()]);
    m.updateAppointment.mockImplementation(async (a: CoziAppointment) => a);
    await updateAppointmentHandler(asClient(m), 'appt_1', 2026, 5, { subject: 'Renamed' });
    const sent = m.updateAppointment.mock.calls[0]?.[0] as CoziAppointment;
    expect(sent.subject).toBe('Renamed');
    expect(sent.attendees).toEqual(['alice', 'bob']);
    expect(sent.location).toBe('Field B');
    expect(sent.notes).toBe('Bring water');
  });

  it('attendees only preserves other fields', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([makeAppointment()]);
    m.updateAppointment.mockImplementation(async (a: CoziAppointment) => a);
    await updateAppointmentHandler(asClient(m), 'appt_1', 2026, 5, { attendees: ['charlie'] });
    const sent = m.updateAppointment.mock.calls[0]?.[0] as CoziAppointment;
    expect(sent.attendees).toEqual(['charlie']);
    expect(sent.location).toBe('Field B');
    expect(sent.notes).toBe('Bring water');
    expect(sent.subject).toBe('Soccer practice');
  });

  it('start only preserves end and other fields', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([makeAppointment()]);
    m.updateAppointment.mockImplementation(async (a: CoziAppointment) => a);
    await updateAppointmentHandler(asClient(m), 'appt_1', 2026, 5, { start: '2026-05-16T14:30:00' });
    const sent = m.updateAppointment.mock.calls[0]?.[0] as CoziAppointment;
    expect(sent.startDay).toBe('2026-05-16');
    expect(sent.startTime).toEqual({ h: 14, m: 30 });
    expect(sent.endTime).toEqual({ h: 11, m: 0 });
    expect(sent.attendees).toEqual(['alice', 'bob']);
    expect(sent.location).toBe('Field B');
    expect(sent.notes).toBe('Bring water');
  });

  it('cross-month move: GET old month, send new start_day', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([makeAppointment()]);
    m.updateAppointment.mockImplementation(async (a: CoziAppointment) => a);
    await updateAppointmentHandler(asClient(m), 'appt_1', 2026, 5, { start: '2026-06-15T10:00:00' });
    expect(m.getCalendar).toHaveBeenCalledOnce();
    expect(m.getCalendar).toHaveBeenCalledWith(2026, 5);
    const sent = m.updateAppointment.mock.calls[0]?.[0] as CoziAppointment;
    expect(sent.startDay).toBe('2026-06-15');
    expect(sent.startTime).toEqual({ h: 10, m: 0 });
  });

  it('to all-day clears times, preserves other fields', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([makeAppointment()]);
    m.updateAppointment.mockImplementation(async (a: CoziAppointment) => a);
    await updateAppointmentHandler(asClient(m), 'appt_1', 2026, 5, { allDay: true });
    const sent = m.updateAppointment.mock.calls[0]?.[0] as CoziAppointment;
    expect(sent.startTime).toBeNull();
    expect(sent.endTime).toBeNull();
    expect(sent.subject).toBe('Soccer practice');
    expect(sent.attendees).toEqual(['alice', 'bob']);
  });

  it('not found raises ResourceNotFoundError', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([]);
    await expect(
      updateAppointmentHandler(asClient(m), 'does_not_exist', 2026, 5, { notes: 'x' }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('returns slim, no noise', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([makeAppointment()]);
    m.updateAppointment.mockImplementation(async (a: CoziAppointment) => a);
    const result = await updateAppointmentHandler(asClient(m), 'appt_1', 2026, 5, { notes: 'updated' });
    expect('description_short' in result).toBe(false);
    expect('descriptionShort' in result).toBe(false);
    expect('notes_html' in result).toBe(false);
    expect(result.notes).toBe('updated');
    expect(result.subject).toBe('Soccer practice');
  });

  it('location and end-only branches both apply, others preserved', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([makeAppointment()]);
    m.updateAppointment.mockImplementation(async (a: CoziAppointment) => a);
    await updateAppointmentHandler(asClient(m), 'appt_1', 2026, 5, {
      location: 'New Field',
      end: '2026-05-15T12:30:00',
    });
    const sent = m.updateAppointment.mock.calls[0]?.[0] as CoziAppointment;
    expect(sent.location).toBe('New Field');
    expect(sent.endTime).toEqual({ h: 12, m: 30 });
    expect(sent.startTime).toEqual({ h: 10, m: 0 });
    expect(sent.subject).toBe('Soccer practice');
    expect(sent.attendees).toEqual(['alice', 'bob']);
    expect(sent.notes).toBe('Bring water');
  });

  it('end alone re-spans against the existing start day', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([makeAppointment()]);
    m.updateAppointment.mockImplementation(async (a: CoziAppointment) => a);
    const result = await updateAppointmentHandler(asClient(m), 'appt_1', 2026, 5, {
      end: '2026-05-18T12:30:00',
    });
    const sent = m.updateAppointment.mock.calls[0]?.[0] as CoziAppointment;
    expect(sent.startDay).toBe('2026-05-15');
    expect(sent.dateSpan).toBe(4);
    expect(result.end_day).toBe('2026-05-18');
  });

  it('start + end spans against the NEW start day', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([makeAppointment()]);
    m.updateAppointment.mockImplementation(async (a: CoziAppointment) => a);
    await updateAppointmentHandler(asClient(m), 'appt_1', 2026, 5, {
      start: '2026-06-01T09:00:00',
      end: '2026-06-03T17:00:00',
    });
    const sent = m.updateAppointment.mock.calls[0]?.[0] as CoziAppointment;
    expect(sent.startDay).toBe('2026-06-01');
    expect(sent.dateSpan).toBe(3);
  });

  it('end on the start day collapses a multi-day event back to one day', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([makeAppointment({ dateSpan: 4 })]);
    m.updateAppointment.mockImplementation(async (a: CoziAppointment) => a);
    const result = await updateAppointmentHandler(asClient(m), 'appt_1', 2026, 5, {
      end: '2026-05-15T11:00:00',
    });
    const sent = m.updateAppointment.mock.calls[0]?.[0] as CoziAppointment;
    expect(sent.dateSpan).toBe(1);
    expect('end_day' in result).toBe(false);
  });

  it('start only moves the event and keeps its span', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([makeAppointment({ dateSpan: 4 })]);
    m.updateAppointment.mockImplementation(async (a: CoziAppointment) => a);
    await updateAppointmentHandler(asClient(m), 'appt_1', 2026, 5, { start: '2026-05-20T10:00:00' });
    const sent = m.updateAppointment.mock.calls[0]?.[0] as CoziAppointment;
    expect(sent.startDay).toBe('2026-05-20');
    expect(sent.dateSpan).toBe(4);
  });

  it('switching to all-day preserves the span', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([makeAppointment({ dateSpan: 8 })]);
    m.updateAppointment.mockImplementation(async (a: CoziAppointment) => a);
    const result = await updateAppointmentHandler(asClient(m), 'appt_1', 2026, 5, { allDay: true });
    const sent = m.updateAppointment.mock.calls[0]?.[0] as CoziAppointment;
    expect(sent.startTime).toBeNull();
    expect(sent.dateSpan).toBe(8);
    expect(result.end_day).toBe('2026-05-22');
  });

  it('an end before the merged start day is rejected before the write', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([makeAppointment()]);
    await expect(
      updateAppointmentHandler(asClient(m), 'appt_1', 2026, 5, { end: '2026-05-14T12:00:00' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(m.updateAppointment).not.toHaveBeenCalled();
  });

  it('untouched edits leave the span alone', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([makeAppointment({ dateSpan: 4 })]);
    m.updateAppointment.mockImplementation(async (a: CoziAppointment) => a);
    await updateAppointmentHandler(asClient(m), 'appt_1', 2026, 5, { notes: 'x' });
    expect((m.updateAppointment.mock.calls[0]?.[0] as CoziAppointment).dateSpan).toBe(4);
  });
});

// Cozi refuses a create/edit whose start_time or end_time is null ("start_time and
// end_time are required"), so an all-day appointment must go out as 00:00/00:00 —
// which is exactly how Cozi stores one, and what the read path coerces back to null.
describe('all-day appointments on the wire', () => {
  it('null times are sent as 00:00, not null', () => {
    const create = toApiCreateFormat(makeAppointment({ startTime: null, endTime: null })) as {
      create: { details: Record<string, unknown> };
    };
    expect(create.create.details.startTime).toBe('00:00');
    expect(create.create.details.endTime).toBe('00:00');

    const edit = toApiEditFormat(makeAppointment({ startTime: null, endTime: null })) as {
      edit: { details: Record<string, unknown> };
    };
    expect(edit.edit.details.startTime).toBe('00:00');
    expect(edit.edit.details.endTime).toBe('00:00');
  });

  it('timed appointments are unaffected', () => {
    const create = toApiCreateFormat(makeAppointment()) as {
      create: { details: Record<string, unknown> };
    };
    expect(create.create.details.startTime).toBe('10:00');
    expect(create.create.details.endTime).toBe('11:00');
  });

  it('dateSpan is normalised to at least 1 on both payloads', () => {
    const create = toApiCreateFormat(makeAppointment({ dateSpan: 0 })) as {
      create: { details: Record<string, unknown> };
    };
    expect(create.create.details.dateSpan).toBe(1);
    const edit = toApiEditFormat(makeAppointment({ dateSpan: 4 })) as {
      edit: { details: Record<string, unknown> };
    };
    expect(edit.edit.details.dateSpan).toBe(4);
  });
});
