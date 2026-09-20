import { z } from 'zod';

import { ValidationError } from './errors.js';

export const ListType = { SHOPPING: 'shopping', TODO: 'todo' } as const;
export type ListType = (typeof ListType)[keyof typeof ListType];
export const ListTypeSchema = z.enum(['shopping', 'todo']);

export const ItemStatus = { COMPLETE: 'complete', INCOMPLETE: 'incomplete' } as const;
export type ItemStatus = (typeof ItemStatus)[keyof typeof ItemStatus];
export const ItemStatusSchema = z.enum(['complete', 'incomplete']);

export type CalendarDate = string;
export interface TimeOfDay {
  h: number;
  m: number;
  s?: number;
}

const dateTimeStringToDate = (v: unknown): Date | null => {
  if (v instanceof Date) return v;
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v.endsWith('Z') ? v : v.replace(/([+-]\d{2}:?\d{2})?$/, (m) => m || ''));
  return isNaN(d.getTime()) ? null : d;
};

const calendarDateString = (v: unknown): CalendarDate | null => {
  if (typeof v !== 'string' || !v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

const todayCalendarDate = (): CalendarDate => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// Cozi's `dateSpan` is a day OFFSET: an appointment's end instant is `day + dateSpan`
// days later, at `endTime`. One rule for timed and all-day events alike.
//
//   timed   09:00 -> 17:00 same day          dateSpan 0 (Cozi usually omits the field)
//   timed   20:00 -> 02:00 the next morning  dateSpan 1
//   all-day one day                          dateSpan 1
//   all-day Jul 30 -> Aug 2 (4 days)         dateSpan 4
//
// The all-day values are not a different convention. An all-day event is stored as
// 00:00:00 -> 00:00:00, so its end instant is the midnight AFTER its last covered
// day — exactly iCal's exclusive DTEND. People name an all-day event by its last
// covered day, so the +1 on the way in and the -1 on the way out live in the two
// helpers below and nowhere else.
//
// Established 2026-09-20 by write-then-observe against live Cozi (issue #12): the
// server lists a spanning appointment on every month page its [day, day + dateSpan]
// range touches, and a timed same-day event written with dateSpan 1 is paged onto
// the following month — i.e. Cozi reads it as two days. 2.2.0/2.2.1 sent exactly
// that, having misread the field as an inclusive count from a read-only survey.
// `tests/live/calendar.test.ts` pins these semantics against the real API.
//
// Day arithmetic is done in UTC so a DST transition can never shift a result by a day.
const DAY_MS = 86_400_000;

const calendarDateToUtcMs = (d: CalendarDate): number => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) throw new ValidationError(`Invalid calendar date: ${JSON.stringify(d)}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
};

const utcMsToCalendarDate = (ms: number): CalendarDate => {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
};

/**
 * Last calendar day an appointment covers. For an all-day event that is the day
 * before its (exclusive) end instant; a missing/zero all-day span is treated as one day.
 */
export function lastDayOf(startDay: CalendarDate, dateSpan: number, allDay: boolean): CalendarDate {
  const span = Number.isFinite(dateSpan) ? dateSpan : 0;
  const offset = Math.max(span - (allDay ? 1 : 0), 0);
  return utcMsToCalendarDate(calendarDateToUtcMs(startDay) + offset * DAY_MS);
}

/** Cozi `dateSpan` for an appointment whose last covered day is `lastDay`. */
export function dateSpanForLastDay(startDay: CalendarDate, lastDay: CalendarDate, allDay: boolean): number {
  const diff = Math.round((calendarDateToUtcMs(lastDay) - calendarDateToUtcMs(startDay)) / DAY_MS);
  return Math.max(diff, 0) + (allDay ? 1 : 0);
}

const parseTimeOfDay = (v: unknown): TimeOfDay | null => {
  if (v == null) return null;
  if (typeof v === 'object' && v !== null && 'h' in v && 'm' in v) return v as TimeOfDay;
  if (typeof v !== 'string') return null;
  const parts = v.split(':');
  if (parts.length < 2) return null;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  const s = parts.length > 2 ? Number(parts[2]) : 0;
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) return null;
  return s ? { h, m, s } : { h, m };
};

const optionalDateTime = z.preprocess(dateTimeStringToDate, z.date().nullable()).optional();

const CoziPersonRaw = z
  .object({
    accountPersonId: z.string().optional(),
    id: z.string().optional(),
    name: z.string().default(''),
    email: z.string().nullable().optional(),
    phoneNumberKey: z.string().nullable().optional(),
    colorIndex: z.number().int().nullable().optional(),
    emailStatus: z.string().nullable().optional(),
    isAdult: z.boolean().nullable().optional(),
    accountPersonType: z.string().nullable().optional(),
    accountCreator: z.boolean().nullable().optional(),
    notifiable: z.boolean().nullable().optional(),
    version: z.number().int().nullable().optional(),
    settings: z.record(z.string(), z.unknown()).nullable().optional(),
    notifiableFeatures: z.array(z.string()).nullable().optional(),
  })
  .passthrough();

export const CoziPersonSchema = CoziPersonRaw.transform((raw) => {
  const id = raw.accountPersonId ?? raw.id ?? '';
  return {
    id,
    name: raw.name,
    email: raw.email ?? null,
    phone: raw.phoneNumberKey ?? null,
    color: raw.colorIndex ?? null,
    emailStatus: raw.emailStatus ?? null,
    isAdult: raw.isAdult ?? null,
    accountPersonType: raw.accountPersonType ?? null,
    accountCreator: raw.accountCreator ?? null,
    notifiable: raw.notifiable ?? null,
    version: raw.version ?? null,
    settings: raw.settings ?? null,
    notifiableFeatures: raw.notifiableFeatures ?? null,
  };
});
export type CoziPerson = z.infer<typeof CoziPersonSchema>;

const CoziItemRaw = z
  .object({
    itemId: z.string().nullable().optional(),
    id: z.string().nullable().optional(),
    text: z.string().default(''),
    status: z.string().default('incomplete'),
    position: z.number().int().nullable().optional(),
    itemType: z.string().nullable().optional(),
    dueDate: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    owner: z.string().nullable().optional(),
    version: z.number().int().nullable().optional(),
    createdAt: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
  })
  .passthrough();

export const CoziItemSchema = CoziItemRaw.transform((raw) => ({
  id: raw.itemId ?? raw.id ?? null,
  text: raw.text,
  status: (raw.status === 'complete' ? 'complete' : 'incomplete') as ItemStatus,
  position: raw.position ?? null,
  itemType: raw.itemType ?? null,
  dueDate: calendarDateString(raw.dueDate),
  notes: raw.notes ?? null,
  owner: raw.owner ?? null,
  version: raw.version ?? null,
  createdAt: dateTimeStringToDate(raw.createdAt),
  updatedAt: dateTimeStringToDate(raw.updatedAt),
}));
export type CoziItem = z.infer<typeof CoziItemSchema>;

const CoziListRaw = z
  .object({
    listId: z.string().nullable().optional(),
    id: z.string().nullable().optional(),
    title: z.string().default(''),
    listType: z.string().default('todo'),
    items: z.array(z.unknown()).default([]),
    owner: z.string().nullable().optional(),
    version: z.number().int().nullable().optional(),
    notes: z.string().nullable().optional(),
    createdAt: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
  })
  .passthrough();

export const CoziListSchema = CoziListRaw.transform((raw) => ({
  id: raw.listId ?? raw.id ?? null,
  title: raw.title,
  listType: (raw.listType === 'shopping' ? 'shopping' : 'todo') as ListType,
  items: raw.items.map((it) => CoziItemSchema.parse(it)),
  owner: raw.owner ?? null,
  version: raw.version ?? null,
  notes: raw.notes ?? null,
  createdAt: dateTimeStringToDate(raw.createdAt),
  updatedAt: dateTimeStringToDate(raw.updatedAt),
}));
export type CoziList = z.infer<typeof CoziListSchema>;

const CoziAppointmentRaw = z
  .object({
    id: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    descriptionShort: z.string().nullable().optional(),
    day: z.string().nullable().optional(),
    startTime: z.string().nullable().optional(),
    endTime: z.string().nullable().optional(),
    dateSpan: z.number().int().default(0),
    householdMembers: z.array(z.string()).default([]),
    location: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    notesHtml: z.string().nullable().optional(),
    notesPlain: z.string().nullable().optional(),
    itemType: z.string().nullable().optional(),
    itemVersion: z.number().int().nullable().optional(),
    recurrence: z.record(z.string(), z.unknown()).nullable().optional(),
    recurrenceStartDay: z.string().nullable().optional(),
    endDay: z.string().nullable().optional(),
    readOnly: z.boolean().nullable().optional(),
    itemSource: z.string().nullable().optional(),
    householdMember: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    birthYear: z.number().int().nullable().optional(),
    createdAt: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
    itemDetails: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .passthrough();

const ApptPreprocess = z.preprocess((value) => {
  if (typeof value !== 'object' || value === null) return value;
  const v = { ...(value as Record<string, unknown>) };
  const details = v.itemDetails;
  if (details && typeof details === 'object') {
    for (const [key, val] of Object.entries(details as Record<string, unknown>)) {
      if (v[key] === undefined || v[key] === null) v[key] = val;
    }
  }
  if (!v.description && v.descriptionShort) v.description = v.descriptionShort;
  return v;
}, CoziAppointmentRaw);

export const CoziAppointmentSchema = ApptPreprocess.transform((raw) => ({
  id: raw.id ?? null,
  subject: raw.description ?? '',
  startDay: calendarDateString(raw.day) ?? todayCalendarDate(),
  startTime: parseTimeOfDay(raw.startTime),
  endTime: parseTimeOfDay(raw.endTime),
  dateSpan: raw.dateSpan ?? 0,
  attendees: raw.householdMembers ?? [],
  location: raw.location ?? null,
  notes: raw.notes ?? null,
  notesHtml: raw.notesHtml ?? null,
  notesPlain: raw.notesPlain ?? null,
  itemType: raw.itemType ?? null,
  itemVersion: raw.itemVersion ?? null,
  descriptionShort: raw.descriptionShort ?? null,
  recurrence: raw.recurrence ?? null,
  recurrenceStartDay: raw.recurrenceStartDay ?? null,
  endDay: raw.endDay ?? null,
  readOnly: raw.readOnly ?? null,
  itemSource: raw.itemSource ?? null,
  householdMember: raw.householdMember ?? null,
  name: raw.name ?? null,
  birthYear: raw.birthYear ?? null,
  createdAt: dateTimeStringToDate(raw.createdAt),
  updatedAt: dateTimeStringToDate(raw.updatedAt),
}));
export type CoziAppointment = z.infer<typeof CoziAppointmentSchema>;

export interface CoziAppointmentInput {
  id?: string | null;
  subject: string;
  startDay: CalendarDate;
  startTime?: TimeOfDay | null;
  endTime?: TimeOfDay | null;
  dateSpan?: number;
  attendees?: string[];
  location?: string | null;
  notes?: string | null;
}

export function makeAppointment(input: CoziAppointmentInput): CoziAppointment {
  return {
    id: input.id ?? null,
    subject: input.subject,
    startDay: input.startDay,
    startTime: input.startTime ?? null,
    endTime: input.endTime ?? null,
    dateSpan: input.dateSpan ?? 0,
    attendees: input.attendees ?? [],
    location: input.location ?? null,
    notes: input.notes ?? null,
    notesHtml: null,
    notesPlain: null,
    itemType: null,
    itemVersion: null,
    descriptionShort: null,
    recurrence: null,
    recurrenceStartDay: null,
    endDay: null,
    readOnly: null,
    itemSource: null,
    householdMember: null,
    name: null,
    birthYear: null,
    createdAt: null,
    updatedAt: null,
  };
}

export function formatTimeOfDay(t: TimeOfDay): string {
  return `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}`;
}
