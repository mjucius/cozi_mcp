import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  CoziClient,
  ResourceNotFoundError,
  ValidationError,
  WriteVerificationError,
  dateSpanForLastDay,
  isRecurring,
  makeAppointment,
  type CalendarDate,
  type CoziAppointment,
  type Occurrence,
  type TimeOfDay,
} from '../cozi/index.js';
import { parseIsoDateTime, type ParsedDateTime } from './parsers.js';
import { expandAppt, slimAppt, slimSearchHit, type SlimAppointment, type SlimSearchHit } from './projections.js';
import type { ToolAccessMode } from './index.js';
import { localNow, toolResult } from './untrusted.js';

export async function getCalendarHandler(
  client: CoziClient,
  year: number,
  month: number,
): Promise<SlimAppointment[]> {
  const appts = await client.getCalendar(year, month);
  return appts.flatMap(expandAppt);
}

export async function searchCalendarHandler(
  client: CoziClient,
  query: string,
): Promise<{ appointments: SlimSearchHit[]; more?: true }> {
  const { appointments, more } = await client.searchCalendar(query);
  const today = localNow().date;
  const hits = appointments.map((a) => slimSearchHit(a, today)).sort((x, y) => x.day.localeCompare(y.day));
  return more ? { appointments: hits, more: true } : { appointments: hits };
}

const minutesOfDay = (t: TimeOfDay): number => t.h * 60 + t.m;

/**
 * Reject a range that ends before it starts, before any network call.
 *
 * Only compares times when start and end land on the SAME day: across days
 * `endTime < startTime` is perfectly ordinary (a trip leaving 17:00 on the 7th and
 * returning 15:00 on the 15th), and Cozi stores exactly that.
 */
function assertRangeOrdered(
  startDay: CalendarDate,
  startTime: TimeOfDay | null,
  endDay: CalendarDate,
  endTime: TimeOfDay | null,
): void {
  if (endDay < startDay) {
    throw new ValidationError(
      `Appointment end date ${endDay} is before its start date ${startDay}`,
    );
  }
  if (endDay === startDay && startTime && endTime && minutesOfDay(endTime) < minutesOfDay(startTime)) {
    throw new ValidationError('Appointment end time is before its start time on the same day');
  }
}

/**
 * A bare `YYYY-MM-DD` is only meaningful for an all-day appointment. On a timed one
 * it would force us to invent a time, so refuse rather than default to midnight.
 */
