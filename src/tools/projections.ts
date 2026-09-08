import {
  CoziAppointment,
  CoziItem,
  CoziList,
  CoziPerson,
  formatTimeOfDay,
  spanEndDay,
} from '../cozi/index.js';

export interface SlimPerson {
  id: string;
  name: string;
  color?: number;
}

export interface SlimListSummary {
  id: string;
  title: string;
  type: string;
  item_count: number;
  completed_count: number;
}

export interface SlimItem {
  id: string;
  text: string;
  status: string;
  position?: number;
}

export interface SlimAppointment {
  id: string;
  subject: string;
  day: string;
  all_day: boolean;
  start?: string;
  end?: string;
  /** Last day a multi-day event covers. Omitted for ordinary single-day events. */
  end_day?: string;
  attendees?: string[];
  location?: string;
  notes?: string;
}

export function slimPerson(p: CoziPerson): SlimPerson {
  const out: SlimPerson = { id: p.id, name: p.name };
  if (p.color != null) out.color = p.color;
  return out;
}

export function slimListSummary(l: CoziList): SlimListSummary {
  let open = 0;
  let done = 0;
  for (const i of l.items) {
    if (i.status === 'incomplete') open++;
    else if (i.status === 'complete') done++;
  }
  return {
    id: l.id ?? '',
    title: l.title,
    type: l.listType,
    item_count: open + done,
    completed_count: done,
  };
}

export function slimItem(i: CoziItem): SlimItem {
  const out: SlimItem = { id: i.id ?? '', text: i.text, status: i.status };
  if (i.position != null) out.position = i.position;
  return out;
}

export function slimAppt(a: CoziAppointment): SlimAppointment {
  const day = a.startDay;
  // A multi-day event ends on day + dateSpan - 1, not on its start day. Binding `end`
  // to `day` is what made get_calendar echo a collapsed end date back (issue #8).
  const endDay = spanEndDay(day, a.dateSpan);
  const out: SlimAppointment = {
    id: a.id ?? '',
    subject: a.subject,
    day,
    all_day: a.startTime == null,
  };
  if (a.startTime) out.start = `${day}T${formatTimeOfDay(a.startTime)}`;
  if (a.endTime) out.end = `${endDay}T${formatTimeOfDay(a.endTime)}`;
  // The only span signal available for an all-day multi-day event, which carries no times.
  if (endDay !== day) out.end_day = endDay;
  if (a.attendees && a.attendees.length) out.attendees = [...a.attendees];
  if (a.location) out.location = a.location;
  if (a.notes) out.notes = a.notes;
  return out;
}
