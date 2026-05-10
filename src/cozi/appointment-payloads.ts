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
  return {
    itemType: 'appointment',
    edit: {
      id: a.id,
      startDay: a.startDay,
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
