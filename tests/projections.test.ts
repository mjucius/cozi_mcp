import { describe, expect, it } from 'vitest';
import {
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
