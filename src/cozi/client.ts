import {
  toApiCreateFormat,
  toApiDeleteFormat,
  toApiEditFormat,
} from './appointment-payloads.js';
import {
  APIError,
  AuthenticationError,
  ValidationError,
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
      throw new AuthenticationError(`Invalid login response format. Response: ${JSON.stringify(response)}`);
    }
    this.authenticated = true;
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
    await this.ensureAuthenticated();
    await this.http.request({
      method: 'DELETE',
      endpoint: this.accountEndpoint(`/list/${listId}`),
    });
    return true;
  }

  // --- Items ---

  async addItem(listId: string, text: string, position = 0): Promise<CoziItem> {
    if (!text.trim()) throw new ValidationError('Item text cannot be empty');
    await this.ensureAuthenticated();
    const response = await this.http.request({
      method: 'POST',
      endpoint: this.accountEndpoint(`/list/${listId}/item/`),
      body: { text, position },
    });
    return CoziItemSchema.parse(response);
  }

  async updateItemText(listId: string, itemId: string, text: string): Promise<CoziItem> {
    if (!text.trim()) throw new ValidationError('Item text cannot be empty');
    await this.ensureAuthenticated();
    const response = await this.http.request({
      method: 'PUT',
      endpoint: this.accountEndpoint(`/list/${listId}/item/${itemId}`),
      body: { text },
    });
    return CoziItemSchema.parse(response);
  }

  async markItem(listId: string, itemId: string, status: ItemStatus): Promise<CoziItem> {
    await this.ensureAuthenticated();
    const response = await this.http.request({
      method: 'PUT',
      endpoint: this.accountEndpoint(`/list/${listId}/item/${itemId}`),
      body: { status },
    });
    return CoziItemSchema.parse(response);
  }

  async removeItems(listId: string, itemIds: string[]): Promise<boolean> {
    if (itemIds.length === 0) return true;
    await this.ensureAuthenticated();
    const operations = itemIds.map((id) => ({ op: 'remove', path: `/items/${id}` }));
    await this.http.request({
      method: 'PATCH',
      endpoint: this.accountEndpoint(`/list/${listId}`),
      body: { operations },
    });
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
    await this.http.request({
      method: 'POST',
      endpoint: this.accountEndpoint(`/calendar/${year}/${month}`),
      body: [toApiEditFormat(appt)],
    });
    return appt;
  }

  async deleteAppointment(appointmentId: string, year: number, month: number): Promise<boolean> {
    await this.ensureAuthenticated();
    await this.http.request({
      method: 'POST',
      endpoint: this.accountEndpoint(`/calendar/${year}/${month}`),
      body: [toApiDeleteFormat({ id: appointmentId } as CoziAppointment)],
    });
    return true;
  }
}
