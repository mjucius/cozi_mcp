import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../src/cozi/http.js';
import { slimSearchHit } from '../src/tools/projections.js';
import {
  CoziClient,
  ResourceNotFoundError,
  ValidationError,
  WriteVerificationError,
  toApiCreateFormat,
  toApiDeleteFormat,
  toApiEditFormat,
  type CoziAppointment,
} from '../src/cozi/index.js';
import {
  createAppointmentHandler,
  deleteAppointmentHandler,
  getCalendarHandler,
  repeatRule,
  updateAppointmentHandler,
  type RepeatInput,
} from '../src/tools/calendar.js';
import { makeAppointment, makePerson } from './helpers/factories.js';
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
  it('multi-day event sends dateSpan as the day offset and reports the real end', async () => {
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
    expect(sent.dateSpan).toBe(3);
    expect(result.day).toBe('2027-07-19');
    expect(result.end).toBe('2027-07-22T11:00');
    expect(result.end_day).toBe('2027-07-22');
  });

  // Issue #12: 2.2.0 sent 1 here, which Cozi reads as "ends the next day".
  it('same-day timed event sends dateSpan 0 and omits end_day', async () => {
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
    expect((m.createAppointment.mock.calls[0]?.[0] as CoziAppointment).dateSpan).toBe(0);
    expect('end_day' in result).toBe(false);
  });

  it('timed overnight event sends dateSpan 1 and reports the next-day end', async () => {
    const m = makeMockClient();
    m.createAppointment.mockImplementation(async (a: CoziAppointment) => ({ ...a, id: 'new_id' }));
    const result = await createAppointmentHandler(
      asClient(m),
      'Late show',
      '2026-05-15T20:00:00',
      '2026-05-16T02:00:00',
      undefined,
      false,
      '',
      undefined,
    );
    expect((m.createAppointment.mock.calls[0]?.[0] as CoziAppointment).dateSpan).toBe(1);
    expect(result.end).toBe('2026-05-16T02:00');
    expect(result.end_day).toBe('2026-05-16');
  });

  // An all-day event's dateSpan counts covered days (its end instant is the
  // following midnight), so a single all-day event is 1 — never 0.
  it('single all-day event sends dateSpan 1', async () => {
    const m = makeMockClient();
    m.createAppointment.mockImplementation(async (a: CoziAppointment) => ({ ...a, id: 'new_id' }));
    const result = await createAppointmentHandler(
      asClient(m), 'Holiday', '2026-05-15', '2026-05-15', undefined, true, '', undefined,
    );
    expect((m.createAppointment.mock.calls[0]?.[0] as CoziAppointment).dateSpan).toBe(1);
    expect(result.all_day).toBe(true);
    expect('end_day' in result).toBe(false);
  });

  it('all_day across days keeps the span and drops times', async () => {
    const m = makeMockClient();
    m.createAppointment.mockImplementation(async (a: CoziAppointment) => ({ ...a, id: 'new_id' }));
    const result = await createAppointmentHandler(
      asClient(m),
      'Family trip',
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

  it('a bare date is accepted for all-day events', async () => {
    const m = makeMockClient();
    m.createAppointment.mockImplementation(async (a: CoziAppointment) => ({ ...a, id: 'new_id' }));
    const result = await createAppointmentHandler(
      asClient(m),
      'Family trip',
      '2026-02-07',
      '2026-02-14',
      undefined,
      true,
      '',
      undefined,
    );
    const sent = m.createAppointment.mock.calls[0]?.[0] as CoziAppointment;
    expect(sent.startDay).toBe('2026-02-07');
    expect(sent.startTime).toBeNull();
    expect(sent.endTime).toBeNull();
    expect(sent.dateSpan).toBe(8);
    expect(result.all_day).toBe(true);
    expect(result.end_day).toBe('2026-02-14');
  });

  it('a bare date on a timed event is rejected before any client call', async () => {
    const m = makeMockClient();
    await expect(
      createAppointmentHandler(
        asClient(m),
        'Untimed',
        '2026-02-07',
        '2026-02-07T11:00:00',
        undefined,
        false,
        '',
        undefined,
      ),
    ).rejects.toThrow(/`start` '2026-02-07' has no time; pass all_day=true/);
    await expect(
      createAppointmentHandler(
        asClient(m),
        'Untimed',
        '2026-02-07T10:00:00',
        '2026-02-07',
        undefined,
        false,
        '',
        undefined,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(m.createAppointment).not.toHaveBeenCalled();
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
      'Long trip',
      '2027-02-07T17:00:00',
      '2027-02-15T15:00:00',
      undefined,
      false,
      '',
      undefined,
    );
    const sent = m.createAppointment.mock.calls[0]?.[0] as CoziAppointment;
    expect(sent.dateSpan).toBe(8);
  });
});

describe('delete_appointment', () => {
  const series = (days: string[] = ['2026-05-01', '2026-05-08', '2026-05-15']): CoziAppointment =>
    makeAppointment({
      id: 'series_1',
      subject: 'Weekly standup',
      startDay: '2026-05-01',
      recurrence: { text: ['Every week on Friday'], endDay: '2026-12-31' },
      endDay: '2026-12-31',
      occurrenceDays: days,
    });

  it('looks the id up on the page, then passes year/month through', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([makeAppointment({ id: 'appt_x' })]);
    m.deleteAppointment.mockResolvedValue(true);
    const result = await deleteAppointmentHandler(asClient(m), 'appt_x', 2026, 5);
    expect(result).toBe(true);
    expect(m.getCalendar).toHaveBeenCalledWith(2026, 5);
    expect(m.deleteAppointment).toHaveBeenCalledOnce();
    expect(m.deleteAppointment).toHaveBeenCalledWith('appt_x', 2026, 5, undefined, undefined);
  });

  // Cozi itself treats an unknown id as a silent success; the page lookup is what
  // turns that into a real answer for the caller.
  it('an id that is not on the page is a ResourceNotFoundError and nothing is sent', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([makeAppointment({ id: 'appt_x' })]);
    await expect(deleteAppointmentHandler(asClient(m), 'missing', 2026, 5)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
    expect(m.deleteAppointment).not.toHaveBeenCalled();
  });

  it('a recurring series without a scope is refused and nothing is sent', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([series()]);
    const err = await deleteAppointmentHandler(asClient(m), 'series_1', 2026, 5).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toContain('recurring series');
    expect((err as Error).message).toContain("scope 'series'");
    // Household-written content must not leak into an unfenced error message.
    expect((err as Error).message).not.toContain('Weekly standup');
    expect((err as Error).message).not.toContain('Every week');
    expect(m.deleteAppointment).not.toHaveBeenCalled();
  });

  it("scope 'series' deletes the whole series", async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([series()]);
    m.deleteAppointment.mockResolvedValue(true);
    expect(await deleteAppointmentHandler(asClient(m), 'series_1', 2026, 5, { scope: 'series' })).toBe(true);
    expect(m.deleteAppointment).toHaveBeenCalledWith('series_1', 2026, 5, undefined, undefined);
  });

  it("scope 'this' deletes one listed occurrence and checks it is gone", async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValueOnce([series()]).mockResolvedValueOnce([series(['2026-05-01', '2026-05-15'])]);
    m.deleteAppointment.mockResolvedValue(true);
    const ok = await deleteAppointmentHandler(asClient(m), 'series_1', 2026, 5, {
      scope: 'this',
      occurrenceDay: '2026-05-08',
    });
    expect(ok).toBe(true);
    expect(m.deleteAppointment).toHaveBeenCalledWith('series_1', 2026, 5, { day: '2026-05-08', extent: 'day' }, undefined);
  });

  it('an occurrence still listed after the delete is a WriteVerificationError', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([series()]);
    m.deleteAppointment.mockResolvedValue(true);
    await expect(
      deleteAppointmentHandler(asClient(m), 'series_1', 2026, 5, { scope: 'this', occurrenceDay: '2026-05-08' }),
    ).rejects.toBeInstanceOf(WriteVerificationError);
  });

  it('a day that is not a listed occurrence is refused and nothing is sent', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([series()]);
    await expect(
      deleteAppointmentHandler(asClient(m), 'series_1', 2026, 5, { scope: 'this', occurrenceDay: '2026-05-09' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(m.deleteAppointment).not.toHaveBeenCalled();
  });

  it("'this_and_following' sends extent forward and checks the series now ends before the day", async () => {
    const m = makeMockClient();
    const shortened = { ...series(['2026-05-01']), endDay: '2026-05-07' };
    m.getCalendar.mockResolvedValueOnce([series()]).mockResolvedValueOnce([shortened]);
    m.deleteAppointment.mockResolvedValue(true);
    await deleteAppointmentHandler(asClient(m), 'series_1', 2026, 5, {
      scope: 'this_and_following',
      occurrenceDay: '2026-05-08',
    });
    expect(m.deleteAppointment).toHaveBeenCalledWith('series_1', 2026, 5, { day: '2026-05-08', extent: 'forward' }, undefined);
  });

  it("'this_and_following' from the first occurrence is the whole series", async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([series()]);
    m.deleteAppointment.mockResolvedValue(true);
    await deleteAppointmentHandler(asClient(m), 'series_1', 2026, 5, {
      scope: 'this_and_following',
      occurrenceDay: '2026-05-01',
    });
    expect(m.deleteAppointment).toHaveBeenCalledWith('series_1', 2026, 5, undefined, undefined);
  });

  // A multi-day series: get_calendar lists each occurrence on its first day (Cozi's
  // day map names it for every covered day), and only that day names the occurrence.
  const trip = (days: string[]): CoziAppointment =>
    makeAppointment({
      id: 'trip_1',
      subject: 'Cabin weekend',
      startDay: '2026-05-05',
      startTime: { h: 18, m: 0 },
      endTime: { h: 12, m: 0 },
      dateSpan: 1,
      recurrence: { text: ['Every week on Tuesday'] },
      occurrenceDays: days,
    });

  it('a multi-day occurrence is named by its first day; a day inside it is refused and nothing is sent', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValueOnce([trip(['2026-05-05', '2026-05-12'])]);
    await expect(
      deleteAppointmentHandler(asClient(m), 'trip_1', 2026, 5, { scope: 'this', occurrenceDay: '2026-05-13' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(m.deleteAppointment).not.toHaveBeenCalled();

    m.getCalendar.mockResolvedValueOnce([trip(['2026-05-05', '2026-05-12'])]).mockResolvedValueOnce([trip(['2026-05-05'])]);
    m.deleteAppointment.mockResolvedValue(true);
    expect(
      await deleteAppointmentHandler(asClient(m), 'trip_1', 2026, 5, { scope: 'this', occurrenceDay: '2026-05-12' }),
    ).toBe(true);
    expect(m.deleteAppointment).toHaveBeenCalledWith('trip_1', 2026, 5, { day: '2026-05-12', extent: 'day' }, undefined);
  });

  it('a series Cozi dropped from the page after the delete counts as applied', async () => {
    // Its only occurrence that month is gone, so Cozi no longer lists it there.
    const m = makeMockClient();
    m.getCalendar.mockResolvedValueOnce([trip(['2026-05-12'])]).mockResolvedValueOnce([]);
    m.deleteAppointment.mockResolvedValue(true);
    expect(
      await deleteAppointmentHandler(asClient(m), 'trip_1', 2026, 5, { scope: 'this', occurrenceDay: '2026-05-12' }),
    ).toBe(true);
  });

  it('refuses holidays, subscribed calendars, birthdays and a scope on a one-off', async () => {
    const cases: Array<[CoziAppointment, Parameters<typeof deleteAppointmentHandler>[4]]> = [
      [makeAppointment({ id: 'x', readOnly: true }), {}],
      [makeAppointment({ id: 'x', itemType: 'birthday' }), {}],
      [makeAppointment({ id: 'x' }), { scope: 'this', occurrenceDay: '2026-05-15' }],
    ];
    for (const [appt, opts] of cases) {
      const m = makeMockClient();
      m.getCalendar.mockResolvedValue([appt]);
      await expect(deleteAppointmentHandler(asClient(m), 'x', 2026, 5, opts)).rejects.toBeInstanceOf(ValidationError);
      expect(m.deleteAppointment).not.toHaveBeenCalled();
    }
  });
});

describe('notify', () => {
  const people = [
    makePerson({ id: 'p_on' }),
    { ...makePerson({ id: 'p_off' }), notifiableFeatures: ['calendarItemReminder'] },
    { ...makePerson({ id: 'p_on2' }), notifiableFeatures: ['calendarItemNotification'] },
  ].map((p, i) => (i === 0 ? { ...p, notifiable: true } : p));

  it('notifies only the attendees who have Cozi notifications on', async () => {
    const m = makeMockClient();
    m.getFamilyMembers.mockResolvedValue(people);
    m.createAppointment.mockImplementation(async (a: CoziAppointment) => ({ ...a, id: 'n' }));
    await createAppointmentHandler(
      asClient(m), 'S', '2026-05-15T10:00:00', '2026-05-15T11:00:00', ['p_on', 'p_off', 'p_on2'], false, '', undefined,
      { notify: true },
    );
    expect(m.createAppointment.mock.calls[0]?.[1]).toEqual(['p_on', 'p_on2']);
  });

  it('refuses when nobody would be notified, before writing', async () => {
    const m = makeMockClient();
    m.getFamilyMembers.mockResolvedValue(people);
    await expect(
      createAppointmentHandler(asClient(m), 'S', '2026-05-15T10:00:00', '2026-05-15T11:00:00', ['p_off'], false, '', undefined, { notify: true }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(m.createAppointment).not.toHaveBeenCalled();
  });

  it('a delete with no attendees notifies the reachable family; without notify nobody', async () => {
    const m = makeMockClient();
    m.getFamilyMembers.mockResolvedValue(people);
    m.getCalendar.mockResolvedValue([makeAppointment({ id: 'x', attendees: [] })]);
    m.deleteAppointment.mockResolvedValue(true);
    await deleteAppointmentHandler(asClient(m), 'x', 2026, 5, { notify: true });
    expect(m.deleteAppointment).toHaveBeenLastCalledWith('x', 2026, 5, undefined, ['p_on', 'p_on2']);
    await deleteAppointmentHandler(asClient(m), 'x', 2026, 5);
    expect(m.deleteAppointment).toHaveBeenLastCalledWith('x', 2026, 5, undefined, undefined);
    expect(toApiDeleteFormat('x', undefined, ['p_on'])).toEqual({ itemType: 'appointment', notifyPersons: ['p_on'], delete: { id: 'x' } });
  });
});

describe('update_appointment on a recurring series', () => {
  const series = (): CoziAppointment =>
    makeAppointment({
      id: 'series_1',
      startDay: '2026-05-01',
      recurrence: { rules: [{ frequency: 'Weekly', interval: 1, byDay: ['FR'], end: {} }] },
      occurrenceDays: ['2026-05-01', '2026-05-08'],
    });

  it('needs a scope', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([series()]);
    await expect(updateAppointmentHandler(asClient(m), 'series_1', 2026, 5, { notes: 'x' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(m.updateAppointment).not.toHaveBeenCalled();
  });

  it("scope 'this' edits from the occurrence's own day and sends the occurrence", async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([series()]);
    m.updateAppointment.mockImplementation(async (a: CoziAppointment) => ({ ...a, id: 'standin', recurrence: null }));
    const out = await updateAppointmentHandler(asClient(m), 'series_1', 2026, 5, {
      scope: 'this',
      occurrenceDay: '2026-05-08',
      start: '2026-05-09T10:00:00',
    });
    const [sent, opts] = m.updateAppointment.mock.calls[0] as [CoziAppointment, { occurrence?: unknown }];
    expect(sent.startDay).toBe('2026-05-09');
    expect(opts.occurrence).toEqual({ day: '2026-05-08', extent: 'day' });
    expect(out.id).toBe('standin');
  });

  it("on a multi-day series, scope 'this' starts the copy on the occurrence's first day", async () => {
    const trip = makeAppointment({
      id: 'trip_1',
      startDay: '2026-05-05',
      startTime: { h: 18, m: 0 },
      endTime: { h: 12, m: 0 },
      dateSpan: 1,
      recurrence: { rules: [{ frequency: 'Weekly', interval: 1, byDay: ['TU'], end: {} }] },
      occurrenceDays: ['2026-05-05', '2026-05-12'],
    });
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([trip]);
    m.updateAppointment.mockImplementation(async (a: CoziAppointment) => ({ ...a, id: 'standin', recurrence: null }));
    const out = await updateAppointmentHandler(asClient(m), 'trip_1', 2026, 5, {
      scope: 'this',
      occurrenceDay: '2026-05-12',
      notes: 'x',
    });
    const [sent, opts] = m.updateAppointment.mock.calls[0] as [CoziAppointment, { occurrence?: unknown }];
    expect([sent.startDay, sent.dateSpan]).toEqual(['2026-05-12', 1]);
    expect(opts.occurrence).toEqual({ day: '2026-05-12', extent: 'day' });
    expect([out.day, out.end_day]).toEqual(['2026-05-12', '2026-05-13']);
  });

  it('refuses `repeat` on a single occurrence', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([series()]);
    await expect(
      updateAppointmentHandler(asClient(m), 'series_1', 2026, 5, {
        scope: 'this',
        occurrenceDay: '2026-05-08',
        repeat: { frequency: 'daily' },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('passes reminders through only when given, and `repeat` turns a one-off into a series', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([makeAppointment({ id: 'a', startDay: '2026-05-15' })]);
    m.updateAppointment.mockImplementation(async (a: CoziAppointment) => a);
    await updateAppointmentHandler(asClient(m), 'a', 2026, 5, { notes: 'x' });
    expect(m.updateAppointment.mock.calls[0]?.[1]).toEqual({});
    await updateAppointmentHandler(asClient(m), 'a', 2026, 5, { reminders: [], repeat: { frequency: 'monthly' } });
    const [sent, opts] = m.updateAppointment.mock.calls[1] as [CoziAppointment, { reminders?: number[] }];
    expect(opts.reminders).toEqual([]);
    expect(sent.recurrence).toEqual({ rules: [{ frequency: 'Monthly', interval: 1, byMonthDay: [15], end: {} }] });
  });

  it('refuses read-only items and birthdays', async () => {
    for (const appt of [makeAppointment({ id: 'x', readOnly: true }), makeAppointment({ id: 'x', itemType: 'birthday' })]) {
      const m = makeMockClient();
      m.getCalendar.mockResolvedValue([appt]);
      await expect(updateAppointmentHandler(asClient(m), 'x', 2026, 5, { notes: 'n' })).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(m.updateAppointment).not.toHaveBeenCalled();
    }
  });
});

describe('repeatRule', () => {
  const rule = (r: RepeatInput, start = '2019-01-29') => (repeatRule(r, start).rules as unknown[])[0];

  it('builds the Cozi web client rule shapes', () => {
    expect(rule({ frequency: 'daily', interval: 2 })).toEqual({ frequency: 'Daily', interval: 2, end: {} });
    expect(rule({ frequency: 'weekly' })).toEqual({ frequency: 'Weekly', interval: 1, byDay: ['TU'], end: {} });
    expect(rule({ frequency: 'weekly', weekdays: ['TH', 'TU'], until: '2019-03-01' })).toEqual({
      frequency: 'Weekly', interval: 1, byDay: ['TU', 'TH'], end: { untilDay: '2019-03-01' },
    });
    expect(rule({ frequency: 'monthly' })).toEqual({ frequency: 'Monthly', interval: 1, byMonthDay: [29], end: {} });
    // 2019-01-29 is the 5th Tuesday, which Cozi spells as the last one.
    expect(rule({ frequency: 'monthly', monthly_by: 'weekday' })).toEqual({
      frequency: 'Monthly', interval: 1, byDay: ['-1TU'], end: {},
    });
    expect(rule({ frequency: 'monthly', monthly_by: 'weekday' }, '2019-01-08')).toMatchObject({ byDay: ['2TU'] });
    expect(rule({ frequency: 'yearly' })).toEqual({
      frequency: 'Yearly', interval: 1, byMonth: [1], byMonthDay: [29], end: {},
    });
  });

  it('rejects rules that do not fit the start day', () => {
    expect(() => rule({ frequency: 'weekly', weekdays: ['MO'] })).toThrow(ValidationError);
    expect(() => rule({ frequency: 'daily', weekdays: ['TU'] })).toThrow(ValidationError);
    expect(() => rule({ frequency: 'weekly', monthly_by: 'weekday' })).toThrow(ValidationError);
    expect(() => rule({ frequency: 'daily', until: '2019-01-01' })).toThrow(ValidationError);
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
    expect(sent.dateSpan).toBe(3);
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
    expect(sent.dateSpan).toBe(2);
  });

  it('end on the start day collapses a multi-day event back to one day', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([makeAppointment({ dateSpan: 4 })]);
    m.updateAppointment.mockImplementation(async (a: CoziAppointment) => a);
    const result = await updateAppointmentHandler(asClient(m), 'appt_1', 2026, 5, {
      end: '2026-05-15T11:00:00',
    });
    const sent = m.updateAppointment.mock.calls[0]?.[0] as CoziAppointment;
    expect(sent.dateSpan).toBe(0);
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

  // A timed May 15 -> May 23 event (dateSpan 8) made all-day still ends on May 23,
  // which as an all-day span is 9 covered days.
  it('switching a timed event to all-day keeps its last day', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([makeAppointment({ dateSpan: 8 })]);
    m.updateAppointment.mockImplementation(async (a: CoziAppointment) => a);
    const result = await updateAppointmentHandler(asClient(m), 'appt_1', 2026, 5, { allDay: true });
    const sent = m.updateAppointment.mock.calls[0]?.[0] as CoziAppointment;
    expect(sent.startTime).toBeNull();
    expect(sent.dateSpan).toBe(9);
    expect(result.all_day).toBe(true);
    expect(result.end_day).toBe('2026-05-23');
  });

  it('all_day=true on an event that is already all-day leaves the span alone', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([makeAppointment({ startTime: null, endTime: null, dateSpan: 4 })]);
    m.updateAppointment.mockImplementation(async (a: CoziAppointment) => a);
    await updateAppointmentHandler(asClient(m), 'appt_1', 2026, 5, { allDay: true, notes: 'x' });
    expect((m.updateAppointment.mock.calls[0]?.[0] as CoziAppointment).dateSpan).toBe(4);
  });

  it('switching an all-day event to timed via start+end keeps its last day', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([makeAppointment({ startTime: null, endTime: null, dateSpan: 4 })]);
    m.updateAppointment.mockImplementation(async (a: CoziAppointment) => a);
    const result = await updateAppointmentHandler(asClient(m), 'appt_1', 2026, 5, {
      start: '2026-05-15T10:00:00',
      end: '2026-05-18T11:00:00',
      allDay: false,
    });
    const sent = m.updateAppointment.mock.calls[0]?.[0] as CoziAppointment;
    expect(sent.startTime).toEqual({ h: 10, m: 0 });
    expect(sent.dateSpan).toBe(3);
    expect(result.all_day).toBe(false);
    expect(result.end_day).toBe('2026-05-18');
  });

  it('an end before the merged start day is rejected before the write', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([makeAppointment()]);
    await expect(
      updateAppointmentHandler(asClient(m), 'appt_1', 2026, 5, { end: '2026-05-14T12:00:00' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(m.updateAppointment).not.toHaveBeenCalled();
  });

  it('a bare-date end on an existing all-day event re-spans and stays all-day', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([makeAppointment({ startTime: null, endTime: null })]);
    m.updateAppointment.mockImplementation(async (a: CoziAppointment) => a);
    const result = await updateAppointmentHandler(asClient(m), 'appt_1', 2026, 5, { end: '2026-05-18' });
    const sent = m.updateAppointment.mock.calls[0]?.[0] as CoziAppointment;
    expect(sent.startTime).toBeNull();
    expect(sent.endTime).toBeNull();
    expect(sent.dateSpan).toBe(4);
    expect(result.all_day).toBe(true);
    expect(result.end_day).toBe('2026-05-18');
  });

  it('a bare-date start on a timed event without all_day is rejected before the write', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([makeAppointment()]);
    await expect(
      updateAppointmentHandler(asClient(m), 'appt_1', 2026, 5, { start: '2026-05-16' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      updateAppointmentHandler(asClient(m), 'appt_1', 2026, 5, { end: '2026-05-16', allDay: false }),
    ).rejects.toThrow(/`end` '2026-05-16' has no time/);
    expect(m.updateAppointment).not.toHaveBeenCalled();
  });

  it('bare dates with all_day=true convert a timed event and set the span', async () => {
    const m = makeMockClient();
    m.getCalendar.mockResolvedValue([makeAppointment()]);
    m.updateAppointment.mockImplementation(async (a: CoziAppointment) => a);
    const result = await updateAppointmentHandler(asClient(m), 'appt_1', 2026, 5, {
      start: '2026-06-01',
      end: '2026-06-03',
      allDay: true,
    });
    const sent = m.updateAppointment.mock.calls[0]?.[0] as CoziAppointment;
    expect(sent.startDay).toBe('2026-06-01');
    expect(sent.startTime).toBeNull();
    expect(sent.endTime).toBeNull();
    expect(sent.dateSpan).toBe(3);
    expect(result.all_day).toBe(true);
    expect(result.end_day).toBe('2026-06-03');
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

  // Issue #12: clamping dateSpan to >= 1 turned every same-day timed event into two days.
  it('dateSpan is sent verbatim on both payloads, including 0', () => {
    const create = toApiCreateFormat(makeAppointment({ dateSpan: 0 })) as {
      create: { details: Record<string, unknown> };
    };
    expect(create.create.details.dateSpan).toBe(0);
    const edit = toApiEditFormat(makeAppointment({ dateSpan: 4 })) as {
      edit: { details: Record<string, unknown> };
    };
    expect(edit.edit.details.dateSpan).toBe(4);
  });
});

describe('appointment payloads: occurrences and reminders', () => {
  it('puts selectedDay/extent beside the operation and reminders at the edit level', () => {
    const a = makeAppointment({ id: 'series_1', startDay: '2026-05-09' });
    const edit = toApiEditFormat(a, { occurrence: { day: '2026-05-08', extent: 'day' }, reminders: [30] });
    expect(edit).toMatchObject({ itemType: 'appointment', selectedDay: '2026-05-08', extent: 'day' });
    expect((edit.edit as Record<string, unknown>).reminders).toEqual([{ minutesBefore: 30 }]);
    expect('reminders' in (toApiEditFormat(a).edit as Record<string, unknown>)).toBe(false);
    expect(toApiDeleteFormat('series_1', { day: '2026-05-08', extent: 'forward' })).toEqual({
      itemType: 'appointment', selectedDay: '2026-05-08', extent: 'forward', delete: { id: 'series_1' },
    });
  });

  it('sends recurrence and reminders on create only when set', () => {
    const plain = toApiCreateFormat(makeAppointment()).create as Record<string, unknown>;
    expect('recurrence' in plain || 'reminders' in plain).toBe(false);
    const rec = { rules: [{ frequency: 'Daily', interval: 1, end: {} }] };
    const full = toApiCreateFormat(makeAppointment({ recurrence: rec, reminders: [15] })).create as Record<string, unknown>;
    expect(full.recurrence).toEqual(rec);
    expect(full.reminders).toEqual([{ minutesBefore: 15 }]);
  });
});

describe('search_calendar', () => {
  it('unwraps {highlight, item} hits and reads matching days from the days map', async () => {
    const hit = (id: string, description: string, day: string, extra: Record<string, unknown> = {}) => ({
      highlight: { description: 'x' },
      item: { id, description, day, startTime: '10:00:00', endTime: '11:00:00', itemType: 'appointment', itemDetails: { id, ...extra } },
    });
    vi.spyOn(HttpClient.prototype, 'request').mockImplementation(async (opts) => {
      const o = opts as { endpoint: string; params?: Record<string, string> };
      if (o.endpoint.includes('/auth/login')) return { accessToken: 't', accountId: 'acct_1' } as never;
      expect(o.endpoint).toBe('/api/ext/2004/acct_1/search/calendar/');
      expect(o.params).toEqual({ q: 'piano' });
      return {
        hasNext: true,
        items: {
          one: hit('one', 'Piano recital', '2026-06-01'),
          rec: hit('rec', 'Piano lesson', '2025-01-06', { recurrence: { rules: [{ frequency: 'Weekly' }] } }),
        },
        days: { '2026-06-01': [{ id: 'one' }], '2026-10-05': [{ id: 'rec' }], '2026-10-19': [{ id: 'rec' }], '2026-10-12': [{ id: 'rec' }] },
      } as never;
    });
    const { appointments, more } = await new CoziClient('u', 'p').searchCalendar('piano');
    expect(more).toBe(true);
    expect(appointments.map((a) => [a.id, a.subject, a.occurrenceDays])).toEqual([
      ['one', 'Piano recital', ['2026-06-01']],
      ['rec', 'Piano lesson', ['2026-10-05', '2026-10-12', '2026-10-19']],
    ]);
    vi.restoreAllMocks();
  });

  it("trims search's '-a' id suffix back to the calendar's uuid, and nothing else", async () => {
    const uuid = '0f8b2c1e-4a5d-4e6f-9a7b-1c2d3e4f5a6b';
    vi.spyOn(HttpClient.prototype, 'request').mockImplementation(async (opts) => {
      if ((opts as { endpoint: string }).endpoint.includes('/auth/login')) return { accessToken: 't', accountId: 'a' } as never;
      return {
        items: {
          [`${uuid}-a`]: { item: { id: `${uuid}-a`, description: 'x', day: '2026-01-01', itemDetails: {} } },
          'holiday-7-a': { item: { id: 'holiday-7-a', description: 'y', day: '2026-01-02', itemDetails: {} } },
        },
        days: { '2026-01-01': [{ id: `${uuid}-a` }] },
      } as never;
    });
    const { appointments } = await new CoziClient('u', 'p').searchCalendar('x');
    expect(appointments.map((a) => [a.id, a.occurrenceDays])).toEqual([[uuid, ['2026-01-01']], ['holiday-7-a', []]]);
    vi.restoreAllMocks();
  });

  it('reports a series by its latest past and next occurrences', () => {
    const a = makeAppointment({
      recurrence: { rules: [{ frequency: 'Weekly' }] },
      occurrenceDays: ['2026-10-05', '2026-10-12', '2026-10-19'],
    });
    expect(slimSearchHit(a, '2026-10-13')).toMatchObject({ last_day: '2026-10-12', next_days: ['2026-10-19'] });
    const once = slimSearchHit(makeAppointment({ occurrenceDays: ['2026-05-15'] }), '2026-10-13');
    expect('last_day' in once || 'next_days' in once).toBe(false);
  });
});
