// Live conformance: calendar create / update / delete against the REAL Cozi API.
// See harness.ts for why this exists and how span semantics are observed.
//
// Expected `dateSpan` values follow Cozi's rule — end instant = day + dateSpan at
// endTime; an all-day event is 00:00→00:00 so its end instant is the midnight after
// its last covered day — and are cross-checked with the month pages Cozi lists the
// appointment on, which is Cozi's own reading of the span.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ValidationError } from '../../src/cozi/index.js';
import {
  createAppointmentHandler,
  deleteAppointmentHandler,
  getCalendarHandler,
  updateAppointmentHandler,
} from '../../src/tools/calendar.js';
import type { SlimAppointment } from '../../src/tools/projections.js';
import { Live, SANDBOX, haveCreds, stable, subj, type RawCalendarItem } from './harness.js';

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

      await updateAppointmentHandler(live.client, created!.id!, Y, JAN, { notes: 'edited' });
      const after = (await live.client.getCalendar(Y, JAN)).find((a) => a.id === created!.id);
      expect(after?.notes).toBe('edited');
      expect(after?.location).toBe('Rec Loc');
      expect(stable((after?.recurrence as { rules?: unknown })?.rules)).toBe(ruleBefore);
      expect(await live.monthsListing(created!.id!)).toEqual([JAN, FEB]);
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
      expect(await live.monthsListing(created!.id!)).toEqual([JAN, FEB]);
      expect(await deleteAppointmentHandler(live.client, created!.id!, Y, JAN)).toBe(true);
      expect(await live.monthsListing(created!.id!)).toEqual([]);
    });

    it('deleting an unknown id is a no-op, not an error (documents Cozi behaviour)', async () => {
      await expect(
        deleteAppointmentHandler(live.client, '00000000-0000-0000-0000-000000000000', Y, MAR),
      ).resolves.toBe(true);
    });
  });
});
