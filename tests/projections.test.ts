import { describe, expect, it } from 'vitest';
import { skippedDays } from '../src/cozi/index.js';
import {
  expandAppt,
  slimAppt,
  slimItem,
  slimListSummary,
  slimPerson,
} from '../src/tools/projections.js';
import { makeAppointment, makeItem, makeList, makePerson } from './helpers/factories.js';

describe('slimPerson', () => {
  it('drops email phone and other PII', () => {
    const p = makePerson({ email: 'alice@example.com' });
    expect(slimPerson(p)).toEqual({ id: 'person_1', name: 'Alice', color: 3 });
  });

  it('omits color when null', () => {
    const p = makePerson({ color: null });
    expect(slimPerson(p)).toEqual({ id: 'person_1', name: 'Alice' });
    expect('color' in slimPerson(p)).toBe(false);
  });

  it('keys are stable', () => {
    const keys = new Set(Object.keys(slimPerson(makePerson())));
    expect([...keys].every((k) => ['id', 'name', 'color'].includes(k))).toBe(true);
  });
});

describe('slimListSummary', () => {
  it('counts open and done', () => {
    const lst = makeList({
      items: [
        makeItem({ id: 'a', status: 'incomplete' }),
        makeItem({ id: 'b', status: 'incomplete' }),
        makeItem({ id: 'c', status: 'complete' }),
      ],
    });
    expect(slimListSummary(lst)).toEqual({
      id: 'list_1',
      title: 'Groceries',
      type: 'shopping',
      item_count: 3,
      completed_count: 1,
    });
  });

  it('empty list', () => {
    const out = slimListSummary(makeList({ items: [] }));
    expect(out.item_count).toBe(0);
    expect(out.completed_count).toBe(0);
  });

  it('keys are stable', () => {
    const keys = new Set(Object.keys(slimListSummary(makeList())));
    expect(keys).toEqual(new Set(['id', 'title', 'type', 'item_count', 'completed_count']));
  });
});

describe('slimItem', () => {
  it('status is string not enum', () => {
    const out = slimItem(makeItem({ status: 'complete' }));
    expect(out.status).toBe('complete');
    expect(typeof out.status).toBe('string');
  });

  it('omits position when null', () => {
    const out = slimItem(makeItem({ position: null }));
    expect('position' in out).toBe(false);
    expect(out).toEqual({ id: 'item_1', text: 'Milk', status: 'incomplete' });
  });

  it('keys are stable', () => {
    const keys = new Set(Object.keys(slimItem(makeItem())));
    expect([...keys].every((k) => ['id', 'text', 'status', 'position'].includes(k))).toBe(true);
  });
});

