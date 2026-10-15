import {
  toApiCreateFormat,
  toApiDeleteFormat,
  toApiEditFormat,
  type EditOptions,
  type Occurrence,
} from './appointment-payloads.js';
import {
  APIError,
  AuthenticationError,
  ResourceNotFoundError,
  ValidationError,
  WriteVerificationError,
} from './errors.js';
import { HttpClient, type HttpResponse } from './http.js';
import {
  CoziAppointment,
  CoziAppointmentSchema,
  CoziItem,
  CoziItemSchema,
  CoziList,
  CoziListSchema,
  CoziPerson,
  CoziPersonSchema,
  ItemStatus,
  ListType,
  isRecurring,
  type TimeOfDay,
} from './models.js';

const BASE_URL = 'https://rest.cozi.com';
const API_VERSION = '2004';
const AUTH_VERSION = '2207';
const REAUTH_VERSION = '2111';
// Required on login by Cloudflare/Cozi as of 2026-04 (Wetzel402/py-cozi PR #3). The
// exact build number is loose — any "coziwc|vNNN_production" value is accepted. The
// Cozi web client (bundle main.c43180f9, 2026-10-13) sends it on EVERY request, not
// just login, so we do too: Cozi enforcing it on login without notice broke every
// third-party client once, and resource calls are the obvious next place.
const APIKEY = 'coziwc|v251_production';
// Refresh the token this long before Cozi says it expires.
const REFRESH_MARGIN_MS = 60_000;

