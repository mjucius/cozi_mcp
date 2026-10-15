// Live conformance: calendar create / update / delete against the REAL Cozi API.
// See harness.ts for why this exists and how span semantics are observed.
//
// Expected `dateSpan` values follow Cozi's rule — end instant = day + dateSpan at
// endTime; an all-day event is 00:00→00:00 so its end instant is the midnight after
// its last covered day — and are cross-checked with the month pages Cozi lists the
// appointment on, which is Cozi's own reading of the span.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ResourceNotFoundError, ValidationError } from '../../src/cozi/index.js';
import {
  createAppointmentHandler,
  deleteAppointmentHandler,
  getCalendarHandler,
  searchCalendarHandler,
  updateAppointmentHandler,
} from '../../src/tools/calendar.js';
import type { SlimAppointment } from '../../src/tools/projections.js';
import type { RepeatInput } from '../../src/tools/calendar.js';
import { Live, SANDBOX, SEARCH_SANDBOX, haveCreds, stable, subj, type RawCalendarItem } from './harness.js';

const { year: Y, jan: JAN, feb: FEB, mar: MAR } = SANDBOX;
const d = (month: number, day: number) => `${Y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

describe.skipIf(!haveCreds)('live calendar conformance', () => {
  const live = haveCreds ? new Live() : (null as unknown as Live);
  let memberId: string;

  beforeAll(async () => {
    await live.authenticate();
    const swept = await live.sweep();
    if (swept) process.stderr.write(`live: swept ${swept} leftover(s) from a previous run\n`);
    const members = await live.client.getFamilyMembers();
    memberId = members[0]?.id ?? '';
    expect(memberId).not.toBe('');
  });

  afterAll(async () => {
    await live.teardown();
  });

  // ---- helpers -----------------------------------------------------------------

  interface Expected {
    day: string;
    startTime: string;
    endTime: string;
    dateSpan: number;
    months: number[];
  }

  /** Exact raw read-back plus Cozi's own reading of the span (month pages). */
  async function expectStored(subject: string, exp: Expected): Promise<RawCalendarItem> {
    const raw = await live.findRaw(Y, exp.months[0]!, subject);
    expect(raw, `${subject} not found on ${Y}-${exp.months[0]}`).toBeDefined();
    expect(raw!.day).toBe(exp.day);
    expect(raw!.startTime).toBe(exp.startTime);
    expect(raw!.endTime).toBe(exp.endTime);
    // Cozi omits the field for a same-day event; absent and 0 are the same value.
    expect(raw!.dateSpan ?? 0).toBe(exp.dateSpan);
    expect(await live.monthsListing(raw!.id!)).toEqual(exp.months);
    return raw!;
  }

  /** The tool's result must be what Cozi stored, not an echo of the request. */
  async function expectSelfConsistent(result: SlimAppointment, month: number): Promise<void> {
    const fresh = (await getCalendarHandler(live.client, Y, month)).find((a) => a.id === result.id);
    expect(fresh, `appointment ${result.id} not on ${Y}-${month}`).toBeDefined();
    expect(result).toEqual(fresh);
  }

  async function create(
    label: string,
    start: string,
    end: string,
    opts: { allDay?: boolean; attendees?: string[]; notes?: string; location?: string } = {},
  ): Promise<SlimAppointment> {
    const s = subj(label);
    const result = await createAppointmentHandler(
      live.client, s, start, end, opts.attendees, opts.allDay ?? false, opts.notes ?? '', opts.location,
    );
    live.track(result.id, Y, Number(start.slice(5, 7)));
    return result;
  }

  // ---- create ------------------------------------------------------------------

  describe('create', () => {
    it('timed same-day: dateSpan 0, listed only on its own month', async () => {
      const r = await create('timed same-day', `${d(JAN, 31)}T09:00:00`, `${d(JAN, 31)}T17:00:00`);
      await expectStored(r.subject, {
        day: d(JAN, 31), startTime: '09:00:00', endTime: '17:00:00', dateSpan: 0, months: [JAN],
      });
      expect(r.end).toBe(`${d(JAN, 31)}T17:00`);
      expect('end_day' in r).toBe(false);
      await expectSelfConsistent(r, JAN);
    });

    it('timed overnight: dateSpan 1, listed on both months', async () => {
      const r = await create('timed overnight', `${d(JAN, 31)}T20:00:00`, `${d(FEB, 1)}T02:00:00`);
      await expectStored(r.subject, {
        day: d(JAN, 31), startTime: '20:00:00', endTime: '02:00:00', dateSpan: 1, months: [JAN, FEB],
      });
      expect(r.end).toBe(`${d(FEB, 1)}T02:00`);
      expect(r.end_day).toBe(d(FEB, 1));
      await expectSelfConsistent(r, JAN);
    });

    it('timed three-day across the month boundary: dateSpan 2', async () => {
      const r = await create('timed three-day', `${d(JAN, 30)}T10:00:00`, `${d(FEB, 1)}T11:00:00`);
      await expectStored(r.subject, {
        day: d(JAN, 30), startTime: '10:00:00', endTime: '11:00:00', dateSpan: 2, months: [JAN, FEB],
      });
      expect(r.end_day).toBe(d(FEB, 1));
      await expectSelfConsistent(r, FEB);
    });

    it('timed trip shape (end time earlier than start time, later day): dateSpan 8', async () => {
      const r = await create('timed trip', `${d(JAN, 10)}T17:00:00`, `${d(JAN, 18)}T15:00:00`);
      await expectStored(r.subject, {
        day: d(JAN, 10), startTime: '17:00:00', endTime: '15:00:00', dateSpan: 8, months: [JAN],
      });
      expect(r.end).toBe(`${d(JAN, 18)}T15:00`);
    });

    it('all-day single: 00:00/00:00, dateSpan 1, listed only on its own month', async () => {
      const r = await create('all-day single', d(JAN, 31), d(JAN, 31), { allDay: true });
      // Its end instant is Feb 1 00:00, exclusive — Cozi does not page it into February.
      await expectStored(r.subject, {
        day: d(JAN, 31), startTime: '00:00:00', endTime: '00:00:00', dateSpan: 1, months: [JAN],
      });
      expect(r.all_day).toBe(true);
      expect('end_day' in r).toBe(false);
      await expectSelfConsistent(r, JAN);
    });

    it('all-day three-day across the month boundary: dateSpan 3', async () => {
      const r = await create('all-day three-day', d(JAN, 30), d(FEB, 1), { allDay: true });
      await expectStored(r.subject, {
        day: d(JAN, 30), startTime: '00:00:00', endTime: '00:00:00', dateSpan: 3, months: [JAN, FEB],
      });
      expect(r.all_day).toBe(true);
      expect(r.end_day).toBe(d(FEB, 1));
      await expectSelfConsistent(r, FEB);
    });

    it('attendees, location and notes round-trip exactly', async () => {
      const r = await create('with details', `${d(JAN, 15)}T09:00:00`, `${d(JAN, 15)}T10:00:00`, {
        attendees: [memberId], location: 'Live Test Location', notes: 'live test notes',
      });
      const raw = await expectStored(r.subject, {
        day: d(JAN, 15), startTime: '09:00:00', endTime: '10:00:00', dateSpan: 0, months: [JAN],
      });
      expect(raw.householdMembers).toEqual([memberId]);
      expect(raw.itemDetails?.location).toBe('Live Test Location');
      expect(raw.itemDetails?.notes).toBe('live test notes');
      expect(r.attendees).toEqual([memberId]);
      expect(r.location).toBe('Live Test Location');
      expect(r.notes).toBe('live test notes');
      await expectSelfConsistent(r, JAN);
    });

    it('invalid ranges are rejected before any write', async () => {
      const before = (await live.rawPage(Y, MAR)).size;
      await expect(
        create('rejected end-before-start', `${d(MAR, 10)}T10:00:00`, `${d(MAR, 9)}T10:00:00`),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        create('rejected same-day end-before-start', `${d(MAR, 10)}T10:00:00`, `${d(MAR, 10)}T09:00:00`),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        create('rejected bare date on timed', d(MAR, 10), d(MAR, 10)),
      ).rejects.toBeInstanceOf(ValidationError);
      expect((await live.rawPage(Y, MAR)).size).toBe(before);
    });
  });

  // ---- recurrence wire shape ---------------------------------------------------

  describe('recurring series, as Cozi stores a fresh create', () => {
    it('a bounded series reads back flagged, with its rule in words and its end day', async () => {
      const s = subj('series shape');
      await live.rawPost(Y, JAN, [{
        itemType: 'appointment',
        create: {
          startDay: d(JAN, 8),
          recurrence: { rules: [{ frequency: 'Weekly', interval: 1, byDay: ['TU'], end: { untilDay: d(FEB, 12) } }] },
          details: { startTime: '07:00', endTime: '07:30', dateSpan: 0, subject: s, notes: '', location: '' },
        },
      }]);
      const raw = await live.findRaw(Y, JAN, s);
      expect(raw?.id).toBeTruthy();
      live.track(raw!.id!, Y, JAN);

      // Observed 2026-10-11: Cozi stores the rule and derives `endDay` and its own
      // wording from it — itemDetails.recurrence = { rules: [...], endDay, text }.
      const rec = raw!.itemDetails?.recurrence as { endDay?: unknown; text?: unknown; rules?: unknown };
      expect(rec.endDay).toBe(d(FEB, 12));
      expect(rec.text).toEqual(['Every Tuesday', ` until Feb 12, ${Y}`]);
      expect(Array.isArray(rec.rules) && rec.rules.length).toBe(1);

      const seen = (await getCalendarHandler(live.client, Y, JAN)).find((a) => a.id === raw!.id);
      expect(seen?.recurring).toBe(true);
      expect(seen?.recurrence).toBe(`Every Tuesday until Feb 12, ${Y}`);
      expect(seen?.series_end).toBe(d(FEB, 12));
      expect('skipped_days' in (seen ?? {})).toBe(false);
    });
  });

  // ---- update ------------------------------------------------------------------

  describe('update', () => {
    it('a notes-only edit leaves day/times/dateSpan byte-identical', async () => {
      const r = await create('update notes-only', `${d(JAN, 10)}T17:00:00`, `${d(JAN, 18)}T15:00:00`, {
        attendees: [memberId], location: 'Keep Me',
      });
      const before = await live.findRaw(Y, JAN, r.subject);
      const u = await updateAppointmentHandler(live.client, r.id, Y, JAN, { notes: 'edited' });
      const after = await live.findRaw(Y, JAN, r.subject);
      expect(after?.itemDetails?.notes).toBe('edited');
      expect(after?.itemDetails?.location).toBe('Keep Me');
      for (const k of ['day', 'startTime', 'endTime', 'dateSpan', 'householdMembers'] as const) {
        expect(after?.[k]).toEqual(before?.[k]);
      }
      expect(u.notes).toBe('edited');
      expect(u.location).toBe('Keep Me');
      expect(u.attendees).toEqual([memberId]);
      expect(u.end).toBe(`${d(JAN, 18)}T15:00`);
      await expectSelfConsistent(u, JAN);
    });

    it('end-only grow crosses into the next month; shrink back removes it again', async () => {
      const r = await create('update grow-shrink', `${d(JAN, 31)}T09:00:00`, `${d(JAN, 31)}T17:00:00`);
      const grown = await updateAppointmentHandler(live.client, r.id, Y, JAN, { end: `${d(FEB, 2)}T17:00:00` });
      await expectStored(r.subject, {
        day: d(JAN, 31), startTime: '09:00:00', endTime: '17:00:00', dateSpan: 2, months: [JAN, FEB],
      });
      expect(grown.end_day).toBe(d(FEB, 2));
      await expectSelfConsistent(grown, FEB);

      const shrunk = await updateAppointmentHandler(live.client, r.id, Y, JAN, { end: `${d(JAN, 31)}T17:00:00` });
      await expectStored(r.subject, {
        day: d(JAN, 31), startTime: '09:00:00', endTime: '17:00:00', dateSpan: 0, months: [JAN],
      });
      expect('end_day' in shrunk).toBe(false);
      await expectSelfConsistent(shrunk, JAN);
    });

    it('start-only move keeps the length', async () => {
      const r = await create('update start-only', `${d(JAN, 30)}T10:00:00`, `${d(FEB, 1)}T11:00:00`);
      const moved = await updateAppointmentHandler(live.client, r.id, Y, JAN, { start: `${d(FEB, 10)}T10:00:00` });
      await expectStored(r.subject, {
        day: d(FEB, 10), startTime: '10:00:00', endTime: '11:00:00', dateSpan: 2, months: [FEB],
      });
      expect(moved.end_day).toBe(d(FEB, 12));
      await expectSelfConsistent(moved, FEB);
    });

    it('switching a timed multi-day event to all-day covers its whole last day', async () => {
      const r = await create('update to all-day', `${d(JAN, 30)}T10:00:00`, `${d(FEB, 1)}T11:00:00`);
      const u = await updateAppointmentHandler(live.client, r.id, Y, JAN, { allDay: true });
      await expectStored(r.subject, {
        day: d(JAN, 30), startTime: '00:00:00', endTime: '00:00:00', dateSpan: 3, months: [JAN, FEB],
      });
      expect(u.all_day).toBe(true);
      expect(u.end_day).toBe(d(FEB, 1));
      await expectSelfConsistent(u, JAN);
    });

    it('switching an all-day multi-day event to timed keeps the same last day', async () => {
      const r = await create('update to timed', d(JAN, 30), d(FEB, 1), { allDay: true });
      const u = await updateAppointmentHandler(live.client, r.id, Y, JAN, {
        start: `${d(JAN, 30)}T10:00:00`, end: `${d(FEB, 1)}T11:00:00`, allDay: false,
      });
      await expectStored(r.subject, {
        day: d(JAN, 30), startTime: '10:00:00', endTime: '11:00:00', dateSpan: 2, months: [JAN, FEB],
      });
      expect(u.all_day).toBe(false);
      expect(u.end_day).toBe(d(FEB, 1));
      await expectSelfConsistent(u, JAN);
    });

    it('an unrelated edit preserves a bounded recurrence rule exactly', async () => {
      const s = subj('recurring');
      // The tool surface cannot create a series, so build the fixture on the wire.
      // Bounded with `untilDay` so it can never leak onto the present-day calendar.
      const rule = { frequency: 'Weekly', interval: 1, byDay: ['FR'], end: { untilDay: d(FEB, 15) } };
      await live.rawPost(Y, JAN, [{
        itemType: 'appointment',
        create: {
          startDay: d(JAN, 4),
          recurrence: { rules: [rule] },
          details: { startTime: '09:00', endTime: '09:30', dateSpan: 0, subject: s, notes: 'orig', location: 'Rec Loc' },
        },
      }]);
      const created = (await live.client.getCalendar(Y, JAN)).find((a) => a.subject === s);
      expect(created?.id).toBeTruthy();
      live.track(created!.id!, Y, JAN);
      expect(created!.recurrence).not.toBeNull();
      const ruleBefore = stable((created!.recurrence as { rules?: unknown }).rules);
      expect(await live.monthsListing(created!.id!)).toEqual([JAN, FEB]);

      // The series is flagged as such in the projection, on every page it is listed on.
      for (const m of [JAN, FEB]) {
        const seen = (await getCalendarHandler(live.client, Y, m)).find((a) => a.id === created!.id);
        expect(seen?.recurring, `recurring flag on ${Y}-${m}`).toBe(true);
        expect(seen?.series_end).toBe(d(FEB, 15));
      }

      await updateAppointmentHandler(live.client, created!.id!, Y, JAN, { notes: 'edited', scope: 'series' });
      const after = (await live.client.getCalendar(Y, JAN)).find((a) => a.id === created!.id);
      expect(after?.notes).toBe('edited');
      expect(after?.location).toBe('Rec Loc');
      expect(stable((after?.recurrence as { rules?: unknown })?.rules)).toBe(ruleBefore);
      expect(await live.monthsListing(created!.id!)).toEqual([JAN, FEB]);
    });

    it('get_calendar lists a series once per occurrence, on exactly the days Cozi expands it to', async () => {
      const s = subj('occurrences');
      await live.rawPost(Y, JAN, [{
        itemType: 'appointment',
        create: {
          startDay: d(JAN, 8),
          recurrence: { rules: [{ frequency: 'Weekly', interval: 1, byDay: ['TU'], end: { untilDay: d(FEB, 12) } }] },
          details: { startTime: '07:00', endTime: '07:30', dateSpan: 0, subject: s, notes: '', location: '' },
        },
      }]);
      const raw = await live.findRaw(Y, JAN, s);
      live.track(raw!.id!, Y, JAN);
      // Delete one occurrence the way the Cozi app does, so it must drop out of the listing.
      await live.rawPost(Y, JAN, [{ itemType: 'appointment', delete: { id: raw!.id }, selectedDay: d(JAN, 22), extent: 'day' }]);

      const listed = async (m: number) =>
        (await getCalendarHandler(live.client, Y, m)).filter((a) => a.id === raw!.id);
      const jan = await listed(JAN);
      expect(jan.map((a) => a.day)).toEqual([d(JAN, 8), d(JAN, 15), d(JAN, 29)]);
      expect(jan.map((a) => a.start)).toEqual([`${d(JAN, 8)}T07:00`, `${d(JAN, 15)}T07:00`, `${d(JAN, 29)}T07:00`]);
      expect(jan.every((a) => a.series_start === d(JAN, 8) && a.recurring && a.series_end === d(FEB, 12))).toBe(true);
      expect(jan[0]!.skipped_days).toEqual([d(JAN, 22)]);
      expect((await listed(FEB)).map((a) => a.day)).toEqual([d(FEB, 5), d(FEB, 12)]);
    });

    it('an edit keeps reminders set in the Cozi app, though it never sends them', async () => {
      const s = subj('reminders');
      // Reminders are top-level on the wire and the web client re-sends them on every
      // edit. Our edit omits them and relies on Cozi keeping what it is not sent.
      const reminders = [{ minutesBefore: 60 }];
      await live.rawPost(Y, JAN, [{
        itemType: 'appointment',
        create: {
          startDay: d(JAN, 15),
          reminders,
          details: { startTime: '10:00', endTime: '11:00', dateSpan: 0, subject: s, notes: 'orig', location: '' },
        },
      }]);
      const raw = await live.findRaw(Y, JAN, s);
      expect(raw?.id).toBeTruthy();
      live.track(raw!.id!, Y, JAN);
      expect(raw!.reminders).toEqual(reminders);

      await updateAppointmentHandler(live.client, raw!.id!, Y, JAN, { notes: 'edited' });
      const after = await live.findRaw(Y, JAN, s);
      expect(after?.itemDetails?.notes).toBe('edited');
      expect(after?.reminders).toEqual(reminders);
    });

    it('an end before the start is rejected without touching the appointment', async () => {
      const r = await create('update rejected', `${d(JAN, 20)}T10:00:00`, `${d(JAN, 22)}T10:00:00`);
      const before = await live.findRaw(Y, JAN, r.subject);
      await expect(
        updateAppointmentHandler(live.client, r.id, Y, JAN, { end: `${d(JAN, 19)}T10:00:00` }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(stable(await live.findRaw(Y, JAN, r.subject))).toBe(stable(before));
    });
  });

  // ---- recurring writes ----------------------------------------------------------
  // Every series here ends inside the 2019 sandbox, so a failed teardown can never
  // leave anything on the family's present-day calendar.

  describe('recurring writes', () => {
    const days = async (id: string, m: number) =>
      (await getCalendarHandler(live.client, Y, m)).filter((a) => a.id === id).map((a) => a.day);
    const series = async (label: string, start: string, end: string, repeat: RepeatInput) => {
      const r = await createAppointmentHandler(live.client, subj(label), start, end, undefined, false, '', undefined, { repeat });
      live.track(r.id, Y, Number(start.slice(5, 7)));
      return r;
    };

    it('repeat creates the series Cozi then expands to the expected days', async () => {
      const wk = await series('repeat weekly', `${d(JAN, 8)}T07:00:00`, `${d(JAN, 8)}T07:30:00`, {
        frequency: 'weekly', weekdays: ['TU', 'TH'], until: d(JAN, 24),
      });
      expect(wk.recurring).toBe(true);
      expect(await days(wk.id, JAN)).toEqual([d(JAN, 8), d(JAN, 10), d(JAN, 15), d(JAN, 17), d(JAN, 22), d(JAN, 24)]);

      // 2019-01-29 is the 5th Tuesday: 'weekday' means the last Tuesday of each month.
      const last = await series('repeat last tuesday', `${d(JAN, 29)}T18:00:00`, `${d(JAN, 29)}T19:00:00`, {
        frequency: 'monthly', monthly_by: 'weekday', until: d(MAR, 31),
      });
      expect(await days(last.id, FEB)).toEqual([d(FEB, 26)]);
      expect(await days(last.id, MAR)).toEqual([d(MAR, 26)]);

      const daily = await series('repeat every other day', `${d(FEB, 1)}T08:00:00`, `${d(FEB, 1)}T08:15:00`, {
        frequency: 'daily', interval: 2, until: d(FEB, 7),
      });
      expect(await days(daily.id, FEB)).toEqual([d(FEB, 1), d(FEB, 3), d(FEB, 5), d(FEB, 7)]);

      const yearly = await series('repeat yearly', `${d(MAR, 20)}T09:00:00`, `${d(MAR, 20)}T10:00:00`, {
        frequency: 'yearly', until: d(MAR, 31),
      });
      expect(await days(yearly.id, MAR)).toEqual([d(MAR, 20)]);
      const raw = await live.findRaw(Y, MAR, subj('repeat yearly'));
      expect((raw!.itemDetails!.recurrence as { rules: unknown[] }).rules[0]).toMatchObject({
        frequency: 'Yearly', byMonth: [3], byMonthDay: [20],
      });
    });

    it('repeat on an update turns a one-off into a series', async () => {
      const r = await create('one-off to series', `${d(JAN, 10)}T12:00:00`, `${d(JAN, 10)}T12:30:00`);
      const u = await updateAppointmentHandler(live.client, r.id, Y, JAN, {
        repeat: { frequency: 'weekly', until: d(JAN, 31) },
      });
      expect(u.recurring).toBe(true);
      expect(await days(r.id, JAN)).toEqual([d(JAN, 10), d(JAN, 17), d(JAN, 24), d(JAN, 31)]);
    });

    it('reminders are set on create, replaced and cleared on update', async () => {
      const s = subj('reminders tool');
      const r = await createAppointmentHandler(
        live.client, s, `${d(JAN, 16)}T10:00:00`, `${d(JAN, 16)}T11:00:00`, undefined, false, '', undefined,
        { reminders: [1440, 30] },
      );
      live.track(r.id, Y, JAN);
      expect(r.reminders).toEqual([30, 1440]);
      expect((await live.findRaw(Y, JAN, s))!.reminders).toEqual([{ minutesBefore: 1440 }, { minutesBefore: 30 }]);

      expect((await updateAppointmentHandler(live.client, r.id, Y, JAN, { reminders: [60] })).reminders).toEqual([60]);
      const cleared = await updateAppointmentHandler(live.client, r.id, Y, JAN, { reminders: [] });
      expect(cleared.reminders).toBeUndefined();
      expect((await live.findRaw(Y, JAN, s))!.reminders).toBeUndefined();
    });

    it("scope 'this' moves one occurrence; the rest of the series stays", async () => {
      const r = await series('edit one', `${d(JAN, 8)}T07:00:00`, `${d(JAN, 8)}T07:30:00`, { frequency: 'weekly', until: d(JAN, 29) });
      await expect(
        updateAppointmentHandler(live.client, r.id, Y, JAN, { notes: 'no scope' }),
      ).rejects.toBeInstanceOf(ValidationError);

      const moved = await updateAppointmentHandler(live.client, r.id, Y, JAN, {
        scope: 'this', occurrenceDay: d(JAN, 15), start: `${d(JAN, 16)}T09:00:00`, end: `${d(JAN, 16)}T09:30:00`,
      });
      live.track(moved.id, Y, JAN);
      expect(moved.id).not.toBe(r.id);
      expect([moved.day, moved.start, moved.recurring]).toEqual([d(JAN, 16), `${d(JAN, 16)}T09:00`, undefined]);

      const jan = await getCalendarHandler(live.client, Y, JAN);
      expect(jan.filter((a) => a.id === r.id).map((a) => a.day)).toEqual([d(JAN, 8), d(JAN, 22), d(JAN, 29)]);
      // An edited occurrence is not a deleted one.
      expect(jan.find((a) => a.id === r.id)!.skipped_days).toBeUndefined();
      expect(jan.find((a) => a.id === moved.id)).toEqual(moved);
    });

    it("scope 'this_and_following' splits the series at the occurrence", async () => {
      const r = await series('edit following', `${d(JAN, 8)}T07:00:00`, `${d(JAN, 8)}T07:30:00`, { frequency: 'weekly', until: d(FEB, 12) });
      // A one-off with the same subject, day and times must not be mistaken for the new series.
      const decoy = await create('edit following', `${d(JAN, 22)}T09:00:00`, `${d(JAN, 22)}T09:30:00`);
      const next = await updateAppointmentHandler(live.client, r.id, Y, JAN, {
        scope: 'this_and_following', occurrenceDay: d(JAN, 22), start: `${d(JAN, 22)}T09:00:00`, end: `${d(JAN, 22)}T09:30:00`,
      });
      live.track(next.id, Y, JAN);
      expect(next.id).not.toBe(r.id);
      expect(next.id).not.toBe(decoy.id);
      expect([next.day, next.start, next.recurring, next.series_end]).toEqual([d(JAN, 22), `${d(JAN, 22)}T09:00`, true, d(FEB, 12)]);
      expect(await days(r.id, JAN)).toEqual([d(JAN, 8), d(JAN, 15)]);
      expect(await days(next.id, JAN)).toEqual([d(JAN, 22), d(JAN, 29)]);
      expect(await days(next.id, FEB)).toEqual([d(FEB, 5), d(FEB, 12)]);
    });

    it("delete scope 'this' and 'this_and_following' remove exactly those occurrences", async () => {
      const r = await series('delete scoped', `${d(JAN, 8)}T07:00:00`, `${d(JAN, 8)}T07:30:00`, { frequency: 'weekly', until: d(FEB, 12) });
      await deleteAppointmentHandler(live.client, r.id, Y, JAN, { scope: 'this', occurrenceDay: d(JAN, 15) });
      expect(await days(r.id, JAN)).toEqual([d(JAN, 8), d(JAN, 22), d(JAN, 29)]);
      expect((await getCalendarHandler(live.client, Y, JAN)).find((a) => a.id === r.id)!.skipped_days).toEqual([d(JAN, 15)]);

      await deleteAppointmentHandler(live.client, r.id, Y, JAN, { scope: 'this_and_following', occurrenceDay: d(JAN, 29) });
      expect(await days(r.id, JAN)).toEqual([d(JAN, 8), d(JAN, 22)]);
      expect(await days(r.id, FEB)).toEqual([]);
    });

    it('a multi-day series is listed once per occurrence, and scoped writes take that first day', async () => {
      const r = await series('multi-day', `${d(JAN, 8)}T18:00:00`, `${d(JAN, 9)}T12:00:00`, { frequency: 'weekly', until: d(JAN, 29) });
      const listed = async () =>
        (await getCalendarHandler(live.client, Y, JAN)).filter((a) => a.id === r.id).map((a) => [a.day, a.end_day]);
      expect(await listed()).toEqual([[d(JAN, 8), d(JAN, 9)], [d(JAN, 15), d(JAN, 16)], [d(JAN, 22), d(JAN, 23)], [d(JAN, 29), d(JAN, 30)]]);

      // A day inside an occurrence names nothing on the page, so nothing is written...
      await expect(
        updateAppointmentHandler(live.client, r.id, Y, JAN, { scope: 'this', occurrenceDay: d(JAN, 16), notes: 'x' }),
      ).rejects.toThrow(/not an occurrence/);
      await expect(
        deleteAppointmentHandler(live.client, r.id, Y, JAN, { scope: 'this', occurrenceDay: d(JAN, 23) }),
      ).rejects.toThrow(/not an occurrence/);
      expect(await listed()).toHaveLength(4);

      // ...and the first day changes exactly that occurrence: the stand-in keeps both days.
      const standin = await updateAppointmentHandler(live.client, r.id, Y, JAN, { scope: 'this', occurrenceDay: d(JAN, 15), notes: 'own copy' });
      live.track(standin.id, Y, JAN);
      expect([standin.day, standin.end_day, standin.end, standin.recurring]).toEqual([d(JAN, 15), d(JAN, 16), `${d(JAN, 16)}T12:00`, undefined]);
      expect(await days(r.id, JAN)).toEqual([d(JAN, 8), d(JAN, 22), d(JAN, 29)]);

      await deleteAppointmentHandler(live.client, r.id, Y, JAN, { scope: 'this', occurrenceDay: d(JAN, 22) });
      expect(await days(r.id, JAN)).toEqual([d(JAN, 8), d(JAN, 29)]);
      await deleteAppointmentHandler(live.client, r.id, Y, JAN, { scope: 'this_and_following', occurrenceDay: d(JAN, 29) });
      expect(await days(r.id, JAN)).toEqual([d(JAN, 8)]);
    });

    it("Cozi's day map names the occurrence each covered day belongs to (what get_calendar lists by)", async () => {
      const ours = async (id: string) =>
        Object.entries(await live.rawDays(Y, JAN))
          .flatMap(([day, refs]) => refs.filter((x) => x.id === id).map((x) => [day, x.multiday?.startDay, x.multiday?.endDay]))
          .sort();
      const r = await series('day map', `${d(JAN, 8)}T18:00:00`, `${d(JAN, 9)}T12:00:00`, { frequency: 'weekly', until: d(JAN, 15) });
      expect(await ours(r.id)).toEqual([
        [d(JAN, 8), d(JAN, 8), d(JAN, 9)], [d(JAN, 9), d(JAN, 8), d(JAN, 9)],
        [d(JAN, 15), d(JAN, 15), d(JAN, 16)], [d(JAN, 16), d(JAN, 15), d(JAN, 16)],
      ]);
      // An all-day occurrence's endDay is the end instant's day, one past its last day.
      const a = await createAppointmentHandler(live.client, subj('day map all-day'), d(JAN, 11), d(JAN, 13), undefined, true, '', undefined, {
        repeat: { frequency: 'weekly', until: d(JAN, 11) },
      });
      live.track(a.id, Y, JAN);
      expect(await ours(a.id)).toEqual([
        [d(JAN, 11), d(JAN, 11), d(JAN, 14)], [d(JAN, 12), d(JAN, 11), d(JAN, 14)], [d(JAN, 13), d(JAN, 11), d(JAN, 14)],
      ]);
    });

    it('an occurrence that began last month is listed by that day, and is written to from this page', async () => {
      // Wed Jan 30 – Fri Feb 1, weekly: February's page lists it as Jan 30, and takes that day.
      const r = await series('straddle', `${d(JAN, 30)}T09:00:00`, `${d(FEB, 1)}T17:00:00`, { frequency: 'weekly', until: d(FEB, 13) });
      const feb = async () =>
        (await getCalendarHandler(live.client, Y, FEB)).filter((a) => a.id === r.id).map((a) => [a.day, a.end_day]);
      expect(await feb()).toEqual([[d(JAN, 30), d(FEB, 1)], [d(FEB, 6), d(FEB, 8)], [d(FEB, 13), d(FEB, 15)]]);
      await expect(
        deleteAppointmentHandler(live.client, r.id, Y, FEB, { scope: 'this', occurrenceDay: d(FEB, 1) }),
      ).rejects.toThrow(/not an occurrence/);
      await deleteAppointmentHandler(live.client, r.id, Y, FEB, { scope: 'this', occurrenceDay: d(JAN, 30) });
      expect(await feb()).toEqual([[d(FEB, 6), d(FEB, 8)], [d(FEB, 13), d(FEB, 15)]]);
      expect(await days(r.id, JAN)).toEqual([]);
    });

    it('an occurrence that began last month is edited from this page: the stand-in keeps that day and is found', async () => {
      // The edit is posted to the page of the start day sent (January here), while the
      // caller named February; the series then has no January day left and is gone from
      // that page, so the stand-in is matched by what was sent.
      const r = await series('straddle edit', `${d(JAN, 30)}T09:00:00`, `${d(FEB, 1)}T17:00:00`, { frequency: 'weekly', until: d(FEB, 13) });
      const standin = await updateAppointmentHandler(live.client, r.id, Y, FEB, { scope: 'this', occurrenceDay: d(JAN, 30), notes: 'own copy' });
      live.track(standin.id, Y, JAN);
      expect([standin.day, standin.end_day, standin.end, standin.notes, standin.recurring]).toEqual([
        d(JAN, 30), d(FEB, 1), `${d(FEB, 1)}T17:00`, 'own copy', undefined,
      ]);
      const feb = await getCalendarHandler(live.client, Y, FEB);
      expect(feb.filter((a) => a.id === r.id).map((a) => a.day)).toEqual([d(FEB, 6), d(FEB, 13)]);
      expect(feb.find((a) => a.id === standin.id)).toEqual(standin);
      expect(await days(r.id, JAN)).toEqual([]);
      expect(await days(standin.id, JAN)).toEqual([d(JAN, 30)]);
    });

    it("a series' only occurrence in a month: an edit returns the stand-in, a delete empties the page, and Cozi drops the series from it", async () => {
      const edited = await series('only one edit', `${d(JAN, 29)}T07:00:00`, `${d(JAN, 29)}T07:30:00`, { frequency: 'weekly', until: d(FEB, 12) });
      const standin = await updateAppointmentHandler(live.client, edited.id, Y, JAN, { scope: 'this', occurrenceDay: d(JAN, 29), notes: 'own copy' });
      live.track(standin.id, Y, JAN);
      expect([standin.day, standin.notes, standin.recurring]).toEqual([d(JAN, 29), 'own copy', undefined]);
      const jan = await getCalendarHandler(live.client, Y, JAN);
      expect(jan.find((a) => a.id === edited.id)).toBeUndefined();
      expect(jan.find((a) => a.id === standin.id)).toEqual(standin);
      expect(await days(edited.id, FEB)).toEqual([d(FEB, 5), d(FEB, 12)]);

      const deleted = await series('only one delete', `${d(JAN, 29)}T08:00:00`, `${d(JAN, 29)}T08:30:00`, { frequency: 'weekly', until: d(FEB, 12) });
      expect(await deleteAppointmentHandler(live.client, deleted.id, Y, JAN, { scope: 'this', occurrenceDay: d(JAN, 29) })).toBe(true);
      expect((await getCalendarHandler(live.client, Y, JAN)).find((a) => a.id === deleted.id)).toBeUndefined();
      expect(await days(deleted.id, FEB)).toEqual([d(FEB, 5), d(FEB, 12)]);
    });
  });

  // ---- search ------------------------------------------------------------------

  describe('search', () => {
    it('search_calendar finds our appointments and reports a series by its occurrences', async () => {
      const { year: SY, month: SM } = SEARCH_SANDBOX;
      const sd = (day: number) => `${SY}-${String(SM).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const token = 'zqxjwv';
      const one = await createAppointmentHandler(
        live.client, subj(`${token} one-off`), `${sd(18)}T10:00:00`, `${sd(18)}T11:00:00`, undefined, false, '', undefined,
      );
      live.track(one.id, SY, SM);
      const rec = await createAppointmentHandler(
        live.client, subj(`${token} weekly`), `${sd(4)}T07:00:00`, `${sd(4)}T07:30:00`, undefined, false, '', undefined,
        { repeat: { frequency: 'weekly', until: sd(25) } },
      );
      live.track(rec.id, SY, SM);
      // Fri 18:00 – Sat 12:00, weekly: a multi-day series is reported by occurrence start days.
      const trip = await createAppointmentHandler(
        live.client, subj(`${token} trip`), `${sd(7)}T18:00:00`, `${sd(8)}T12:00:00`, undefined, false, '', undefined,
        { repeat: { frequency: 'weekly', until: sd(21) } },
      );
      live.track(trip.id, SY, SM);

      // Cozi's search index trails writes by a few seconds.
      let appointments: Awaited<ReturnType<typeof searchCalendarHandler>>['appointments'] = [];
      for (let i = 0; i < 15 && appointments.length < 3; i++) {
        if (i) await new Promise((r) => setTimeout(r, 2000));
        appointments = (await searchCalendarHandler(live.client, token)).appointments;
      }
      expect(appointments.map((a) => a.id).sort()).toEqual([one.id, rec.id, trip.id].sort());
      expect(appointments.find((a) => a.id === one.id)).toMatchObject({ day: sd(18), start: `${sd(18)}T10:00` });
      // Every occurrence is in the past, so only the latest one is reported.
      const series = appointments.find((a) => a.id === rec.id)!;
      expect([series.recurring, series.last_day, series.next_days]).toEqual([true, sd(25), undefined]);
      const multi = appointments.find((a) => a.id === trip.id)!;
      expect([multi.recurring, multi.day, multi.end_day, multi.last_day, multi.next_days]).toEqual([true, sd(7), sd(8), sd(21), undefined]);
    });
  });

  // ---- delete ------------------------------------------------------------------

  describe('delete', () => {
    it('a cross-month event disappears from every month it was listed on', async () => {
      const r = await create('delete cross-month', d(JAN, 30), d(FEB, 1), { allDay: true });
      expect(await live.monthsListing(r.id)).toEqual([JAN, FEB]);
      expect(await deleteAppointmentHandler(live.client, r.id, Y, JAN)).toBe(true);
      expect(await live.monthsListing(r.id)).toEqual([]);
    });

    it('a bounded series disappears from every month it was listed on', async () => {
      const s = subj('delete recurring');
      await live.rawPost(Y, JAN, [{
        itemType: 'appointment',
        create: {
          startDay: d(JAN, 7),
          recurrence: { rules: [{ frequency: 'Weekly', interval: 1, byDay: ['MO'], end: { untilDay: d(FEB, 11) } }] },
          details: { startTime: '08:00', endTime: '08:30', dateSpan: 0, subject: s, notes: '', location: '' },
        },
      }]);
      const created = (await live.client.getCalendar(Y, JAN)).find((a) => a.subject === s);
      expect(created?.id).toBeTruthy();
      live.track(created!.id!, Y, JAN);
      expect(await live.monthsListing(created!.id!)).toEqual([JAN, FEB]);

      // Without a scope the tool refuses and the series is untouched...
      await expect(deleteAppointmentHandler(live.client, created!.id!, Y, JAN)).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(await live.monthsListing(created!.id!)).toEqual([JAN, FEB]);

      // ...and with it every occurrence goes, from every month page.
      expect(await deleteAppointmentHandler(live.client, created!.id!, Y, JAN, { scope: 'series' })).toBe(true);
      expect(await live.monthsListing(created!.id!)).toEqual([]);
    });

    it('a one-off needs no scope', async () => {
      const r = await create('delete one-off', `${d(JAN, 12)}T10:00:00`, `${d(JAN, 12)}T11:00:00`);
      expect(await deleteAppointmentHandler(live.client, r.id, Y, JAN)).toBe(true);
      expect(await live.monthsListing(r.id)).toEqual([]);
    });

    it('an unknown id is a ResourceNotFoundError from the tool', async () => {
      await expect(
        deleteAppointmentHandler(live.client, '00000000-0000-0000-0000-000000000000', Y, MAR),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
    });

    it('Cozi itself treats an unknown id as a no-op (documents the wire behaviour)', async () => {
      await expect(
        live.client.deleteAppointment('00000000-0000-0000-0000-000000000000', Y, MAR),
      ).resolves.toBe(true);
    });
  });
});
