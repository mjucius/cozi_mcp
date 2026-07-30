import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoziClient, toApiEditFormat } from '../src/cozi/index.js';
import { HttpClient } from '../src/cozi/http.js';
import { makeAppointment } from './helpers/factories.js';

// VULN-005 (CWE-573): update_appointment must not silently destroy a recurring
// appointment's rule. Two layers are asserted:
//   1. the read path (parseCalendarItem, via getCalendar) carries recurrence through;
//   2. the write builder (toApiEditFormat) re-sends it.
//
// The fixture below mirrors the REAL Cozi wire shape, verified against 133 live
// appointments on 2026-07-24:
//   - recurrence, recurrenceStartDay, readOnly  -> inside itemDetails
//   - itemVersion                               -> top level
//   - endDay                                    -> nested INSIDE the recurrence object
// Reading these from the top level (as an earlier revision did) silently yields null
// for every real appointment, which is what made the "fix" a no-op in production.

afterEach(() => {
  vi.restoreAllMocks();
});

const REAL_SHAPE_ITEM = {
  id: 'itm1',
  description: 'Weekly standup',
  day: '2026-05-15',
  startTime: '10:00:00',
  endTime: '10:30:00',
  itemVersion: 3175,
  itemDetails: {
    location: 'Room 1',
    notes: 'standing agenda',
    readOnly: false,
    recurrenceStartDay: '2026-05-01',
    recurrence: {
      exdates: [{ date: '2026-05-22T10:00:00' }],
      endDay: '2026-12-31',
      text: ['Every weekday', ' until Dec 31, 2026'],
    },
  },
};

describe('read path preserves recurrence (real wire shape)', () => {
  it('getCalendar reads recurrence from itemDetails, not the top level', async () => {
    vi.spyOn(HttpClient.prototype, 'request').mockImplementation(async (opts) => {
      if (opts.endpoint.includes('/auth/login')) {
        return { accessToken: 'tok', accountId: 'acct_1' };
      }
      return { items: { itm1: REAL_SHAPE_ITEM } };
    });

    const client = new CoziClient('user', 'pass');
    const appts = await client.getCalendar(2026, 5);
    expect(appts).toHaveLength(1);
    const appt = appts[0]!;

    expect(appt.recurrence).toEqual(REAL_SHAPE_ITEM.itemDetails.recurrence);
    expect(appt.recurrenceStartDay).toBe('2026-05-01');
    // endDay is derived from recurrence.endDay — it is not a standalone wire field.
    expect(appt.endDay).toBe('2026-12-31');
    expect(appt.itemVersion).toBe(3175);
    expect(appt.readOnly).toBe(false);
  });

  it('does NOT read recurrence from the top level (guards the old wrong assumption)', async () => {
    vi.spyOn(HttpClient.prototype, 'request').mockImplementation(async (opts) => {
      if (opts.endpoint.includes('/auth/login')) {
        return { accessToken: 'tok', accountId: 'acct_1' };
      }
      // Top-level recurrence keys, as an earlier revision wrongly expected. Cozi
      // never sends them here, so these must be ignored rather than trusted.
      return {
        items: {
          itm2: {
            id: 'itm2',
            description: 'Decoy',
            day: '2026-05-16',
            recurrence: { should: 'be ignored' },
            recurrenceStartDay: '1999-01-01',
            itemDetails: {},
          },
        },
      };
    });

    const client = new CoziClient('user', 'pass');
    const appt = (await client.getCalendar(2026, 5))[0]!;
    expect(appt.recurrence).toBeNull();
    expect(appt.recurrenceStartDay).toBeNull();
  });
});

describe('write path re-sends recurrence', () => {
  // Expected shape captured from the real Cozi web client (DevTools, 2026-07-24):
  //   edit: { id, startDay, recurrence: {...}, details: {...} }
  // recurrence is a SIBLING of details, not inside it. Getting this wrong flattens
  // the series — which is the exact bug VULN-005 is about.
  it('toApiEditFormat puts recurrence at the EDIT level, not inside details', () => {
    const appt = {
      ...makeAppointment({ id: 'itm1', subject: 'Weekly standup', startDay: '2026-05-15' }),
      recurrence: REAL_SHAPE_ITEM.itemDetails.recurrence,
      recurrenceStartDay: '2026-05-01',
      endDay: '2026-12-31',
      itemVersion: 3175,
    };

    const payload = toApiEditFormat(appt) as {
      edit: { id: string; itemVersion?: number; recurrence?: unknown; details: Record<string, unknown> };
    };
    expect(payload.edit.id).toBe('itm1');
    expect(payload.edit.recurrence).toEqual(REAL_SHAPE_ITEM.itemDetails.recurrence);
    // Must NOT be nested under details — that placement silently loses the rule.
    expect('recurrence' in payload.edit.details).toBe(false);

    // The web client sends neither of these on edit; the server derives them.
    expect('recurrenceStartDay' in payload.edit).toBe(false);
    expect('endDay' in payload.edit).toBe(false);

    // itemVersion must NEVER be sent: live Cozi silently discards the whole edit
    // when it is present (verified 2026-07-24).
    expect('itemVersion' in payload.edit).toBe(false);
  });

  it('omits recurrence entirely for a genuinely non-recurring appointment', () => {
    const appt = makeAppointment({ id: 'itm2', subject: 'One-off', startDay: '2026-05-15' });
    const payload = toApiEditFormat(appt) as {
      edit: { itemVersion?: number; recurrence?: unknown; details: Record<string, unknown> };
    };
    expect('recurrence' in payload.edit).toBe(false);
    expect('recurrence' in payload.edit.details).toBe(false);
    expect('itemVersion' in payload.edit).toBe(false);
  });
});
