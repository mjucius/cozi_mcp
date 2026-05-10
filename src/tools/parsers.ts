import { ListType, type CalendarDate, type TimeOfDay } from '../cozi/index.js';

export interface ParsedDateTime {
  date: CalendarDate;
  time: TimeOfDay;
}

export function parseIsoDateTime(s: string): ParsedDateTime {
  const cleaned = s.replace('Z', '+00:00');
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(cleaned);
  if (!m) throw new Error(`Invalid ISO datetime: ${s}`);
  const date: CalendarDate = `${m[1]}-${m[2]}-${m[3]}`;
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
