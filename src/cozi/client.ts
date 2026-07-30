import {
  toApiCreateFormat,
  toApiDeleteFormat,
  toApiEditFormat,
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
  type TimeOfDay,
} from './models.js';

const BASE_URL = 'https://rest.cozi.com';
const API_VERSION = '2004';
const AUTH_VERSION = '2207';
// Required by Cloudflare/Cozi as of 2026-04 (Wetzel402/py-cozi PR #3). The exact
// build number is loose — any "coziwc|vNNN_production" value is accepted.
const APIKEY = 'coziwc|v251_production';

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

export class CoziClient {
  private accessToken: string | null = null;
  private accountId: string | null = null;
  private tokenExpiresIn: number | null = null;
  private authenticated = false;
  private readonly http: HttpClient;

  constructor(
    private readonly username: string,
    private readonly password: string,
  ) {
    this.http = new HttpClient({
      baseUrl: BASE_URL,
      reauthenticate: async () => {
        this.authenticated = false;
        await this.authenticate();
      },
      authHeader: () => (this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
    });
  }

  async authenticate(): Promise<void> {
    const response = (await this.http.request({
      method: 'POST',
      endpoint: `/api/ext/${AUTH_VERSION}/auth/login`,
      params: { apikey: APIKEY },
      body: { username: this.username, password: this.password, issueRefresh: true },
      requireAuth: false,
    })) as AuthResponse;

    this.accessToken = response.accessToken ?? null;
    this.accountId = response.accountId ?? null;
    this.tokenExpiresIn = response.expiresIn ?? null;

    if (!this.accessToken || !this.accountId) {
      throw new AuthenticationError(
        'Invalid login response: missing ' +
          [!this.accessToken && 'accessToken', !this.accountId && 'accountId'].filter(Boolean).join(' and '),
      );
    }
    this.authenticated = true;
  }

  get tokenLifetimeMs(): number | null {
    return this.tokenExpiresIn != null ? this.tokenExpiresIn * 1000 : null;
  }

  private async ensureAuthenticated(): Promise<void> {
    if (!this.authenticated) await this.authenticate();
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
      for (const [itemId, itemData] of Object.entries(response.items)) {
        const parsed = this.parseCalendarItem(itemId, itemData);
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

  private parseCalendarItem(itemId: string, raw: unknown): CoziAppointment | null {
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
      });
    } catch {
      return null;
    }
  }

  async createAppointment(appt: CoziAppointment): Promise<CoziAppointment> {
    if (!appt.subject.trim()) throw new ValidationError('Appointment subject cannot be empty');

    const [yearStr, monthStr] = appt.startDay.split('-');
    const year = Number(yearStr);
    const month = Number(monthStr);

    await this.ensureAuthenticated();
    const response = await this.http.request({
      method: 'POST',
      endpoint: this.accountEndpoint(`/calendar/${year}/${month}`),
      body: [toApiCreateFormat(appt)],
    });
    assertNotRejected(response, 'create');

    if (isObj(response) && isObj(response.items)) {
      const items = response.items;

      for (const [itemId, itemData] of Object.entries(items)) {
        if (!isObj(itemData)) continue;
        if (itemData.day === appt.startDay && itemData.description === appt.subject) {
          return { ...appt, id: itemId };
        }
      }
      for (const [itemId, itemData] of Object.entries(items)) {
        if (!isObj(itemData)) continue;
        if (itemData.description === appt.subject) {
          return { ...appt, id: itemId };
        }
      }
    }

    throw new APIError(
      'Created appointment not found in server response',
      undefined,
      isObj(response) ? response : { response },
    );
  }

  async updateAppointment(appt: CoziAppointment): Promise<CoziAppointment> {
    if (!appt.id) throw new ValidationError('Cannot update appointment without ID');

    const [yearStr, monthStr] = appt.startDay.split('-');
    const year = Number(yearStr);
    const month = Number(monthStr);

    await this.ensureAuthenticated();
    const response = await this.http.request({
      method: 'POST',
      endpoint: this.accountEndpoint(`/calendar/${year}/${month}`),
      body: [toApiEditFormat(appt)],
    });
    assertNotRejected(response, 'edit', appt.id);
    return appt;
  }

  async deleteAppointment(appointmentId: string, year: number, month: number): Promise<boolean> {
    await this.ensureAuthenticated();
    const response = await this.http.request({
      method: 'POST',
      endpoint: this.accountEndpoint(`/calendar/${year}/${month}`),
      body: [toApiDeleteFormat({ id: appointmentId } as CoziAppointment)],
    });
    // Note: Cozi treats deleting an unknown id as a no-op success (no rejection),
    // so this catches malformed/refused deletes, not "it was already gone".
    assertNotRejected(response, 'delete', appointmentId);
    return true;
  }
}
