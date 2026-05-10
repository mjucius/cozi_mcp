import {
  APIError,
  AuthenticationError,
  CoziError,
  NetworkError,
  PermissionDeniedError,
  RateLimitError,
  ResourceNotFoundError,
} from './errors.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const parseSetCookie = (raw: string): { name: string; value: string } | null => {
  const semi = raw.indexOf(';');
  const pair = semi === -1 ? raw : raw.slice(0, semi);
  const eq = pair.indexOf('=');
  if (eq === -1) return null;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!name) return null;
  return { name, value };
};

export class CookieJar {
  private readonly cookies = new Map<string, string>();

  ingest(headers: Headers): void {
    const setCookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    for (const raw of setCookies) {
      const parsed = parseSetCookie(raw);
      if (parsed) this.cookies.set(parsed.name, parsed.value);
    }
  }

  header(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return Array.from(this.cookies, ([n, v]) => `${n}=${v}`).join('; ');
  }

  clear(): void {
    this.cookies.clear();
  }
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  endpoint: string;
  body?: unknown;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  requireAuth?: boolean;
}

export interface HttpClientOptions {
  baseUrl: string;
  retryAttempts?: number;
  requestTimeoutMs?: number;
  minRequestIntervalMs?: number;
  reauthenticate?: () => Promise<void>;
  authHeader?: () => Record<string, string>;
}

export type HttpResponse = Record<string, unknown> | unknown[] | true;

export class HttpClient {
  readonly baseUrl: string;
  readonly cookies = new CookieJar();
  private readonly retryAttempts: number;
  private readonly requestTimeoutMs: number;
  private readonly minRequestIntervalMs: number;
  private readonly reauthenticate?: () => Promise<void>;
  private readonly authHeader?: () => Record<string, string>;
  private lastRequestAtMs = 0;

  constructor(opts: HttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.retryAttempts = opts.retryAttempts ?? 3;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.minRequestIntervalMs = opts.minRequestIntervalMs ?? 100;
    if (opts.reauthenticate) this.reauthenticate = opts.reauthenticate;
    if (opts.authHeader) this.authHeader = opts.authHeader;
  }

  async request(opts: RequestOptions): Promise<HttpResponse> {
    const url = this.buildUrl(opts.endpoint, opts.params);
    const requireAuth = opts.requireAuth ?? true;

    for (let attempt = 0; attempt < this.retryAttempts; attempt++) {
      await this.gate();

      let res: Response;
      const init: RequestInit = {
        method: opts.method,
        headers: this.buildHeaders(opts.headers, requireAuth),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      };
      if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
      try {
        res = await fetch(url, init);
      } catch (err) {
        if (attempt < this.retryAttempts - 1) {
          await sleep(2 ** attempt * 500);
          continue;
        }
        throw new NetworkError(`Network request failed: ${(err as Error).message}`);
      }

      this.cookies.ingest(res.headers);

      if (res.status === 200 || res.status === 201) return (await res.json()) as HttpResponse;
      if (res.status === 204) {
        await res.body?.cancel();
        return true;
      }

      const body = await this.safeJson(res);

      if (res.status === 401) {
        if (attempt === 0 && requireAuth && this.reauthenticate) {
          await this.reauthenticate();
          continue;
        }
        throw new AuthenticationError('Authentication failed', res.status, body);
      }
      if (res.status === 403) throw new PermissionDeniedError('Access forbidden', res.status, body);
      if (res.status === 404) throw new ResourceNotFoundError('Resource not found', res.status, body);
      if (res.status === 429) {
        if (attempt < this.retryAttempts - 1) {
          await sleep(2 ** attempt * 1000);
          continue;
        }
        throw new RateLimitError('API rate limit exceeded', res.status, body);
      }
      if (res.status >= 500 && res.status < 600) {
        if (attempt < this.retryAttempts - 1) {
          await sleep(2 ** attempt * 1000);
          continue;
        }
        throw new APIError(`Server error: ${res.status}`, res.status, body);
      }
      throw new APIError(`API request failed: ${res.status}`, res.status, body);
    }

    throw new APIError('Max retry attempts exceeded');
  }

  private buildUrl(endpoint: string, params?: Record<string, string>): string {
    const url = new URL(endpoint.startsWith('/') ? endpoint : `/${endpoint}`, `${this.baseUrl}/`);
    if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  }

  private buildHeaders(extra: Record<string, string> | undefined, requireAuth: boolean): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      Accept: 'application/json',
      Origin: 'https://my.cozi.com',
      Referer: 'https://my.cozi.com/',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    };
    if (requireAuth && this.authHeader) Object.assign(h, this.authHeader());
    const cookie = this.cookies.header();
    if (cookie) h['Cookie'] = cookie;
    if (extra) Object.assign(h, extra);
    return h;
  }

  private async gate(): Promise<void> {
    const now = Date.now();
    const wait = this.minRequestIntervalMs - (now - this.lastRequestAtMs);
    if (wait > 0) await sleep(wait);
    this.lastRequestAtMs = Date.now();
  }

  private async safeJson(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      return { error: 'No JSON content in error response' };
    }
  }
}

export function isCoziError(e: unknown): e is CoziError {
  return e instanceof CoziError;
}
