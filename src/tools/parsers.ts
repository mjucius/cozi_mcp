import { ListType, type CalendarDate, type TimeOfDay } from '../cozi/index.js';

export interface ParsedDateTime {
  date: CalendarDate;
  /** `null` when the input was a bare `YYYY-MM-DD` with no time component. */
  time: TimeOfDay | null;
}

/**
 * Parse an ISO datetime (`2026-06-15T10:00:00`) or a bare date (`2026-06-15`).
 * A bare date yields `time: null`; callers decide whether that is acceptable
 * (it is for all-day appointments, and an error for timed ones).
 */
export function parseIsoDateTime(s: string): ParsedDateTime {
  const cleaned = s.replace('Z', '+00:00');
  // A bare date must be the whole string; a datetime may carry a trailing offset.
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?|$)/.exec(cleaned);
  if (!m) throw new Error(`Invalid ISO datetime: ${s}`);
  const date: CalendarDate = `${m[1]}-${m[2]}-${m[3]}`;
  if (m[4] === undefined) return { date, time: null };
  const h = Number(m[4]);
  const min = Number(m[5]);
  const sec = m[6] ? Number(m[6]) : 0;
  const time: TimeOfDay = sec ? { h, m: min, s: sec } : { h, m: min };
  return { date, time };
}

export function parseListType(s: string): ListType {
  const norm = s.trim().toLowerCase();
  if (norm === 'shopping') return ListType.SHOPPING;
  if (norm === 'todo') return ListType.TODO;
  throw new Error(`Unknown list_type ${JSON.stringify(s)}; expected 'shopping' or 'todo'`);
}
