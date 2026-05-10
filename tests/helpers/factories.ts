import type {
  CalendarDate,
  CoziAppointment,
  CoziItem,
  CoziList,
  CoziPerson,
  TimeOfDay,
} from '../../src/cozi/index.js';

interface PersonInput {
  id?: string;
  name?: string;
  color?: number | null;
  email?: string | null;
}
export function makePerson(input: PersonInput = {}): CoziPerson {
  return {
    id: input.id ?? 'person_1',
    name: input.name ?? 'Alice',
    color: input.color === undefined ? 3 : input.color,
    email: input.email === undefined ? 'alice@example.com' : input.email,
    phone: '555-0100',
    emailStatus: null,
    isAdult: true,
    accountPersonType: null,
    accountCreator: null,
    notifiable: true,
    version: null,
    settings: null,
    notifiableFeatures: null,
  };
}

interface ItemInput {
  id?: string | null;
  text?: string;
  status?: 'complete' | 'incomplete';
  position?: number | null;
}
export function makeItem(input: ItemInput = {}): CoziItem {
  return {
    id: input.id === undefined ? 'item_1' : input.id,
    text: input.text ?? 'Milk',
    status: input.status ?? 'incomplete',
    position: input.position === undefined ? 0 : input.position,
    itemType: null,
    dueDate: null,
    notes: null,
    owner: null,
    version: null,
    createdAt: null,
    updatedAt: null,
  };
}

interface ListInput {
  id?: string | null;
  title?: string;
  listType?: 'shopping' | 'todo';
  items?: CoziItem[];
}
export function makeList(input: ListInput = {}): CoziList {
  return {
    id: input.id === undefined ? 'list_1' : input.id,
    title: input.title ?? 'Groceries',
    listType: input.listType ?? 'shopping',
    items: input.items ?? [],
    owner: null,
    version: null,
    notes: null,
    createdAt: null,
    updatedAt: null,
  };
}

interface AppointmentInput {
  id?: string | null;
  subject?: string;
  startDay?: CalendarDate;
  startTime?: TimeOfDay | null;
  endTime?: TimeOfDay | null;
  attendees?: string[];
  location?: string | null;
  notes?: string | null;
}
export function makeAppointment(input: AppointmentInput = {}): CoziAppointment {
  return {
    id: input.id === undefined ? 'appt_1' : input.id,
    subject: input.subject ?? 'Soccer practice',
    startDay: input.startDay ?? '2026-05-15',
    startTime: input.startTime === undefined ? { h: 10, m: 0 } : input.startTime,
    endTime: input.endTime === undefined ? { h: 11, m: 0 } : input.endTime,
    dateSpan: 0,
    attendees: input.attendees ?? ['alice', 'bob'],
    location: input.location === undefined ? 'Field B' : input.location,
    notes: input.notes === undefined ? 'Bring water' : input.notes,
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
