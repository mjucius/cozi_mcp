import { ValidationError } from './errors.js';
import { CoziAppointment, formatTimeOfDay } from './models.js';

// An all-day appointment is stored by Cozi as 00:00:00/00:00:00, not as null times —
// `parseTimeFromCalendar` in client.ts coerces that pair back to null on read. Sending a
// literal null is refused outright: "Operation rejected due to request data problem.
// Detail: start_time and end_time are required" (verified against live Cozi 2026-09-08),
// which meant every all_day=true create and every switch-to-all-day edit failed.
const time = (t: CoziAppointment['startTime']): string => (t ? formatTimeOfDay(t) : '00:00');

/**
 * Which occurrences of a recurring series an edit or delete touches. Omitted means
 * the whole series. `day` is one occurrence only: Cozi excludes it from the series
 * and, on an edit, stores the changed copy as its own appointment. `forward` is that
 * occurrence and every later one: Cozi ends the series the day before and, on an
 * edit, starts a new series there (all live-verified 2026-10-13). This is the Cozi
 * web client's own shape (bundle main.c43180f9): `selectedDay` + `extent` beside the
 * operation.
 */
export interface Occurrence {
  day: string;
  extent: 'day' | 'forward';
}

const occurrenceFields = (o?: Occurrence) => (o ? { selectedDay: o.day, extent: o.extent } : {});

// Family members Cozi should send a change notification to, beside the operation,
// as the web client does when its "notify" box is ticked (bundle main.c43180f9).
const notifyFields = (ids?: string[]) => (ids?.length ? { notifyPersons: ids } : {});

// Top-level `reminders` as Cozi stores them; `[]` clears them on an edit.
const reminderList = (mins: number[]) => mins.map((minutesBefore) => ({ minutesBefore }));

// `dateSpan` goes out exactly as the model carries it. It is a day offset (see
// models.ts): 0 for a same-day timed event, 1 for a one-day all-day event. Clamping
// it to >= 1 here is what created issue #12 — every timed appointment gained a day.

export function toApiCreateFormat(a: CoziAppointment, notifyPersons?: string[]): Record<string, unknown> {
  return {
    itemType: 'appointment',
    ...notifyFields(notifyPersons),
    create: {
      startDay: a.startDay,
      ...(a.recurrence != null ? { recurrence: a.recurrence } : {}),
      ...(a.reminders != null ? { reminders: reminderList(a.reminders) } : {}),
      details: {
        startTime: time(a.startTime),
        endTime: time(a.endTime),
        dateSpan: a.dateSpan,
        attendeeSet: a.attendees,
        location: a.location,
        notes: a.notes,
        subject: a.subject,
      },
    },
  };
}

export interface EditOptions {
  occurrence?: Occurrence;
  /** Replace the reminders (`[]` clears them). Omitted leaves them as they are. */
  reminders?: number[];
  notifyPersons?: string[];
}

export function toApiEditFormat(a: CoziAppointment, opts: EditOptions = {}): Record<string, unknown> {
  if (!a.id) throw new ValidationError('Cannot edit appointment without ID');
  // Cozi's calendar edit is a FULL REPLACE: any field omitted from the payload is
  // erased server-side. Re-send the recurrence rule the read path preserved so an
  // unrelated edit (e.g. notes) does not strip a recurring appointment's schedule.
  // Top-level `reminders` ([{minutesBefore}]) are the exception: the web client
  // re-sends them, but Cozi keeps them when omitted (live-verified 2026-10-13), so
  // they go out only when the caller is changing them.
  //
  // Wire shape captured from the real Cozi web client on 2026-07-24 (DevTools):
  //   {"itemType":"appointment","edit":{
  //      "id":…, "startDay":…,
  //      "recurrence":{"rules":[{"frequency":"Weekly","interval":1,"byDay":["FR"],"end":{}}]},
  //      "details":{"startTime","endTime","dateSpan","notes","subject"}}}
  //
  // Note the asymmetry, which is easy to get wrong: a calendar GET returns
  // recurrence nested under `itemDetails`, but an edit expects it at the EDIT level,
  // as a sibling of `details` — not inside it. Putting it inside `details` leaves the
  // rule unset and the series is flattened to a single appointment.
  //
  // The web client sends neither recurrenceStartDay nor endDay on edit (the server
  // derives both), so neither is sent here.
  //
  // DO NOT send itemVersion. Verified against live Cozi 2026-07-24: including it
  // makes the server silently discard the entire edit — the request returns 200 and
  // the client's merged object looks correct, but nothing persists. The real web
  // client does not send it either. Optimistic concurrency is not available here.
  return {
    itemType: 'appointment',
    ...occurrenceFields(opts.occurrence),
    ...notifyFields(opts.notifyPersons),
    edit: {
      id: a.id,
      startDay: a.startDay,
      ...(a.recurrence != null ? { recurrence: a.recurrence } : {}),
      ...(opts.reminders !== undefined ? { reminders: reminderList(opts.reminders) } : {}),
      details: {
        startTime: time(a.startTime),
        endTime: time(a.endTime),
        dateSpan: a.dateSpan,
        attendeeSet: a.attendees,
        subject: a.subject,
        location: a.location,
        notes: a.notes,
      },
    },
  };
}

export function toApiDeleteFormat(id: string, occurrence?: Occurrence, notifyPersons?: string[]): Record<string, unknown> {
  if (!id) throw new ValidationError('Cannot delete appointment without ID');
  // The web client also sends `version: itemVersion`; Cozi does not need it (live-verified).
  return { itemType: 'appointment', ...occurrenceFields(occurrence), ...notifyFields(notifyPersons), delete: { id } };
}