interface AuthResponse {
  accessToken?: string;
  accountId?: string;
  expiresIn?: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Throw if Cozi discarded a calendar operation.
 *
 * The calendar endpoint answers HTTP 200 even when it refuses an operation,
 * naming the reason in a `rejectedItems` array. Verified against live Cozi
 * 2026-07-24 — e.g. an edit carrying an unexpected attribute comes back as
 *   {"rejectedItems":[{"operation":"edit","id":"…",
 *     "error":"Operation rejected due to request data problem. Detail:
 *              Unexpected attribute 'item_version' for AppointmentResource"}]}
 * while the merged object the caller holds still looks perfectly correct.
 * Without this check a discarded write is indistinguishable from a real one.
 */
function assertNotRejected(response: unknown, operation: string, apptId?: string): void {
  if (!isObj(response)) return;
  const rejected = response.rejectedItems;
  if (!Array.isArray(rejected) || rejected.length === 0) return;

  const mine = apptId
    ? rejected.filter((r) => isObj(r) && (r.id === undefined || r.id === apptId))
    : rejected;
  if (mine.length === 0) return;

  const reasons = mine
    .map((r) => (isObj(r) && typeof r.error === 'string' ? r.error : 'no reason given'))
    .join('; ');
  throw new WriteVerificationError(
    `Cozi rejected the ${operation} operation${apptId ? ` for appointment ${apptId}` : ''}: ${reasons}`,
  );
}

export const ID_RE = /^[A-Za-z0-9_-]+$/;
export function idSeg(id: string): string {
  if (!ID_RE.test(id)) throw new ValidationError(`Invalid id: ${JSON.stringify(id)}`);
  return encodeURIComponent(id);
}

const parseTimeFromCalendar = (raw: unknown): TimeOfDay | null => {
  if (typeof raw !== 'string' || !raw || raw === '00:00:00') return null;
  const parts = raw.split(':');
  if (parts.length < 2) return null;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return { h, m };
};

/**
 * The first day of each occurrence of every item on a month page, from its `days`
 * map (`{"2019-01-15": [{id}], …}`). Cozi expands recurring series server-side,
 * leaves out deleted occurrences, and lists a multi-day item on every day it covers,
 * each such entry naming the occurrence it belongs to as `multiday: {startDay,
 * endDay}` (live-verified 2026-10-14; `endDay` is the end instant's day, one past
 * the last day of an all-day item). That start day is what is kept, once per
 * occurrence, and it may lie in the previous month. The map spans exactly the
 * requested month (live-verified 2026-10-13).
 */
function occurrenceIndex(days: unknown): Map<string, string[]> {
  const starts = new Map<string, Set<string>>();
  if (!isObj(days)) return new Map();
  for (const [day, refs] of Object.entries(days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Array.isArray(refs)) continue;
    for (const ref of refs) {
      if (!isObj(ref) || typeof ref.id !== 'string') continue;
      const named = isObj(ref.multiday) ? ref.multiday.startDay : undefined;
      const start = typeof named === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(named) ? named : day;
      const set = starts.get(ref.id) ?? new Set<string>();
      set.add(start);
      starts.set(ref.id, set);
    }
  }
  return new Map([...starts].map(([id, set]) => [id, [...set].sort()]));
}

export class CoziClient {
  private accessToken: string | null = null;
  private accountId: string | null = null;
  private tokenExpiresIn: number | null = null;
  private tokenIssuedAtMs = 0;
  private authenticated = false;
  /** Bumped on every accepted token, so a request can tell whether one arrived since it was sent. */
  private tokenGeneration = 0;
  private authInFlight: Promise<void> | null = null;
  private readonly http: HttpClient;

  constructor(
    private readonly username: string,
    private readonly password: string,
  ) {
    this.http = new HttpClient({
      baseUrl: BASE_URL,
      defaultParams: { apikey: APIKEY },
      reauthenticate: () => this.authOnce(() => this.refresh()),
      authHeader: () => (this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
      authGeneration: () => this.tokenGeneration,
    });
  }

  async authenticate(): Promise<void> {
    const response = (await this.http.request({
      method: 'POST',
      endpoint: `/api/ext/${AUTH_VERSION}/auth/login`,
      body: { username: this.username, password: this.password, issueRefresh: true },
      requireAuth: false,
    })) as AuthResponse;
    this.acceptToken(response);
  }

  /**
   * Get a fresh access token without re-sending the password, the way the Cozi web
   * client does (bundle main.c43180f9, 2026-10-13): login with `issueRefresh` sets a
   * `cozi_refresh` cookie, which the cookie jar keeps, and an empty POST to `reauth`
   * trades it for a new token. Verified live 2026-10-13: 200 with the same response
   * shape as login. Falls back to a full login if the refresh is refused or the
   * session never had one.
   */
  private async refresh(): Promise<void> {
    this.authenticated = false;
    if (this.accountId) {
      try {
        const response = (await this.http.request({
          method: 'POST',
          endpoint: `/api/ext/${REAUTH_VERSION}/${this.accountId}/auth/reauth`,
          requireAuth: false,
        })) as AuthResponse;
        this.acceptToken(response);
        return;
      } catch {
        // fall through to the password
      }
    }
    await this.authenticate();
  }

  private acceptToken(response: AuthResponse): void {
    this.accessToken = response.accessToken ?? null;
    this.accountId = response.accountId ?? null;
    this.tokenExpiresIn = response.expiresIn ?? null;

    if (!this.accessToken || !this.accountId) {
      throw new AuthenticationError(
        'Invalid login response: missing ' +
          [!this.accessToken && 'accessToken', !this.accountId && 'accountId'].filter(Boolean).join(' and '),
      );
    }
    this.tokenIssuedAtMs = Date.now();
    this.tokenGeneration += 1;
    this.authenticated = true;
  }

  get tokenLifetimeMs(): number | null {
    return this.tokenExpiresIn != null ? this.tokenExpiresIn * 1000 : null;
  }

  private async ensureAuthenticated(): Promise<void> {
    if (!this.authenticated) return this.authOnce(() => this.authenticate());
    const life = this.tokenLifetimeMs;
    if (life != null && Date.now() - this.tokenIssuedAtMs >= life - REFRESH_MARGIN_MS) {
      await this.authOnce(() => this.refresh());
    }
  }

  /**
   * One login or refresh at a time. Tool calls made in parallel share a client, and
   * each would otherwise renew the token on its own (every 401 of a replayed batch
   * reauthenticating again); a caller that finds one in flight waits for it instead.
   */
  private authOnce(run: () => Promise<void>): Promise<void> {
    if (!this.authInFlight) {
      this.authInFlight = run().finally(() => {
        this.authInFlight = null;
      });
    }
    return this.authInFlight;
  }

  private accountEndpoint(suffix: string): string {
    return `/api/ext/${API_VERSION}/${this.accountId}${suffix}`;
  }

  // --- Family / Account ---

  async getFamilyMembers(): Promise<CoziPerson[]> {
    await this.ensureAuthenticated();
    const response = await this.http.request({
      method: 'GET',
      endpoint: this.accountEndpoint('/account/person/'),
    });
    if (!Array.isArray(response)) return [];
    return response.map((p) => CoziPersonSchema.parse(p));
  }

  // --- Lists ---

  async getLists(): Promise<CoziList[]> {
    await this.ensureAuthenticated();
    const response = await this.http.request({
      method: 'GET',
      endpoint: this.accountEndpoint('/list/'),
    });
    if (!Array.isArray(response)) return [];
    return response.map((l) => CoziListSchema.parse(l));
  }

  async getListsByType(listType: ListType): Promise<CoziList[]> {
    const all = await this.getLists();
    return all.filter((l) => l.listType === listType);
  }

  async createList(title: string, listType: ListType): Promise<CoziList> {
    if (!title.trim()) throw new ValidationError('List title cannot be empty');
    await this.ensureAuthenticated();
    const response = await this.http.request({
      method: 'POST',
      endpoint: this.accountEndpoint('/list/'),
      body: { title, listType },
    });
    return CoziListSchema.parse(response);
  }

  /**
   * Rename a list. A PUT with only `title` keeps the list's items and type, and an
   * unknown id is a 400 rather than an upsert (live-verified 2026-10-13); the Cozi
   * web client sends the whole list, which is not needed.
   */
  async renameList(listId: string, title: string): Promise<CoziList> {
    const listSeg = idSeg(listId);
    if (!title.trim()) throw new ValidationError('List title cannot be empty');
    await this.ensureAuthenticated();
    const response = await this.http.request({
      method: 'PUT',
      endpoint: this.accountEndpoint(`/list/${listSeg}`),
      body: { title },
    });
    const list = CoziListSchema.parse(response);
    if (list.title !== title) {
      throw new WriteVerificationError(
        `Cozi did not apply the rename: asked for "${title}", server returned "${list.title}"`,
      );
    }
    return list;
  }

  async deleteList(listId: string): Promise<boolean> {
    const listSeg = idSeg(listId);
    await this.ensureAuthenticated();
    await this.http.request({
      method: 'DELETE',
      endpoint: this.accountEndpoint(`/list/${listSeg}`),
    });
    return true;
  }

  // --- Items ---

  async addItem(listId: string, text: string, position = 0): Promise<CoziItem> {
    const listSeg = idSeg(listId);
    if (!text.trim()) throw new ValidationError('Item text cannot be empty');
    await this.ensureAuthenticated();
    const response = await this.http.request({
      method: 'POST',
      endpoint: this.accountEndpoint(`/list/${listSeg}/item/`),
      body: { text, position },
    });
    const item = CoziItemSchema.parse(response);
    if (item.text !== text || !item.id) {
      throw new WriteVerificationError(
        `Cozi did not apply the item creation: asked for text "${text}", server returned "${item.text}"${item.id ? '' : ' with no id'}`,
      );
    }
    return item;
  }

  /**
   * PUT an item and reject the case where Cozi *created* it instead of updating.
   *
   * Verified against live Cozi 2026-07-24: a PUT to an item id that does not
   * exist answers 201 and persists a brand-new item under that exact id — an
   * upsert, not an error. Since ids here come from an LLM, a hallucinated or
   * stale id would silently add a phantom item to the user's list rather than
   * failing. 200 vs 201 is the only signal; the bodies are identical.
   *
   * On 201 the phantom is deleted before throwing so a failed update leaves no
   * residue. If that cleanup itself fails we still surface the original error —
   * losing it to report a cleanup problem would be worse — and say the item may
   * remain.
   */
  private async putItem(
    listId: string,
    itemId: string,
    body: Record<string, unknown>,
  ): Promise<CoziItem> {
    const listSeg = idSeg(listId);
    const itemSeg = idSeg(itemId);
    await this.ensureAuthenticated();
    const { status, body: response } = await this.http.requestWithStatus({
      method: 'PUT',
      endpoint: this.accountEndpoint(`/list/${listSeg}/item/${itemSeg}`),
      body,
    });

    if (status === 201) {
      let cleanedUp = true;
      try {
        await this.removeItems(listId, [itemId]);
      } catch {
        cleanedUp = false;
      }
      throw new ResourceNotFoundError(
        `Item ${itemId} does not exist in list ${listId}; Cozi created a new item instead of updating.` +
          (cleanedUp
            ? ' The phantom item was removed.'
            : ' The phantom item could NOT be removed and may still be in the list.'),
      );
    }

    return CoziItemSchema.parse(response);
  }

  async updateItemText(listId: string, itemId: string, text: string): Promise<CoziItem> {
    if (!text.trim()) throw new ValidationError('Item text cannot be empty');
    const item = await this.putItem(listId, itemId, { text });
    if (item.text !== text) {
      throw new WriteVerificationError(
        `Cozi did not apply the text update: asked for "${text}", server returned "${item.text}"`,
      );
    }
    return item;
  }

  async markItem(listId: string, itemId: string, status: ItemStatus): Promise<CoziItem> {
    const item = await this.putItem(listId, itemId, { status });
    if (item.status !== status) {
      throw new WriteVerificationError(
        `Cozi did not apply the status update: asked for "${status}", server returned "${item.status}"`,
      );
    }
    return item;
  }

  async removeItems(listId: string, itemIds: string[]): Promise<boolean> {
    const listSeg = idSeg(listId);
    if (itemIds.length === 0) return true;
    // Validate every item id at the client boundary too (parity with the URL sinks):
    // each id lands in a JSON-Pointer `path`, where an unvalidated `/` or `~` would
    // retarget the patch. idSeg rejects anything outside [A-Za-z0-9_-].
    const operations = itemIds.map((id) => ({ op: 'remove', path: `/items/${idSeg(id)}` }));
    await this.ensureAuthenticated();
    const response = await this.http.request({
      method: 'PATCH',
      endpoint: this.accountEndpoint(`/list/${listSeg}`),
      body: { operations },
    });

    // The PATCH response is the full post-state of the list, so the removal can be
    // confirmed without a second round trip. Note Cozi tolerates removing an id that
    // was never there (200, list unchanged) — that still satisfies "it is not there".
    if (isObj(response) && Array.isArray(response.items)) {
      const remaining = new Set(
        response.items
          .map((i) => (isObj(i) ? (i.itemId ?? i.id) : undefined))
          .filter((id): id is string => typeof id === 'string'),
      );
      const survived = itemIds.filter((id) => remaining.has(id));
      if (survived.length > 0) {
        throw new WriteVerificationError(
          `Cozi did not remove ${survived.length} of ${itemIds.length} item(s) from list ${listId}: ${survived.join(', ')}`,
        );
      }
    }
    return true;
  }

  // --- Calendar ---

  async getCalendar(year: number, month: number): Promise<CoziAppointment[]> {
    if (month < 1 || month > 12) throw new ValidationError('Month must be between 1 and 12');
    await this.ensureAuthenticated();
    const response = await this.http.request({
      method: 'GET',
      endpoint: this.accountEndpoint(`/calendar/${year}/${month}`),
    });

    const appointments: CoziAppointment[] = [];

    if (isObj(response) && isObj(response.items)) {
      const days = occurrenceIndex(response.days);
      for (const [itemId, itemData] of Object.entries(response.items)) {
        const parsed = this.parseCalendarItem(itemId, itemData, days.get(itemId));
        if (parsed) appointments.push(parsed);
      }
    } else if (Array.isArray(response)) {
      for (const data of response) {
        try {
          appointments.push(CoziAppointmentSchema.parse(data));
        } catch {
          // skip unparseable
        }
      }
    }

    return appointments;
  }

  /**
   * Cozi's calendar search (`/search/calendar/?q=`), the one the web client's search
   * box uses. Each hit is `{highlight, item}` with a month-page-shaped item, and the
   * `days` map lists the matching dates across the whole search window, which starts
   * a few years back (a 2019 item is not found; 2022 is) and pages via `hasNext`.
   * Returns the first page; `more` says whether Cozi has further pages.
   */
  async searchCalendar(query: string): Promise<{ appointments: CoziAppointment[]; more: boolean }> {
    if (!query.trim()) throw new ValidationError('Search query cannot be empty');
    await this.ensureAuthenticated();
    const response = await this.http.request({
      method: 'GET',
      endpoint: this.accountEndpoint('/search/calendar/'),
      params: { q: query },
    });
    const appointments: CoziAppointment[] = [];
    if (!isObj(response)) return { appointments, more: false };
    const days = occurrenceIndex(response.days);
    for (const [key, hit] of Object.entries(isObj(response.items) ? response.items : {})) {
      const item = isObj(hit) && isObj(hit.item) ? hit.item : hit;
      // Search keys every hit, its inner `id` and its `days` entries as "<uuid>-a"
      // (live-verified 2026-10-13); the calendar itself uses the bare uuid, which is
      // what update/delete need. Only a uuid with a one-letter suffix is trimmed.
      const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[a-z]$/.test(key) ? key.slice(0, -2) : key;
      const parsed = this.parseCalendarItem(id, isObj(item) ? { ...item, id } : item, days.get(key));
      if (parsed) appointments.push(parsed);
    }
    return { appointments, more: response.hasNext === true };
  }

  private parseCalendarItem(itemId: string, raw: unknown, occurrenceDays: string[] = []): CoziAppointment | null {
    if (!isObj(raw)) return null;

    const description = (raw.description as string | undefined)?.trim();
    const descriptionShort = (raw.descriptionShort as string | undefined)?.trim();
    const subject = description || descriptionShort || '';

    const dayStr = raw.day as string | undefined;
    if (typeof dayStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dayStr)) return null;

    const startTime = parseTimeFromCalendar(raw.startTime);
    const endTime = parseTimeFromCalendar(raw.endTime);

    const details = isObj(raw.itemDetails) ? (raw.itemDetails as Record<string, unknown>) : {};
    const location = typeof details.location === 'string' ? details.location : null;
    const detailsNotes = typeof details.notes === 'string' ? details.notes : null;

    const attendees = Array.isArray(raw.householdMembers) ? (raw.householdMembers as string[]) : [];
    const dateSpan = typeof raw.dateSpan === 'number' ? raw.dateSpan : 0;
    const id = (raw.id as string | undefined) ?? itemId;
    const notes = typeof raw.notes === 'string' ? raw.notes : detailsNotes;

    // Wire placement verified against live Cozi 2026-07-24 (133 real appointments):
    // recurrence, recurrenceStartDay and readOnly live inside itemDetails — NOT at the
    // top level. itemVersion is top-level. endDay is not a field of its own at all: it
    // is nested inside the recurrence object (recurrence.endDay) and therefore
    // round-trips automatically whenever recurrence is preserved intact.
    const recurrence = isObj(details.recurrence) ? details.recurrence : null;
    const recurrenceStartDay =
      typeof details.recurrenceStartDay === 'string' ? details.recurrenceStartDay : null;
    const endDay = recurrence && typeof recurrence.endDay === 'string' ? recurrence.endDay : null;
    const itemVersion = typeof raw.itemVersion === 'number' ? raw.itemVersion : null;
    const readOnly = typeof details.readOnly === 'boolean' ? details.readOnly : null;

    try {
      return CoziAppointmentSchema.parse({
        id,
        description: subject,
        day: dayStr,
        startTime: startTime ? `${String(startTime.h).padStart(2, '0')}:${String(startTime.m).padStart(2, '0')}` : null,
        endTime: endTime ? `${String(endTime.h).padStart(2, '0')}:${String(endTime.m).padStart(2, '0')}` : null,
        dateSpan,
        householdMembers: attendees,
        location,
        notes,
        recurrence,
        recurrenceStartDay,
        endDay,
        itemVersion,
        readOnly,
        itemType: typeof raw.itemType === 'string' ? raw.itemType : null,
        itemSource: typeof raw.itemSource === 'string' ? raw.itemSource : null,
        reminders: raw.reminders,
        occurrenceDays,
      });
    } catch {
      return null;
    }
  }

  async createAppointment(appt: CoziAppointment, notifyPersons?: string[]): Promise<CoziAppointment> {
    if (!appt.subject.trim()) throw new ValidationError('Appointment subject cannot be empty');

    const [yearStr, monthStr] = appt.startDay.split('-');
    const year = Number(yearStr);
    const month = Number(monthStr);

    await this.ensureAuthenticated();
    const response = await this.http.request({
      method: 'POST',
      endpoint: this.accountEndpoint(`/calendar/${year}/${month}`),
      body: [toApiCreateFormat(appt, notifyPersons)],
    });
    assertNotRejected(response, 'create');

    // The response carries the stored item under its new id. Return THAT, parsed the
    // same way a calendar GET is, rather than echoing the request back: the caller
    // then sees what Cozi actually persisted. 2.2.0 echoed, which is why issue #12
    // (every timed appointment a day too long) was invisible in the tool output.
    if (isObj(response) && isObj(response.items)) {
      const items = response.items;
      // The fallback is the old echo; only the live suite's "tool result equals a
      // fresh get_calendar read" assertion would notice if it ever took over.
      const stored = (itemId: string, itemData: unknown): CoziAppointment =>
        this.parseCalendarItem(itemId, itemData) ?? { ...appt, id: itemId };

      for (const [itemId, itemData] of Object.entries(items)) {
        if (!isObj(itemData)) continue;
        if (itemData.day === appt.startDay && itemData.description === appt.subject) {
          return stored(itemId, itemData);
        }
      }
      for (const [itemId, itemData] of Object.entries(items)) {
        if (!isObj(itemData)) continue;
        if (itemData.description === appt.subject) {
          return stored(itemId, itemData);
        }
      }
    }

    throw new APIError(
      'Created appointment not found in server response',
      undefined,
      isObj(response) ? response : { response },
    );
  }

  async updateAppointment(appt: CoziAppointment, opts: EditOptions = {}): Promise<CoziAppointment> {
    if (!appt.id) throw new ValidationError('Cannot update appointment without ID');

    const [year, month] = yearMonth(appt.startDay);

    await this.ensureAuthenticated();
    const response = await this.http.request({
      method: 'POST',
      endpoint: this.accountEndpoint(`/calendar/${year}/${month}`),
      body: [toApiEditFormat(appt, opts)],
    });
    assertNotRejected(response, 'edit', appt.id);
    if (opts.occurrence) return this.storedOccurrenceEdit(appt, opts.occurrence);
    // As with create: prefer the stored item the response carries over the merged
    // object we sent, so the caller sees what persisted.
    if (isObj(response) && isObj(response.items)) {
      const stored = this.parseCalendarItem(appt.id, response.items[appt.id]);
      if (stored) return stored;
    }
    return appt;
  }

  /**
   * The appointment Cozi stored for an occurrence edit, which is never `appt.id`
   * itself (live-verified 2026-10-13). For one occurrence (`day`) it is a stand-in:
   * the series gains an exdate for that day naming the stand-in's id. For this-and-
   * following (`forward`) it is a new series starting on the new start day, while
   * the old one now ends the day before. Either lives on the page of `appt.startDay`.
   *
   * The series itself may be gone from that page: a month with no day of it left is
   * not listed at all (live-verified 2026-10-14), which is just what editing a
   * series' only occurrence that month leaves behind. Its exdate is then read from
   * the occurrence's own page if that is another month, and failing that the
   * stand-in is matched by what was sent: the one non-recurring appointment with
   * that subject, day and times. The new series of a `forward` edit is matched the
   * same way among the recurring ones, so a one-off with the same subject that day
   * is never mistaken for it.
   */
  private async storedOccurrenceEdit(appt: CoziAppointment, occ: Occurrence): Promise<CoziAppointment> {
    const homePage = yearMonth(appt.startDay);
    const home = await this.getCalendar(...homePage);
    const looksLike = (a: CoziAppointment): boolean =>
      a.id !== appt.id &&
      a.startDay === appt.startDay &&
      a.subject === appt.subject &&
      sameTime(a.startTime, appt.startTime) &&
      sameTime(a.endTime, appt.endTime);
    let candidates: CoziAppointment[];
    if (occ.extent === 'day') {
      let series = home.find((a) => a.id === appt.id);
      const occPage = yearMonth(occ.day);
      if (!series && (occPage[0] !== homePage[0] || occPage[1] !== homePage[1])) {
        series = (await this.getCalendar(...occPage)).find((a) => a.id === appt.id);
      }
      const exdates = Array.isArray(series?.recurrence?.exdates) ? series.recurrence.exdates : [];
      const standin = exdates.find(
        (e): e is { date: string; standinApptId: string } =>
          isObj(e) && typeof e.date === 'string' && e.date.startsWith(occ.day) && typeof e.standinApptId === 'string',
      )?.standinApptId;
      // A series that is listed but names no stand-in has no copy to find; only a series
      // Cozi has dropped from the page leaves the look-alike match to go on.
      if (standin) candidates = home.filter((a) => a.id === standin);
      else if (series) candidates = [];
      else candidates = home.filter((a) => looksLike(a) && !isRecurring(a));
    } else {
      candidates = home.filter((a) => looksLike(a) && isRecurring(a));
    }
    if (candidates.length !== 1) {
      throw new WriteVerificationError(
        `Cozi accepted the edit of appointment ${appt.id} on ${occ.day}, but the changed copy ` +
          (candidates.length
            ? `cannot be told apart from ${candidates.length - 1} other appointment(s) just like it`
            : 'could not be found'),
      );
    }
    return candidates[0]!;
  }

  async deleteAppointment(
    appointmentId: string,
    year: number,
    month: number,
    occurrence?: Occurrence,
    notifyPersons?: string[],
  ): Promise<boolean> {
    await this.ensureAuthenticated();
    const response = await this.http.request({
      method: 'POST',
      endpoint: this.accountEndpoint(`/calendar/${year}/${month}`),
      body: [toApiDeleteFormat(appointmentId, occurrence, notifyPersons)],
    });
    // Note: Cozi treats deleting an unknown id as a no-op success (no rejection),
    // so this catches malformed/refused deletes, not "it was already gone".
    assertNotRejected(response, 'delete', appointmentId);
    return true;
  }
}

const yearMonth = (day: string): [number, number] => {
  const [y, m] = day.split('-');
  return [Number(y), Number(m)];
};

// Cozi stores midnight as 00:00:00, which parseTimeFromCalendar reads back as null, so
// a missing time and midnight are the same time here.
const sameTime = (a: TimeOfDay | null, b: TimeOfDay | null): boolean => {
  const [x, y] = [a ?? { h: 0, m: 0 }, b ?? { h: 0, m: 0 }];
  return x.h === y.h && x.m === y.m;
};