describe('slimAppt', () => {
  it('a one-off carries no recurring fields at all', () => {
    const out = slimAppt(makeAppointment());
    expect('recurring' in out).toBe(false);
    expect('recurrence' in out).toBe(false);
    expect('series_end' in out).toBe(false);
  });

  // Real GET shape (tests/security-recurrence-preservation.test.ts): on a plain read
  // Cozi may send only its wording, the end day and exdates — no `rules`.
  it('a recurring series is flagged, with the Cozi wording and its end day', () => {
    const a = makeAppointment();
    a.recurrence = {
      exdates: [{ date: '2026-05-22T10:00:00' }],
      endDay: '2026-12-31',
      text: ['Every weekday', ' until Dec 31, 2026'],
    };
    a.endDay = '2026-12-31';
    const out = slimAppt(a);
    expect(out.recurring).toBe(true);
    expect(out.recurrence).toBe('Every weekday until Dec 31, 2026');
    expect(out.series_end).toBe('2026-12-31');
  });

  // "Delete this occurrence only" in the Cozi app leaves the series and adds an exdate.
  it('deleted single occurrences are listed as skipped_days, as sorted unique dates', () => {
    const a = makeAppointment();
    a.recurrence = {
      text: ['Every Monday'],
      exdates: [
        { date: '2026-10-19T17:15:00' },
        { date: '2026-10-12T17:15:00' },
        { date: '2026-10-12T17:15:00' },
        { nope: true },
      ],
    };
    const out = slimAppt(a);
    expect(out.recurring).toBe(true);
    expect(out.skipped_days).toEqual(['2026-10-12', '2026-10-19']);
  });

  it('a series with no exceptions has no skipped_days key', () => {
    const a = makeAppointment();
    a.recurrence = { text: ['Every Monday'], exdates: [] };
    expect('skipped_days' in slimAppt(a)).toBe(false);
  });

  it('an open-ended series with only rules is flagged without wording or end', () => {
    const a = makeAppointment();
    a.recurrence = { rules: [{ frequency: 'Weekly', interval: 1, byDay: ['FR'], end: {} }] };
    const out = slimAppt(a);
    expect(out.recurring).toBe(true);
    expect('recurrence' in out).toBe(false);
    expect('series_end' in out).toBe(false);
  });

  it('an empty recurrence object is not a series', () => {
    const a = makeAppointment();
    a.recurrence = {};
    expect('recurring' in slimAppt(a)).toBe(false);
    a.recurrence = { rules: [], text: [] };
    expect('recurring' in slimAppt(a)).toBe(false);
  });

  it('timed event emits ISO start/end', () => {
    const a = makeAppointment({
      startDay: '2026-05-15',
      startTime: { h: 10, m: 0 },
      endTime: { h: 11, m: 30 },
    });
    const out = slimAppt(a);
    expect(out.all_day).toBe(false);
    expect(out.day).toBe('2026-05-15');
    expect(out.start).toBe('2026-05-15T10:00');
    expect(out.end).toBe('2026-05-15T11:30');
  });

  it('all-day event omits start/end', () => {
    const out = slimAppt(makeAppointment({ startTime: null, endTime: null }));
    expect(out.all_day).toBe(true);
    expect('start' in out).toBe(false);
    expect('end' in out).toBe(false);
  });

  // `dateSpan` is a day offset: a timed event ends dateSpan days after it starts.
  it('multi-day timed event ends dateSpan days after its start', () => {
    const out = slimAppt(
      makeAppointment({
        startDay: '2027-07-19',
        startTime: { h: 10, m: 0 },
        endTime: { h: 11, m: 0 },
        dateSpan: 3,
      }),
    );
    expect(out.day).toBe('2027-07-19');
    expect(out.start).toBe('2027-07-19T10:00');
    expect(out.end).toBe('2027-07-22T11:00');
    expect(out.end_day).toBe('2027-07-22');
  });

  // Issue #12: a timed event with dateSpan 1 is an overnight, not a single day.
  it('timed event with dateSpan 1 ends the next day', () => {
    const out = slimAppt(
      makeAppointment({
        startDay: '2026-08-16',
        startTime: { h: 23, m: 55 },
        endTime: { h: 22, m: 0 },
        dateSpan: 1,
      }),
    );
    expect(out.end).toBe('2026-08-17T22:00');
    expect(out.end_day).toBe('2026-08-17');
  });

  // An all-day event's end instant is the midnight after its last day, so its
  // dateSpan counts covered days: 8 days from Feb 7 end on Feb 14.
  it('multi-day all-day event reports end_day with no times', () => {
    const out = slimAppt(
      makeAppointment({ startDay: '2026-02-07', startTime: null, endTime: null, dateSpan: 8 }),
    );
    expect(out.all_day).toBe(true);
    expect('start' in out).toBe(false);
    expect('end' in out).toBe(false);
    expect(out.end_day).toBe('2026-02-14');
  });

  it('timed dateSpan 0 is a single day and omits end_day', () => {
    const out = slimAppt(makeAppointment({ startDay: '2026-05-15', dateSpan: 0 }));
    expect(out.end).toBe('2026-05-15T11:00');
    expect('end_day' in out).toBe(false);
  });

  it('all-day dateSpan 0 (field absent) and 1 both mean a single day', () => {
    for (const dateSpan of [0, 1]) {
      const out = slimAppt(
        makeAppointment({ startDay: '2026-05-15', startTime: null, endTime: null, dateSpan }),
      );
      expect(out.all_day).toBe(true);
      expect('end_day' in out).toBe(false);
    }
  });

  it('spans a month boundary without drifting', () => {
    const out = slimAppt(
      makeAppointment({ startDay: '2027-07-30', startTime: null, endTime: null, dateSpan: 4 }),
    );
    expect(out.end_day).toBe('2027-08-02');
  });

  it('omits empty attendees/location/notes', () => {
    const out = slimAppt(makeAppointment({ attendees: [], location: null, notes: null }));
    expect('attendees' in out).toBe(false);
    expect('location' in out).toBe(false);
    expect('notes' in out).toBe(false);
  });

  it('includes attendees/location/notes when present', () => {
    const out = slimAppt(
      makeAppointment({ attendees: ['alice', 'bob'], location: 'Field B', notes: 'Bring water' }),
    );
    expect(out.attendees).toEqual(['alice', 'bob']);
    expect(out.location).toBe('Field B');
    expect(out.notes).toBe('Bring water');
  });

  it('keys are stable (full timed appointment)', () => {
    const keys = new Set(Object.keys(slimAppt(makeAppointment())));
    expect(keys).toEqual(
      new Set(['id', 'subject', 'day', 'all_day', 'start', 'end', 'attendees', 'location', 'notes']),
    );
    const spanKeys = new Set(Object.keys(slimAppt(makeAppointment({ dateSpan: 4 }))));
    expect(spanKeys).toEqual(
      new Set([
        'id',
        'subject',
        'day',
        'all_day',
        'start',
        'end',
        'end_day',
        'attendees',
        'location',
        'notes',
      ]),
    );
  });

  it('drops noise fields', () => {
    const keys = new Set(Object.keys(slimAppt(makeAppointment())));
    const forbidden = [
      'description',
      'description_short',
      'descriptionShort',
      'notes_html',
      'notesHtml',
      'notes_plain',
      'notesPlain',
      'item_type',
      'itemType',
      'item_version',
      'itemVersion',
      'recurrence',
      'read_only',
      'readOnly',
      'household_member',
      'householdMember',
      'name',
      'birth_year',
      'birthYear',
      'created_at',
      'createdAt',
      'updated_at',
      'updatedAt',
    ];
    for (const f of forbidden) expect(keys.has(f)).toBe(false);
  });
});

