import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  CoziClient,
  ResourceNotFoundError,
  makeAppointment,
  type CoziAppointment,
  type TimeOfDay,
} from '../cozi/index.js';
import { parseIsoDateTime } from './parsers.js';
import { slimAppt, type SlimAppointment } from './projections.js';
import { toolResult } from './untrusted.js';

export async function getCalendarHandler(
  client: CoziClient,
  year: number,
  month: number,
): Promise<SlimAppointment[]> {
  const appts = await client.getCalendar(year, month);
  return appts.map(slimAppt);
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

  const appt = makeAppointment({
    subject,
    startDay: startParsed.date,
    notes,
    attendees: attendees ?? [],
    location: location ?? null,
    startTime: allDay ? null : startParsed.time,
    endTime: allDay ? null : endParsed.time,
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

  let newStartTime: TimeOfDay | null | undefined;
  let newEndTime: TimeOfDay | null | undefined;
  if (fields.start) {
    const parsed = parseIsoDateTime(fields.start);
    merged.startDay = parsed.date;
    newStartTime = parsed.time;
  }
  if (fields.end) {
    const parsed = parseIsoDateTime(fields.end);
    newEndTime = parsed.time;
  }

  if (fields.allDay === true) {
    merged.startTime = null;
    merged.endTime = null;
  } else {
    if (newStartTime !== undefined) merged.startTime = newStartTime;
    if (newEndTime !== undefined) merged.endTime = newEndTime;
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
): void {
  server.registerTool(
    'get_calendar',
    {
      title: 'Get appointments for a month',
      description:
        'Appointments for one month. ' +
        'Returns: [{id, subject, day, all_day, start?, end?, attendees?, location?, notes?}].',
      inputSchema: { year: z.number().int(), month: z.number().int().min(1).max(12) },
    },
    async ({ year, month }) => {
      const result = await getCalendarHandler(await getClient(), year, month);
      return toolResult(result);
    },
  );

  server.registerTool(
    'create_appointment',
    {
      title: 'Create a calendar appointment',
      description:
        'Create a calendar appointment. `start` and `end` are ISO datetimes ' +
        "(e.g. '2026-06-15T10:00:00'). For all-day events `end` may equal `start`. " +
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
        'pass all_day=true; to switch to timed pass new start/end.',
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
