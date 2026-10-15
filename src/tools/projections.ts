import {
  CoziAppointment,
  CoziItem,
  CoziList,
  CoziPerson,
  formatTimeOfDay,
  isRecurring,
  lastDayOf,
  recurrenceText,
  skippedDays,
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
  /** A section heading inside the list (e.g. "PRODUCE"), not something to buy or do. */
  header?: true;
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
  /**
   * Present (and `true`) only on a recurring series. Cozi returns a series as ONE
   * entry standing for every occurrence, so an update or delete of this `id`
   * affects all of them — which is why the flag is surfaced at all.
   */
  recurring?: true;
  /** Cozi's own wording of the rule, e.g. "Every week on Friday until Feb 15, 2019". */
  recurrence?: string;
  /** Last day of a bounded series. Omitted when the series is open-ended. */
  series_end?: string;
  /**
   * Days on which a single occurrence of the series was deleted in Cozi. The rule
   * still names them, but nothing happens on them. Omitted when there are none.
   */
  skipped_days?: string[];
  /**
   * First day of the series this occurrence belongs to. Present when a recurring
   * series is listed once per occurrence, so `day` is the occurrence, not the start.
   */
  series_start?: string;
  /** Item type when it is not a plain appointment, e.g. "birthday". */
  kind?: string;
  /** Cozi will not let this item be changed here (a holiday or subscribed calendar). */
  read_only?: true;
  /** Calendar the item comes from when it is not the family's own, e.g. a holiday feed. */
  source?: string;
  /** Reminder lead times, in minutes before the start. */
  reminders?: number[];
}

export function slimPerson(p: CoziPerson): SlimPerson {
  const out: SlimPerson = { id: p.id, name: p.name };
  if (p.color != null) out.color = p.color;
  return out;
}

// Cozi's itemType for a list section heading (web client bundle main.c43180f9).
const HEADER = 'header';

export function slimListSummary(l: CoziList): SlimListSummary {
  let open = 0;
  let done = 0;
  for (const i of l.items) {
    if (i.itemType === HEADER) continue;
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
  if (i.itemType === HEADER) out.header = true;
  return out;
}

/**
 * The month's entries for one appointment. A recurring series is listed once per
 * occurrence, on the day each starts as Cozi itself expands it (its `days` map, which
 * already leaves out deleted occurrences and, for a multi-day series, names the
 * occurrence every covered day belongs to), so nobody has to work dates out from the
 * rule's wording. Each occurrence spans as many days as the series' first one. A
 * series with no day left in the month is not on the page at all (Cozi drops it;
 * live-verified 2026-10-14), so the one-entry fallback only serves a page that came
 * without a day map.
 */
export function expandAppt(a: CoziAppointment): SlimAppointment[] {
  if (!isRecurring(a) || a.occurrenceDays.length === 0) return [slimAppt(a)];
  return a.occurrenceDays.map((day) => ({ ...slimAppt({ ...a, startDay: day }), series_start: a.startDay }));
}

export interface SlimSearchHit extends SlimAppointment {
  /** Latest occurrence before today, for a recurring series. */
  last_day?: string;
  /** Up to the next 10 occurrences from today on, for a recurring series. */
  next_days?: string[];
}

/**
 * A calendar search hit. A recurring series can match hundreds of days across the
 * search window, so it reports the latest past and next upcoming occurrences, which
 * is what "when was / when is X" needs.
 */
export function slimSearchHit(a: CoziAppointment, today: string): SlimSearchHit {
  const out: SlimSearchHit = slimAppt(a);
  if (!isRecurring(a) || a.occurrenceDays.length === 0) return out;
  const past = a.occurrenceDays.filter((d) => d < today);
  const next = a.occurrenceDays.filter((d) => d >= today).slice(0, 10);
  if (past.length) out.last_day = past[past.length - 1]!;
  if (next.length) out.next_days = next;
  return out;
}

export function slimAppt(a: CoziAppointment): SlimAppointment {
  const day = a.startDay;
  const allDay = a.startTime == null;
  // A multi-day event ends on a later day than it starts (issue #8); how much later
  // is Cozi's `dateSpan`, read the same way for timed and all-day events (issue #12).
  const endDay = lastDayOf(day, a.dateSpan, allDay);
  const out: SlimAppointment = {
    id: a.id ?? '',
    subject: a.subject,
    day,
    all_day: allDay,
  };
  if (a.startTime) out.start = `${day}T${formatTimeOfDay(a.startTime)}`;
  if (a.endTime) out.end = `${endDay}T${formatTimeOfDay(a.endTime)}`;
  // The only span signal available for an all-day multi-day event, which carries no times.
  if (endDay !== day) out.end_day = endDay;
  if (a.attendees && a.attendees.length) out.attendees = [...a.attendees];
  if (a.location) out.location = a.location;
  if (a.notes) out.notes = a.notes;
  // A series is otherwise indistinguishable from a one-off in this projection, and
  // deleting one by id removes every occurrence (see deleteAppointmentHandler).
  if (isRecurring(a)) {
    out.recurring = true;
    const text = recurrenceText(a);
    if (text) out.recurrence = text;
    if (a.endDay) out.series_end = a.endDay;
    const skipped = skippedDays(a);
    if (skipped.length) out.skipped_days = skipped;
  }
  if (a.itemType && a.itemType !== 'appointment') out.kind = a.itemType;
  if (a.readOnly) out.read_only = true;
  if (a.itemSource) out.source = a.itemSource;
  if (a.reminders) out.reminders = [...a.reminders];
  return out;
}
