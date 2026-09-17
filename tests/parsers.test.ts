import { describe, expect, it } from 'vitest';
import { parseIsoDateTime, parseListType } from '../src/tools/parsers.js';
import { ListType } from '../src/cozi/index.js';

describe('parseIsoDateTime', () => {
  it('parses a full datetime with seconds', () => {
    expect(parseIsoDateTime('2026-06-15T10:30:15')).toEqual({
      date: '2026-06-15',
      time: { h: 10, m: 30, s: 15 },
    });
  });

  it('parses a datetime without seconds', () => {
    expect(parseIsoDateTime('2026-06-15T10:30')).toEqual({ date: '2026-06-15', time: { h: 10, m: 30 } });
  });

  it('tolerates a Z / offset suffix', () => {
    expect(parseIsoDateTime('2026-06-15T10:30:00Z').time).toEqual({ h: 10, m: 30 });
    expect(parseIsoDateTime('2026-06-15T10:30:00-05:00').time).toEqual({ h: 10, m: 30 });
  });

  it('a bare date yields time: null', () => {
    expect(parseIsoDateTime('2026-06-15')).toEqual({ date: '2026-06-15', time: null });
  });

  it('rejects anything that is not a date or datetime', () => {
    expect(() => parseIsoDateTime('June 15')).toThrow(/Invalid ISO datetime/);
    expect(() => parseIsoDateTime('2026-06-15T10')).toThrow(/Invalid ISO datetime/);
    expect(() => parseIsoDateTime('2026-6-15')).toThrow(/Invalid ISO datetime/);
    expect(() => parseIsoDateTime('')).toThrow(/Invalid ISO datetime/);
  });
});

describe('parseListType', () => {
  it('normalises case and whitespace', () => {
    expect(parseListType(' Shopping ')).toBe(ListType.SHOPPING);
    expect(parseListType('TODO')).toBe(ListType.TODO);
  });

  it('rejects unknown types', () => {
    expect(() => parseListType('wishlist')).toThrow(/Unknown list_type/);
  });
});