function assertHasTime(name: 'start' | 'end', raw: string, parsed: ParsedDateTime): void {
  if (parsed.time === null) {
    throw new ValidationError(
      `\`${name}\` '${raw}' has no time; pass all_day=true for an all-day event ` +
        `or a full ISO datetime like '${parsed.date}T10:00:00'`,
    );
  }
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

export interface RepeatInput {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval?: number | undefined;
  weekdays?: (typeof WEEKDAYS)[number][] | undefined;
  monthly_by?: 'day_of_month' | 'weekday' | undefined;
  until?: string | undefined;
}

/**
 * Cozi's recurrence for a `repeat`, anchored on the series' first day. Rule shapes
 * are the Cozi web client's (bundle main.c43180f9): Daily; Weekly with `byDay`;
 * Monthly with `byMonthDay` or an nth-weekday `byDay` such as "2TU" (-1 = last);
 * Yearly adds `byMonth`. `end: {}` is an open-ended series.
 */
export function repeatRule(r: RepeatInput, startDay: CalendarDate): Record<string, unknown> {
  const [y, m, d] = startDay.split('-').map(Number) as [number, number, number];
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
  const rule: Record<string, unknown> = {
    frequency: r.frequency[0]!.toUpperCase() + r.frequency.slice(1),
    interval: r.interval ?? 1,
  };
  if (r.weekdays && r.frequency !== 'weekly') throw new ValidationError('`weekdays` applies only to a weekly repeat');
  if (r.monthly_by && r.frequency !== 'monthly' && r.frequency !== 'yearly') {
    throw new ValidationError('`monthly_by` applies only to a monthly or yearly repeat');
  }
  if (r.frequency === 'weekly') {
    const days = r.weekdays?.length ? WEEKDAYS.filter((w) => r.weekdays!.includes(w)) : [weekday];
    if (!days.includes(weekday)) {
      throw new ValidationError(`A weekly repeat must include the start day's weekday (${weekday})`);
    }
    rule.byDay = days;
  } else if (r.frequency !== 'daily') {
    if (r.frequency === 'yearly') rule.byMonth = [m];
    if (r.monthly_by === 'weekday') {
      const nth = Math.ceil(d / 7);
      rule.byDay = [`${nth === 5 ? -1 : nth}${weekday}`];
    } else {
      rule.byMonthDay = [d];
    }
  }
  if (r.until !== undefined) {
    const until = parseIsoDateTime(r.until).date;
    if (until < startDay) throw new ValidationError(`Repeat \`until\` ${until} is before the start ${startDay}`);
    rule.end = { untilDay: until };
  } else {
    rule.end = {};
  }
  return { rules: [rule] };
}

export type Scope = 'this' | 'this_and_following' | 'series';

/** Holidays, subscribed calendars and birthdays are not ours to change. */
function assertEditable(a: CoziAppointment, id: string): void {
  if (a.readOnly) {
    throw new ValidationError(
      `Appointment '${id}' comes from a read-only calendar (a holiday or subscribed feed) and cannot be changed`,
    );
  }
  if (a.itemType && a.itemType !== 'appointment') {
    throw new ValidationError(`'${id}' is a ${a.itemType}, not an appointment; change it in the Cozi app`);
  }
}

/**
 * Which occurrences a write on `existing` should touch, or undefined for the whole
 * appointment. A recurring series needs an explicit scope: an id alone names every
 * occurrence, and get_calendar lists each occurrence under that same id, so "move
 * this one" and "move all of them" would otherwise be the same call. The occurrence
 * must be one Cozi lists on this page, never a day worked out from the rule.
 */
function resolveOccurrence(
  existing: CoziAppointment,
  id: string,
  scope: Scope | undefined,
  occurrenceDay: string | undefined,
): Occurrence | undefined {
  if (!isRecurring(existing)) {
    if ((scope && scope !== 'series') || occurrenceDay) {
      throw new ValidationError(`Appointment '${id}' is not recurring; omit \`scope\` and \`occurrence_day\``);
    }
    return undefined;
  }
  if (!scope) {
    throw new ValidationError(
      `Appointment '${id}' is a recurring series. Pass scope 'this' or 'this_and_following' with ` +
        "occurrence_day (that occurrence's `day` from get_calendar), or scope 'series' for every occurrence",
    );
  }
  if (scope === 'series') return undefined;
  if (!occurrenceDay) throw new ValidationError(`scope '${scope}' needs occurrence_day`);
  const day = parseIsoDateTime(occurrenceDay).date;
  if (!existing.occurrenceDays.includes(day)) {
    throw new ValidationError(
      `${day} is not an occurrence of '${id}' on this page; pass a \`day\` get_calendar lists for it`,
    );
  }
  if (scope === 'this_and_following' && day === existing.startDay) return undefined;
  return { day, extent: scope === 'this' ? 'day' : 'forward' };
}

async function findOnPage(client: CoziClient, id: string, year: number, month: number): Promise<CoziAppointment> {
  const existing = (await client.getCalendar(year, month)).find((a) => a.id === id);
  if (!existing) {
    const monthStr = String(month).padStart(2, '0');
    throw new ResourceNotFoundError(`Appointment '${id}' not found in ${year}-${monthStr}`);
  }
  return existing;
}

export async function createAppointmentHandler(
  client: CoziClient,
  subject: string,
  start: string,
  end: string,
  attendees: string[] | undefined,
  allDay: boolean,
  notes: string,
  location: string | undefined,
  extra: { repeat?: RepeatInput; reminders?: number[] } = {},
): Promise<SlimAppointment> {
  const startParsed = parseIsoDateTime(start);
  const endParsed = parseIsoDateTime(end);
  if (!allDay) {
    assertHasTime('start', start, startParsed);
    assertHasTime('end', end, endParsed);
  }

  const startTime = allDay ? null : startParsed.time;
  const endTime = allDay ? null : endParsed.time;
  assertRangeOrdered(startParsed.date, startTime, endParsed.date, endTime);

  const appt = makeAppointment({
    subject,
    startDay: startParsed.date,
    notes,
    attendees: attendees ?? [],
    location: location ?? null,
    startTime,
    endTime,
    // An `end` on a later day is a multi-day event, which Cozi expresses as a
    // dateSpan rather than an end date. Dropping it here is issue #8.
    dateSpan: dateSpanForLastDay(startParsed.date, endParsed.date, allDay),
  });
  if (extra.repeat) appt.recurrence = repeatRule(extra.repeat, startParsed.date);
  if (extra.reminders) appt.reminders = [...extra.reminders];

  const created = await client.createAppointment(appt);
  return slimAppt(created);
}

export async function updateAppointmentHandler(
  client: CoziClient,
  appointmentId: string,
  year: number,
  month: number,
  fields: {
    subject?: string;
    start?: string;
    end?: string;
    attendees?: string[];
    allDay?: boolean;
    notes?: string;
    location?: string;
    scope?: Scope;
    occurrenceDay?: string;
    repeat?: RepeatInput;
    reminders?: number[];
  },
): Promise<SlimAppointment> {
  const existing = await findOnPage(client, appointmentId, year, month);
  assertEditable(existing, appointmentId);
  const occurrence = resolveOccurrence(existing, appointmentId, fields.scope, fields.occurrenceDay);
  if (occurrence && fields.repeat) {
    throw new ValidationError("`repeat` changes a whole series; pass scope 'series' to change the rule");
  }

  // An occurrence edit starts from that occurrence: same times and length as the
  // series, on its own day. `start`/`end` below then move it as they would a one-off.
  const merged: CoziAppointment = { ...existing, ...(occurrence ? { startDay: occurrence.day } : {}) };

  if (fields.subject !== undefined) merged.subject = fields.subject;
  if (fields.notes !== undefined) merged.notes = fields.notes;
  if (fields.location !== undefined) merged.location = fields.location;
  if (fields.attendees !== undefined) merged.attendees = [...fields.attendees];

  // Bare dates are accepted only when the result is all-day: either the caller asked
  // for it, or the event already is and they did not say otherwise. A timed event
  // must not be silently converted by an untimed edit.
  const effectiveAllDay = fields.allDay ?? existing.startTime === null;

  let newStartTime: TimeOfDay | null | undefined;
  let newEndTime: TimeOfDay | null | undefined;
  let newLastDay: CalendarDate | undefined;
  if (fields.start) {
    const parsed = parseIsoDateTime(fields.start);
    if (!effectiveAllDay) assertHasTime('start', fields.start, parsed);
    merged.startDay = parsed.date;
    newStartTime = parsed.time;
  }
  if (fields.end) {
    const parsed = parseIsoDateTime(fields.end);
    if (!effectiveAllDay) assertHasTime('end', fields.end, parsed);
    newEndTime = parsed.time;
    newLastDay = parsed.date;
  }

  if (fields.allDay === true) {
    merged.startTime = null;
    merged.endTime = null;
  } else {
    if (newStartTime !== undefined) merged.startTime = newStartTime;
    if (newEndTime !== undefined) merged.endTime = newEndTime;
  }

  // `dateSpan` is a day offset from the start day (models.ts), so a start-only move
  // and an unrelated edit keep the event's length by carrying it over untouched.
  // It is recomputed only when the last day is given, measured from the POST-merge
  // start day and all-day-ness — or when a timed event becomes all-day, in which
  // case it now covers the whole of the day it used to end partway through.
  const mergedAllDay = merged.startTime === null;
  if (newLastDay !== undefined) {
    assertRangeOrdered(merged.startDay, merged.startTime, newLastDay, merged.endTime);
    merged.dateSpan = dateSpanForLastDay(merged.startDay, newLastDay, mergedAllDay);
  } else if (mergedAllDay && existing.endTime !== null) {
    merged.dateSpan += 1;
  }

  if (fields.repeat) merged.recurrence = repeatRule(fields.repeat, merged.startDay);

  const opts: Parameters<CoziClient['updateAppointment']>[1] = {};
  if (occurrence) opts.occurrence = occurrence;
  if (fields.reminders) opts.reminders = [...fields.reminders];
  const result = await client.updateAppointment(merged, opts);
  return slimAppt(result);
}

export async function deleteAppointmentHandler(
  client: CoziClient,
  appointmentId: string,
  year: number,
  month: number,
  opts: { scope?: Scope; occurrenceDay?: string } = {},
): Promise<boolean> {
  // Cozi's delete takes only an id and treats an unknown one as a silent success, so
  // the (year, month) page is read first. That tells the caller when the id is not
  // there and, the reason this lookup exists, whether the id names a recurring
  // series: deleting a series id removes every occurrence, past and future, without
  // any warning, so a series needs an explicit scope (see resolveOccurrence).
  const existing = await findOnPage(client, appointmentId, year, month);
  assertEditable(existing, appointmentId);
  const occurrence = resolveOccurrence(existing, appointmentId, opts.scope, opts.occurrenceDay);
  await client.deleteAppointment(appointmentId, year, month, occurrence);
  if (!occurrence) return true;

  // Cozi answers 200 whatever it did, so read the series back: the one occurrence must
  // be gone from the page, or the series must now end before it.
  const after = (await client.getCalendar(year, month)).find((a) => a.id === appointmentId);
  const applied =
    !after ||
    (occurrence.extent === 'day'
      ? !after.occurrenceDays.includes(occurrence.day)
      : after.endDay !== null && after.endDay < occurrence.day);
  if (!applied) {
    throw new WriteVerificationError(
      `Cozi did not remove the occurrence of '${appointmentId}' on ${occurrence.day}`,
    );
  }
  return true;
}

const RepeatSchema = z
  .object({
    frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    interval: z.number().int().min(1).optional(),
    weekdays: z.array(z.enum(WEEKDAYS)).optional(),
    monthly_by: z.enum(['day_of_month', 'weekday']).optional(),
    until: z.string().optional(),
  })
  .describe(
    'Make it repeat. `interval` 2 = every other day/week/month/year. Weekly: `weekdays` ' +
      "(e.g. ['MO','WE']; default the start's weekday, which must be included). Monthly/yearly: " +
      "`monthly_by` 'day_of_month' (default, e.g. the 15th) or 'weekday' (e.g. the 2nd Tuesday; a " +
      "5th weekday means the last). `until` is the last possible day (YYYY-MM-DD); omit it to repeat forever.",
  );
const RemindersSchema = z
  .array(z.number().int().min(0))
  .describe('Reminder lead times in minutes before the start, e.g. [30, 1440]. [] clears them on an update.');
const ScopeSchema = z
  .enum(['this', 'this_and_following', 'series'])
  .describe(
    "Required for a recurring series: 'this' = only the occurrence on occurrence_day, " +
      "'this_and_following' = that occurrence and every later one, 'series' = every occurrence.",
  );
const OccurrenceDaySchema = z
  .string()
  .describe("With scope 'this' or 'this_and_following': the occurrence's `day` as get_calendar lists it.");

export function registerCalendarTools(
  server: McpServer,
  getClient: () => Promise<CoziClient>,
  accessMode: ToolAccessMode = 'read-write',
): void {
  server.registerTool(
    'get_calendar',
    {
      title: 'Get appointments for a month',
      description:
        'Appointments for one month. ' +
        'Returns: [{id, subject, day, all_day, start?, end?, end_day?, attendees?, location?, notes?, ' +
        'reminders?, kind?, read_only?, source?, recurring?, recurrence?, series_start?, series_end?, ' +
        'skipped_days?, covered_days?}]. ' +
        '`day` is the day the entry happens; `end_day` appears only on multi-day events, which are ' +
        'listed in every month they overlap, so `day` may fall outside the month asked for. ' +
        'A recurring series (`recurring: true`) is listed once per occurrence in the month, as Cozi ' +
        'itself expands it: each entry carries the series `id`, its own `day`, and `series_start`. ' +
        'Occurrences deleted in Cozi are already left out (and named in `skipped_days`). A multi-day ' +
        'recurring series is instead ONE entry whose `covered_days` lists every day it covers this ' +
        'month. `kind` marks items that are not plain appointments (e.g. "birthday"); `read_only` ' +
        'items (holidays, subscribed calendars, with `source` naming the calendar) cannot be changed. ' +
        '`reminders` are minutes before the start.',
      inputSchema: { year: z.number().int(), month: z.number().int().min(1).max(12) },
    },
    async ({ year, month }) => {
      const result = await getCalendarHandler(await getClient(), year, month);
      return toolResult(result);
    },
  );

  server.registerTool(
    'search_calendar',
    {
      title: 'Search the calendar',
      description:
        'Find appointments by words in their subject, across months (Cozi\'s own search, the one in ' +
        'its app). Use it for "when is the dentist?" instead of paging through months. ' +
        'Returns: {appointments: [{...same fields as get_calendar, last_day?, next_days?}], more?}. ' +
        'A recurring series is one entry with `last_day` (latest past occurrence) and `next_days` ' +
        '(up to 10 upcoming). Cozi searches from a few years back onward, and an appointment created ' +
        'in the last few seconds may not be found yet; `more: true` means it found more than this ' +
        'first page, so narrow the query.',
      inputSchema: { query: z.string() },
    },
    async ({ query }) => toolResult(await searchCalendarHandler(await getClient(), query)),
  );

  server.registerTool(
    'today',
    {
      title: "Today's date in the user's timezone",
      description:
        "Current date, weekday and time on the user's machine. Returns: {date, weekday, time, timezone}. " +
        "Call it before turning 'tomorrow' or 'this Saturday' into the ISO dates the calendar tools take " +
        'when you have not called another Cozi tool yet; every Cozi tool result also carries this time.',
      inputSchema: {},
    },
    async () => toolResult(localNow()),
  );

  if (accessMode === 'read-only') {
    return;
  }

  server.registerTool(
    'create_appointment',
    {
      title: 'Create a calendar appointment',
      description:
        'Create a calendar appointment. `start` and `end` are ISO datetimes ' +
        "(e.g. '2026-06-15T10:00:00'). For all-day events (all_day=true) a bare date " +
        "(e.g. '2026-06-15') is also accepted and `end` may equal `start`; a bare date " +
        'on a timed event is an error. ' +
        'For a multi-day event put `end` on a later date — the span is preserved, and the ' +
        'result reports it as `end_day`. `end` before `start` is an error. ' +
        'For attendees, call family_members() first and pass those `id` values. ' +
        'For a repeating event pass `repeat`; `start`/`end` are then its first occurrence.',
      inputSchema: {
        subject: z.string(),
        start: z.string(),
        end: z.string(),
        attendees: z.array(z.string()).optional(),
        all_day: z.boolean().optional(),
        notes: z.string().optional(),
        location: z.string().optional(),
        repeat: RepeatSchema.optional(),
        reminders: RemindersSchema.optional(),
      },
    },
    async ({ subject, start, end, attendees, all_day, notes, location, repeat, reminders }) => {
      const result = await createAppointmentHandler(
        await getClient(),
        subject,
        start,
        end,
        attendees,
        all_day ?? false,
        notes ?? '',
        location,
        { ...(repeat ? { repeat } : {}), ...(reminders ? { reminders } : {}) },
      );
      return toolResult(result);
    },
  );

  server.registerTool(
    'update_appointment',
    {
      title: 'Partial-update an appointment',
      description:
        'Partial-update an appointment. The Cozi PUT semantics replace ALL fields, so this tool ' +
        'first fetches the existing appointment from the (year, month) page and merges your ' +
        'changes — only fields you pass are altered. To switch a timed appointment to all-day ' +
        'pass all_day=true; to switch to timed pass new start/end. Passing `end` re-spans the ' +
        'event against its (possibly newly set) start day, so an `end` on a later date makes it ' +
        'multi-day and one on the start day collapses it back; passing `start` alone moves the ' +
        'event and keeps its length, and all_day=true preserves the span. A bare date ' +
        "(e.g. '2026-06-15') is accepted for `start`/`end` when the event is, or is being " +
        'made, all-day; on a timed event it is an error. ' +
        'A recurring series (`recurring: true` in get_calendar) needs `scope`: \'this\' changes only ' +
        "the occurrence on `occurrence_day` (Cozi stores it as its own appointment, returned here), " +
        "'this_and_following' changes it and every later one (returned as the new series), 'series' " +
        'changes every occurrence and keeps the rule unless `repeat` replaces it. `repeat` also turns ' +
        'a one-off into a series. Holidays, subscribed calendars and birthdays cannot be changed.',
      inputSchema: {
        appointment_id: z.string(),
        year: z.number().int(),
        month: z.number().int().min(1).max(12),
        subject: z.string().optional(),
        start: z.string().optional(),
        end: z.string().optional(),
        attendees: z.array(z.string()).optional(),
        all_day: z.boolean().optional(),
        notes: z.string().optional(),
        location: z.string().optional(),
        scope: ScopeSchema.optional(),
        occurrence_day: OccurrenceDaySchema.optional(),
        repeat: RepeatSchema.optional(),
        reminders: RemindersSchema.optional(),
      },
    },
    async (args) => {
      const { appointment_id, year, month, subject, start, end, attendees, all_day, notes, location } = args;
      const fields: Parameters<typeof updateAppointmentHandler>[4] = {};
      if (subject !== undefined) fields.subject = subject;
      if (start !== undefined) fields.start = start;
      if (end !== undefined) fields.end = end;
      if (attendees !== undefined) fields.attendees = attendees;
      if (all_day !== undefined) fields.allDay = all_day;
      if (notes !== undefined) fields.notes = notes;
      if (location !== undefined) fields.location = location;
      if (args.scope !== undefined) fields.scope = args.scope;
      if (args.occurrence_day !== undefined) fields.occurrenceDay = args.occurrence_day;
      if (args.repeat !== undefined) fields.repeat = args.repeat;
      if (args.reminders !== undefined) fields.reminders = args.reminders;
      const result = await updateAppointmentHandler(await getClient(), appointment_id, year, month, fields);
      return toolResult(result);
    },
  );

  server.registerTool(
    'delete_appointment',
    {
      title: 'Delete an appointment',
      description:
        'Delete an appointment. Returns true on success; errors if the id is not on the ' +
        '(year, month) page. A recurring series (`recurring: true` in get_calendar) needs `scope`: ' +
        "'this' removes only the occurrence on `occurrence_day`, 'this_and_following' ends the series " +
        "before it, 'series' removes every occurrence, past and future. Confirm a 'series' delete with " +
        'the user first. Holidays, subscribed calendars and birthdays cannot be deleted.',
      inputSchema: {
        appointment_id: z.string(),
        year: z.number().int(),
        month: z.number().int().min(1).max(12),
        scope: ScopeSchema.optional(),
        occurrence_day: OccurrenceDaySchema.optional(),
      },
    },
    async ({ appointment_id, year, month, scope, occurrence_day }) => {
      const result = await deleteAppointmentHandler(await getClient(), appointment_id, year, month, {
        ...(scope ? { scope } : {}),
        ...(occurrence_day ? { occurrenceDay: occurrence_day } : {}),
      });
      return toolResult(result);
    },
  );
}
