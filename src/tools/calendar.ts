import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  CoziClient,
  ResourceNotFoundError,
  ValidationError,
  dateSpanFromRange,
  makeAppointment,
  type CalendarDate,
  type CoziAppointment,
  type TimeOfDay,
} from '../cozi/index.js';
import { parseIsoDateTime, type ParsedDateTime } from './parsers.js';
import { slimAppt, type SlimAppointment } from './projections.js';
import type { ToolAccessMode } from './index.js';
import { toolResult } from './untrusted.js';

export async function getCalendarHandler(
  client: CoziClient,
  year: number,
  month: number,
): Promise<SlimAppointment[]> {
  const appts = await client.getCalendar(year, month);
  return appts.map(slimAppt);
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

export async function createAppointmentHandler(
  client: CoziClient,
  subject: string,
  start: string,
  end: string,
  attendees: string[] | undefined,
  allDay: boolean,
  notes: string,
  location: string | undefined,
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
    // An `end` on a later day is a multi-day event, which Cozi expresses as an
    // inclusive dateSpan rather than an end date. Dropping it here is issue #8.
    dateSpan: dateSpanFromRange(startParsed.date, endParsed.date),
  });

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
  },
): Promise<SlimAppointment> {
  const page = await client.getCalendar(year, month);
  const existing = page.find((a) => a.id === appointmentId);
  if (!existing) {
    const monthStr = String(month).padStart(2, '0');
    throw new ResourceNotFoundError(`Appointment '${appointmentId}' not found in ${year}-${monthStr}`);
  }

  const merged: CoziAppointment = { ...existing };

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
  let newEndDay: CalendarDate | undefined;
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
    newEndDay = parsed.date;
  }

  if (fields.allDay === true) {
    merged.startTime = null;
    merged.endTime = null;
  } else {
    if (newStartTime !== undefined) merged.startTime = newStartTime;
    if (newEndTime !== undefined) merged.endTime = newEndTime;
  }

  // Re-span against the POST-merge start day, so a combined start+end edit is measured
  // from the new start. A start-only move keeps the span `{ ...existing }` carried over,
  // and switching to all-day leaves it alone — multi-day all-day events are the common case.
  if (newEndDay !== undefined) {
    assertRangeOrdered(merged.startDay, merged.startTime, newEndDay, merged.endTime);
    merged.dateSpan = dateSpanFromRange(merged.startDay, newEndDay);
  }

  const result = await client.updateAppointment(merged);
  return slimAppt(result);
}

export async function deleteAppointmentHandler(
  client: CoziClient,
  appointmentId: string,
  year: number,
  month: number,
): Promise<boolean> {
  return client.deleteAppointment(appointmentId, year, month);
}

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
        'Returns: [{id, subject, day, all_day, start?, end?, end_day?, attendees?, location?, notes?}]. ' +
        '`day` is always the start day and `end_day` appears only on multi-day events; such an ' +
        'event is listed in every month it overlaps, so `day` may fall outside the month asked for.',
      inputSchema: { year: z.number().int(), month: z.number().int().min(1).max(12) },
    },
    async ({ year, month }) => {
      const result = await getCalendarHandler(await getClient(), year, month);
      return toolResult(result);
    },
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
        'For attendees, call family_members() first and pass those `id` values.',
      inputSchema: {
        subject: z.string(),
        start: z.string(),
        end: z.string(),
        attendees: z.array(z.string()).optional(),
        all_day: z.boolean().optional(),
        notes: z.string().optional(),
        location: z.string().optional(),
      },
    },
    async ({ subject, start, end, attendees, all_day, notes, location }) => {
      const result = await createAppointmentHandler(
        await getClient(),
        subject,
        start,
        end,
        attendees,
        all_day ?? false,
        notes ?? '',
        location,
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
        'made, all-day; on a timed event it is an error.',
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
      },
    },
    async ({ appointment_id, year, month, subject, start, end, attendees, all_day, notes, location }) => {
      const fields: Parameters<typeof updateAppointmentHandler>[4] = {};
      if (subject !== undefined) fields.subject = subject;
      if (start !== undefined) fields.start = start;
      if (end !== undefined) fields.end = end;
      if (attendees !== undefined) fields.attendees = attendees;
      if (all_day !== undefined) fields.allDay = all_day;
      if (notes !== undefined) fields.notes = notes;
      if (location !== undefined) fields.location = location;
      const result = await updateAppointmentHandler(await getClient(), appointment_id, year, month, fields);
      return toolResult(result);
    },
  );

  server.registerTool(
    'delete_appointment',
    {
      title: 'Delete an appointment',
      description: 'Delete an appointment. Returns true on success.',
      inputSchema: {
        appointment_id: z.string(),
        year: z.number().int(),
        month: z.number().int().min(1).max(12),
      },
    },
    async ({ appointment_id, year, month }) => {
      const result = await deleteAppointmentHandler(await getClient(), appointment_id, year, month);
      return toolResult(result);
    },
  );
}
