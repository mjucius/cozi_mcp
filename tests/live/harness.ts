// Shared plumbing for the live conformance suite (tests/live/*.test.ts).
//
// These tests exist because the unit suite can only check what we SEND: it mocks
// CoziClient and asserts against our own model of Cozi. Issue #12 shipped with 20
// green unit tests and a 15/15 smoke script because both encoded the same wrong
// belief about `dateSpan`. Everything here is verified against a fresh GET from the
// real API, with exact expected values, and span semantics are verified through
// the one server-side signal of Cozi's own interpretation: a spanning appointment
// is listed on every month page it overlaps.
//
// Privacy: the suite reads whole month pages (that is the only calendar GET Cozi
// has) but only ever looks up, asserts on and deletes its own `LIVE_TEST_DELETE_ME`
// subjects, and writes nothing to disk.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { CoziClient } from '../../src/cozi/index.js';

// ---- credentials -------------------------------------------------------------

function loadCreds(): { username: string; password: string } | null {
  let { COZI_USERNAME: username, COZI_PASSWORD: password } = process.env;
  if (!username || !password) {
    try {
      const text = readFileSync(resolve(process.cwd(), 'creds.env'), 'utf8');
      for (const line of text.split('\n')) {
        const m = /^\s*(COZI_USERNAME|COZI_PASSWORD)\s*=\s*(.*?)\s*$/.exec(line);
        if (!m) continue;
        const val = m[2]!.replace(/^["']|["']$/g, '');
        if (m[1] === 'COZI_USERNAME') username ??= val;
        else password ??= val;
      }
    } catch {
      // no creds.env — the suite will skip
    }
  }
  return username && password ? { username, password } : null;
}

export const creds = loadCreds();
export const haveCreds = creds !== null;

// ---- sandbox -------------------------------------------------------------------

// A fixed window in the past: no reminders fire, nothing shows up on the family's
// upcoming view, and a stray leftover is obviously a test artifact. Two adjacent
// months so cross-month spans can be observed.
export const SANDBOX = {
  year: 2019,
  jan: 1,
  feb: 2,
  mar: 3,
} as const;

export const MARK = 'LIVE_TEST_DELETE_ME';
export const subj = (label: string): string => `${MARK} ${label}`;

// ---- raw wire access -----------------------------------------------------------

export interface RawCalendarItem {
  id?: string;
  description?: string;
  day?: string;
  startTime?: string;
  endTime?: string;
  dateSpan?: number;
  householdMembers?: string[];
  itemDetails?: Record<string, unknown>;
  [k: string]: unknown;
}

interface Backdoor {
  http: { request(o: unknown): Promise<unknown> };
  accountEndpoint(s: string): string;
}

export class Live {
  readonly client: CoziClient;
  private readonly back: Backdoor;
  /** Every appointment this run created, for teardown. */
  readonly created: Array<{ id: string; year: number; month: number }> = [];

  constructor() {
    if (!creds) throw new Error('live harness constructed without credentials');
    this.client = new CoziClient(creds.username, creds.password);
    this.back = this.client as unknown as Backdoor;
  }

  async authenticate(): Promise<void> {
    await this.client.authenticate();
  }

  /** The month page exactly as Cozi returns it — no parsing, no coercion. */
  async rawPage(year: number, month: number): Promise<Map<string, RawCalendarItem>> {
    const res = (await this.back.http.request({
      method: 'GET',
      endpoint: this.back.accountEndpoint(`/calendar/${year}/${month}`),
    })) as { items?: Record<string, RawCalendarItem> };
    return new Map(Object.entries(res.items ?? {}));
  }

  async rawPost(year: number, month: number, ops: unknown[]): Promise<unknown> {
    return this.back.http.request({
      method: 'POST',
      endpoint: this.back.accountEndpoint(`/calendar/${year}/${month}`),
      body: ops,
    });
  }

  /** The raw wire item for one of OUR subjects on a page, or undefined. */
  async findRaw(year: number, month: number, subject: string): Promise<RawCalendarItem | undefined> {
    if (!subject.startsWith(MARK)) throw new Error('live tests may only look up their own subjects');
    for (const [id, it] of await this.rawPage(year, month)) {
      if (it.description === subject) return { ...it, id: it.id ?? id };
    }
    return undefined;
  }

  /**
   * Which sandbox months list this appointment id. This is the only server-side
   * observation of how Cozi interprets `dateSpan`: an appointment is returned on
   * every month page its [start, end] overlaps.
   */
  async monthsListing(id: string): Promise<number[]> {
    const out: number[] = [];
    for (const m of [SANDBOX.jan, SANDBOX.feb, SANDBOX.mar]) {
      if ((await this.rawPage(SANDBOX.year, m)).has(id)) out.push(m);
    }
    return out;
  }

  track(id: string, year: number, month: number): void {
    if (!this.created.some((c) => c.id === id)) this.created.push({ id, year, month });
  }

  /** Delete anything carrying our marker in the sandbox — leftovers from an aborted run. */
  async sweep(): Promise<number> {
    let n = 0;
    for (const m of [SANDBOX.jan, SANDBOX.feb, SANDBOX.mar]) {
      for (const [id, it] of await this.rawPage(SANDBOX.year, m)) {
        if (typeof it.description === 'string' && it.description.startsWith(MARK)) {
          await this.client.deleteAppointment(it.id ?? id, SANDBOX.year, m);
          n++;
        }
      }
    }
    return n;
  }

  /** Delete everything this run created. Throws (after trying all) if any survive. */
  async teardown(): Promise<void> {
    const failures: string[] = [];
    for (const c of this.created.splice(0)) {
      try {
        await this.client.deleteAppointment(c.id, c.year, c.month);
      } catch (e) {
        failures.push(`${c.id}: ${String(e)}`);
      }
    }
    const leftovers = await this.sweep();
    if (failures.length || leftovers) {
      throw new Error(
        `live teardown incomplete — ${failures.length} delete failure(s), ${leftovers} leftover(s) swept:\n${failures.join('\n')}`,
      );
    }
  }
}

/** Structural JSON compare with sorted keys (Cozi's key order is not stable). */
export const stable = (v: unknown): string => {
  const norm = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(norm)
      : x && typeof x === 'object'
        ? Object.fromEntries(
            Object.entries(x as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, val]) => [k, norm(val)]),
          )
        : x;
  return JSON.stringify(norm(v));
};
