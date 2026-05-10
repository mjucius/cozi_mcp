import { z } from 'zod';

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
