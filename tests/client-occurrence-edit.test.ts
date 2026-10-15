import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoziClient, WriteVerificationError, type CoziAppointment } from '../src/cozi/index.js';
import { makeAppointment } from './helpers/factories.js';

// Where the changed copy of an occurrence edit is found. Cozi never returns its id,
// so the client re-reads month pages (shapes live-verified 2026-10-13/14): the
// series' new exdate names a stand-in, and a series with no day left in a month is
// not on that page at all.

afterEach(() => {
  vi.restoreAllMocks();
});

const LOGIN = { accessToken: 'tok', accountId: 'acct', expiresIn: 3600 };
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

type RawItem = Record<string, unknown>;
const item = (id: string, day: string, extra: RawItem = {}): RawItem => ({
  id,
  description: 'Dentist',
  day,
  startTime: '09:00:00',
  endTime: '09:30:00',
  dateSpan: 0,
  householdMembers: [],
  itemDetails: {},
  ...extra,
});
const weekly = (exdates: unknown[] = []): RawItem => ({
  itemDetails: { recurrence: { rules: [{ frequency: 'Weekly' }], exdates } },
});

/** Serves `pages`, keyed "YYYY-M", on GET; accepts every POST. */
function stubPages(pages: Record<string, RawItem[]>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/auth/login')) return json(LOGIN);
    const m = /\/calendar\/(\d+)\/(\d+)$/.exec(url.pathname);
    if (!m) return json([]);
    if (init?.method === 'POST') return json({});
    const items = pages[`${m[1]}-${m[2]}`] ?? [];
    return json({ items: Object.fromEntries(items.map((i) => [i.id as string, i])), days: {} });
  });
}

const series = (): CoziAppointment =>
  makeAppointment({
    id: 'ser',
    subject: 'Dentist',
    startDay: '2026-05-05',
    startTime: { h: 9, m: 0 },
    endTime: { h: 9, m: 30 },
    recurrence: { rules: [{ frequency: 'Weekly' }] },
    occurrenceDays: ['2026-05-05', '2026-05-12'],
  });

const edit = (occ: { day: string; extent: 'day' | 'forward' }, startDay = '2026-05-12') =>
  new CoziClient('u', 'p').updateAppointment({ ...series(), startDay }, { occurrence: occ });

describe('the changed copy of an occurrence edit', () => {
  it("is the stand-in the series' new exdate names, even beside a look-alike", async () => {
    stubPages({
      '2026-5': [
        item('ser', '2026-05-05', weekly([{ date: '2026-05-12T09:00:00', standinApptId: 'standin' }])),
        item('lookalike', '2026-05-12'),
        item('standin', '2026-05-12'),
      ],
    });
    expect((await edit({ day: '2026-05-12', extent: 'day' })).id).toBe('standin');
  });

  it('is matched by what was sent when the series left the page (its only day there was edited)', async () => {
    // A recurring copy and a one-off at other times are not it.
    stubPages({
      '2026-5': [
        item('standin', '2026-05-12'),
        item('other-series', '2026-05-12', weekly()),
        item('later', '2026-05-12', { startTime: '10:00:00', endTime: '10:30:00' }),
      ],
    });
    expect((await edit({ day: '2026-05-12', extent: 'day' })).id).toBe('standin');
  });

  it('is an error, not a look-alike one-off, when the series is listed but its exdate names no stand-in yet', async () => {
    // The series is on the page, so the stand-in must come from its exdate; a one-off
    // that merely matches the sent copy is somebody else's appointment.
    stubPages({
      '2026-5': [item('ser', '2026-05-05', weekly()), item('oneoff', '2026-05-12')],
    });
    await expect(edit({ day: '2026-05-12', extent: 'day' })).rejects.toBeInstanceOf(WriteVerificationError);
  });

  it("reads the occurrence's own page for the exdate when the copy was moved to another month", async () => {
    stubPages({
      '2026-5': [item('ser', '2026-05-05', weekly([{ date: '2026-05-12T09:00:00', standinApptId: 'standin' }]))],
      '2026-6': [item('standin', '2026-06-02'), item('lookalike', '2026-06-02')],
    });
    expect((await edit({ day: '2026-05-12', extent: 'day' }, '2026-06-02')).id).toBe('standin');
  });

  it('for this-and-following is the new series, not a one-off with the same subject that day', async () => {
    stubPages({
      '2026-5': [item('ser', '2026-05-05', weekly()), item('oneoff', '2026-05-12'), item('split', '2026-05-12', weekly())],
    });
    expect((await edit({ day: '2026-05-12', extent: 'forward' })).id).toBe('split');
  });

  it('is a WriteVerificationError when nothing matches', async () => {
    stubPages({ '2026-5': [item('ser', '2026-05-05', weekly())] });
    await expect(edit({ day: '2026-05-12', extent: 'day' })).rejects.toBeInstanceOf(WriteVerificationError);
  });

  it('is a WriteVerificationError when two things match, rather than a guess', async () => {
    stubPages({ '2026-5': [item('a', '2026-05-12', weekly()), item('b', '2026-05-12', weekly())] });
    await expect(edit({ day: '2026-05-12', extent: 'forward' })).rejects.toThrow(/told apart/);
  });
});

describe('the day map of a month page', () => {
  it('yields each occurrence once, by the start day Cozi names for every covered day', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/auth/login')) return json(LOGIN);
      const april = { startDay: '2026-04-30', endDay: '2026-05-02' };
      const may = { startDay: '2026-05-07', endDay: '2026-05-09' };
      return json({
        items: { ser: item('ser', '2026-04-23', weekly()), one: item('one', '2026-05-20'), odd: item('odd', '2026-05-21') },
        days: {
          // A start day in any other shape than the day keys is not taken over.
          '2026-05-21': [{ id: 'odd', multiday: { startDay: '2026-05-21T00:00:00', endDay: '2026-05-22' } }],
          '2026-05-08': [{ id: 'ser', multiday: may }],
          '2026-05-02': [{ id: 'ser', multiday: april }],
          '2026-05-01': [{ id: 'ser', multiday: april }],
          '2026-05-07': [{ id: 'ser', multiday: may }],
          '2026-05-20': [{ id: 'one' }],
        },
      });
    });
    const page = await new CoziClient('u', 'p').getCalendar(2026, 5);
    // The occurrence that began in April is listed by that day.
    expect(page.find((a) => a.id === 'ser')?.occurrenceDays).toEqual(['2026-04-30', '2026-05-07']);
    expect(page.find((a) => a.id === 'one')?.occurrenceDays).toEqual(['2026-05-20']);
    expect(page.find((a) => a.id === 'odd')?.occurrenceDays).toEqual(['2026-05-21']);
  });

  it('keeps back-to-back occurrences apart: a day two of them cover is listed by both starts', async () => {
    // A daily two-day series: Jan 8–9, Jan 9–10, … each covered day names its occurrence.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/auth/login')) return json(LOGIN);
      const occ = (start: string, end: string) => ({ id: 'run', multiday: { startDay: start, endDay: end } });
      return json({
        items: { run: item('run', '2026-01-08', weekly()) },
        days: {
          '2026-01-08': [occ('2026-01-08', '2026-01-09')],
          '2026-01-09': [occ('2026-01-08', '2026-01-09'), occ('2026-01-09', '2026-01-10')],
          '2026-01-10': [occ('2026-01-09', '2026-01-10')],
        },
      });
    });
    const page = await new CoziClient('u', 'p').getCalendar(2026, 1);
    expect(page.find((a) => a.id === 'run')?.occurrenceDays).toEqual(['2026-01-08', '2026-01-09']);
  });
});