describe('list section headers', () => {
  it('are flagged and left out of the counts', () => {
    const lst = makeList({
      items: [makeItem({ id: 'h', text: 'PRODUCE', itemType: 'header' }), makeItem({ id: 'a' })],
    });
    expect(slimItem(lst.items[0]!).header).toBe(true);
    expect('header' in slimItem(lst.items[1]!)).toBe(false);
    expect(slimListSummary(lst).item_count).toBe(1);
  });
});

describe('calendar item kinds', () => {
  it('surfaces birthday, read-only, source and reminders only when set', () => {
    const plain = slimAppt(makeAppointment({ itemType: 'appointment' }));
    expect(['kind', 'read_only', 'source', 'reminders'].some((k) => k in plain)).toBe(false);

    const holiday = slimAppt(makeAppointment({ readOnly: true, itemSource: 'Holiday US - Cozi' }));
    expect(holiday.read_only).toBe(true);
    expect(holiday.source).toBe('Holiday US - Cozi');
    expect(slimAppt(makeAppointment({ itemType: 'birthday' })).kind).toBe('birthday');
    expect(slimAppt(makeAppointment({ reminders: [30, 1440] })).reminders).toEqual([30, 1440]);
  });
});

describe('expandAppt', () => {
  const weekly = { recurrence: { rules: [{ frequency: 'Weekly', byDay: ['TU'] }] } };

  it('lists a same-day series once per occurrence Cozi expanded it to', () => {
    const a = makeAppointment({ ...weekly, startDay: '2026-01-06', occurrenceDays: ['2026-02-03', '2026-02-10'] });
    const out = expandAppt(a);
    expect(out.map((o) => [o.day, o.start, o.end, o.series_start, o.id])).toEqual([
      ['2026-02-03', '2026-02-03T10:00', '2026-02-03T11:00', '2026-01-06', 'appt_1'],
      ['2026-02-10', '2026-02-10T10:00', '2026-02-10T11:00', '2026-01-06', 'appt_1'],
    ]);
    expect(out.every((o) => o.recurring)).toBe(true);
  });

  it('keeps a multi-day series as one entry with the days it covers', () => {
    const a = makeAppointment({
      ...weekly, startTime: { h: 22, m: 0 }, endTime: { h: 2, m: 0 }, dateSpan: 1,
      occurrenceDays: ['2026-02-03', '2026-02-04'],
    });
    const out = expandAppt(a);
    expect(out).toHaveLength(1);
    expect(out[0]!.covered_days).toEqual(['2026-02-03', '2026-02-04']);
  });

  it('keeps one entry for a series with no occurrence left this month, and for one-offs', () => {
    expect(expandAppt(makeAppointment({ ...weekly, occurrenceDays: [] }))).toHaveLength(1);
    expect(expandAppt(makeAppointment({ occurrenceDays: ['2026-05-15'] }))).toEqual([slimAppt(makeAppointment())]);
  });

  it('expands an all-day yearly item such as a birthday onto its day', () => {
    const b = makeAppointment({
      itemType: 'birthday', startDay: '2001-03-09', startTime: null, endTime: null, dateSpan: 1,
      recurrence: { rules: [{ frequency: 'Yearly' }] }, occurrenceDays: ['2026-03-09'],
    });
    expect(expandAppt(b).map((o) => [o.day, o.kind, o.series_start])).toEqual([['2026-03-09', 'birthday', '2001-03-09']]);
  });
});

describe('skippedDays', () => {
  it('leaves out occurrences that were edited (stand-ins), not deleted', () => {
    const a = makeAppointment({
      recurrence: { exdates: [{ date: '2026-01-13T07:00:00' }, { date: '2026-01-20T07:00:00', standinApptId: 'x' }] },
    });
    expect(skippedDays(a)).toEqual(['2026-01-13']);
  });
});
