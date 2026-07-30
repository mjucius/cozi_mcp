import { ValidationError } from './errors.js';
import { CoziAppointment, formatTimeOfDay } from './models.js';

const time = (t: CoziAppointment['startTime']): string | null => (t ? formatTimeOfDay(t) : null);

export function toApiCreateFormat(a: CoziAppointment): Record<string, unknown> {
  return {
    itemType: 'appointment',
    create: {
      startDay: a.startDay,
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

export function toApiEditFormat(a: CoziAppointment): Record<string, unknown> {
  if (!a.id) throw new ValidationError('Cannot edit appointment without ID');
  // Cozi's calendar edit is a FULL REPLACE: any field omitted from the payload is
  // erased server-side. Re-send the recurrence rule the read path preserved so an
  // unrelated edit (e.g. notes) does not strip a recurring appointment's schedule.
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
    edit: {
      id: a.id,
      startDay: a.startDay,
      ...(a.recurrence != null ? { recurrence: a.recurrence } : {}),
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

export function toApiDeleteFormat(a: CoziAppointment): Record<string, unknown> {
  if (!a.id) throw new ValidationError('Cannot delete appointment without ID');
  return { itemType: 'appointment', delete: { id: a.id } };
}
