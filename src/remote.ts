import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { AuthenticationError, CoziClient, type CoziSession } from './cozi/index.js';
import createServer, { SERVER_VERSION } from './server.js';

/**
 * The remote Worker's request handling, kept free of `cloudflare:workers` imports so the
 * Node test suite can drive it. `worker.ts` wires it into the OAuth provider.
 */

/** Claude's published OAuth identity (a Client ID Metadata Document); the only client v1 accepts. */
export const CLAUDE_CLIENT_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const CLAUDE_ORIGINS = ['https://claude.ai', 'https://claude.com'];

/** What a grant carries, encrypted by the OAuth provider under a key only its tokens unwrap. */
export interface RemoteProps {
  u: string;
  p: string;
  tz?: string;
  session?: CoziSession;
}

export interface SignInEnv {
  ALLOWED_EMAIL?: string;
  SIGNIN_LIMIT?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  OAUTH_PROVIDER: Pick<OAuthHelpers, 'parseAuthRequest' | 'completeAuthorization'>;
}

/** Logs in to Cozi and returns the session, or throws (AuthenticationError on rejected credentials). */
export type CoziLogin = (email: string, password: string) => Promise<CoziSession>;

const coziLogin: CoziLogin = async (email, password) => {
  const client = new CoziClient(email, password);
  await client.authenticate();
  const session = client.exportSession();
  if (!session) throw new AuthenticationError('Cozi returned no session');
  return session;
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// `formTarget` must name where a successful sign-in redirects: Chrome applies form-action to
// the redirect after a form POST too, not only to the POST itself.
function page(title: string, body: string, nonce?: string, formTarget?: string): Response {
  const csp =
    `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${formTarget ? ` ${formTarget}` : ''}; ` +
    "base-uri 'none'; frame-ancestors 'none'" +
    (nonce ? `; script-src 'nonce-${nonce}'` : '');
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>` +
      `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem}` +
      `input{display:block;width:100%;padding:.5rem;margin:.25rem 0 1rem;box-sizing:border-box}` +
      `button{padding:.6rem 1.2rem}code{font-size:.85em;word-break:break-all}.err{color:#b00020}` +
      `.add{display:inline-block;padding:.6rem 1.2rem;background:#1a56db;color:#fff;border-radius:.4rem;text-decoration:none}</style></head>` +
      `<body>${body}</body></html>`,
    {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': csp,
        'X-Frame-Options': 'DENY',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      },
    },
  );
}

const refusal = (message: string, status = 400) => {
  const res = page('Cozi connector', `<h1>Can't continue</h1><p>${escapeHtml(message)}</p>`);
  return new Response(res.body, { status, headers: res.headers });
};

/** Only Claude may start a sign-in; anything else gets a local page, never a redirect. */
export function authorizeGate(url: URL): Response | null {
  return url.searchParams.get('client_id') === CLAUDE_CLIENT_ID
    ? null
    : refusal('This connector only accepts sign-ins started from Claude.');
}

/**
 * Turn away token requests from any client but Claude before the provider sees them. The
 * provider resolves a URL-shaped client_id by fetching it, and checks a signed client
 * assertion by writing its id to KV, both before it looks at the code or refresh token, so
 * without this gate anyone could make the Worker fetch their URL or spend the KV write quota.
 */
export async function tokenGate(request: Request): Promise<Response | null> {
  if (request.method !== 'POST') return null;
  const form = await request.clone().formData().catch(() => null);
  const ok =
    form?.get('client_id') === CLAUDE_CLIENT_ID &&
    !form.has('client_assertion') &&
    !request.headers.get('Authorization');
  return ok
    ? null
    : Response.json(
        { error: 'invalid_client', error_description: 'Only Claude can use this server.' },
        { status: 401, headers: { 'Cache-Control': 'no-store' } },
      );
}

function validTimeZone(tz: unknown): string | undefined {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

function signInPage(url: URL, authRequest: AuthRequest, error?: string): Response {
  const nonce = crypto.randomUUID();
  const action = `${url.pathname}${url.search}`;
  return page(
    'Connect Claude to Cozi',
    `<h1>Connect Claude to your Cozi</h1>` +
      `<p>Claude (<code>${escapeHtml(new URL(authRequest.redirectUri).host)}</code>) is asking to read and ` +
      `change your Cozi lists and calendar. Sign in with your Cozi account to allow it.</p>` +
      `<p>This is a private connector running in its owner's Cloudflare account, not Cozi's own website.</p>` +
      (error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : '') +
      `<form method="post" action="${escapeHtml(action)}">` +
      `<label>Cozi email<input name="email" type="email" autocomplete="username" required></label>` +
      `<label>Cozi password<input name="password" type="password" autocomplete="current-password" required></label>` +
      `<input type="hidden" name="tz" id="tz">` +
      `<p>Time zone: <span id="tzshow">UTC</span></p>` +
      `<button type="submit">Sign in and connect</button></form>` +
      `<script nonce="${nonce}">const z=Intl.DateTimeFormat().resolvedOptions().timeZone||'';` +
      `document.getElementById('tz').value=z;document.getElementById('tzshow').textContent=z||'UTC';</script>`,
    nonce,
    // Already checked against Claude's registered redirect URIs by parseAuthRequest.
    new URL(authRequest.redirectUri).origin,
  );
}

/**
 * GET shows the sign-in form; POST checks it and completes the authorization. Nothing is
 * written to KV until Cozi has accepted the password, so an anonymous visitor costs
 * nothing from the free plan's daily write quota.
 */
export async function handleAuthorize(request: Request, env: SignInEnv, login: CoziLogin = coziLogin): Promise<Response> {
  const url = new URL(request.url);
  const gate = authorizeGate(url);
  if (gate) return gate;

  let authRequest: AuthRequest;
  try {
    authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch {
    return refusal('This sign-in link is not valid. Start again from Claude.');
  }
  if (request.method === 'GET') return signInPage(url, authRequest);
  if (request.method !== 'POST') return refusal('Unsupported request.', 405);

  const allowed = env.ALLOWED_EMAIL?.trim().toLowerCase();
  if (!allowed) return refusal('This server is not set up yet: ALLOWED_EMAIL is missing in its Cloudflare settings.', 503);

  const form = await request.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  const password = String(form.get('password') ?? '');
  const tz = validTimeZone(form.get('tz'));
  const failed = 'That email and password did not work.';
  if (email !== allowed || !password) return signInPage(url, authRequest, failed);

  // Approximate and per Cloudflare location; Cozi's own login throttling is the backstop.
  if (env.SIGNIN_LIMIT && !(await env.SIGNIN_LIMIT.limit({ key: 'signin' })).success) {
    return signInPage(url, authRequest, 'Too many attempts. Wait a minute and try again.');
  }

  // Log in as the configured account, not the typed string, so no look-alike email reaches Cozi.
  const u = env.ALLOWED_EMAIL!.trim();
  let session: CoziSession;
  try {
    session = await login(u, password);
  } catch (err) {
    return signInPage(url, authRequest, err instanceof AuthenticationError ? failed : 'Could not reach Cozi. Try again.');
  }

  const props: RemoteProps = { u, p: password, ...(tz ? { tz } : {}), session };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authRequest,
    userId: 'owner',
    metadata: {},
    scope: authRequest.scope,
    props,
    // Each family member's Claude account keeps its own connection.
    revokeExistingGrants: false,
  });
  return Response.redirect(redirectTo, 302);
}

/**
 * On every token refresh, log in to Cozi again: no new access token without a password
 * Cozi still accepts, so a changed password cuts every connector off within the hour
 * (VULN-004). Any failure is reported as temporary rather than revoking the grant: Cozi
 * answers a wrong password and its own outages with the same 401, and a revoked grant would
 * make every household reconnect by hand after a Cozi-side breakage is fixed.
 */
export async function refreshProps(props: RemoteProps, login: CoziLogin = coziLogin): Promise<RemoteProps> {
  return { ...props, session: await login(props.u, props.p) };
}

export interface McpDeps {
  makeClient?: (props: RemoteProps) => CoziClient;
}

/** One stateless MCP exchange: a fresh server and transport per request, and one Cozi client. */
export async function handleMcp(request: Request, props: RemoteProps, deps: McpDeps = {}): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
  }
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin && !CLAUDE_ORIGINS.includes(origin)) {
    return new Response('Forbidden', { status: 403 });
  }
  const makeClient = deps.makeClient ?? ((p: RemoteProps) => new CoziClient(p.u, p.p, p.session));
  let client: CoziClient | undefined;
  const server = createServer({
    config: { username: props.u, password: props.p, timeZone: props.tz },
    getClient: async () => (client ??= makeClient(props)),
  });
  // No sessionIdGenerator: stateless mode, which is what claude.ai expects.
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}

export interface UpdateStatus {
  at: string;
  result: string;
}

const AFTER_SETUP = 'https://github.com/mjucius/cozi_mcp/blob/main/docs/cloudflare-setup.md';

/** The page a person sees when they open the Worker's own URL. */
export function landingPage(origin: string, update: { enabled: boolean; status: UpdateStatus | null }): Response {
  // A stored "off" predates the token, so until the next check it would contradict the secret.
  const status = update.enabled
    ? update.status && update.status.result !== 'off'
      ? `${escapeHtml(update.status.result)} (checked ${escapeHtml(update.status.at.slice(0, 16).replace('T', ' '))} UTC)`
      : 'on, not checked yet'
    : 'off (the CF_API_TOKEN secret is missing or set to off)';
  const connector = `${origin}/mcp`;
  const addToClaude =
    `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Cozi` +
    `&connectorUrl=${encodeURIComponent(connector)}`;
  return page(
    'Cozi connector',
    `<h1>Your Cozi connector is running</h1>` +
      `<p><a class="add" href="${escapeHtml(addToClaude)}">Add to Claude</a></p>` +
      `<ol><li>Click <b>Add to Claude</b>. Claude opens with this server already filled in.</li>` +
      `<li>Click <b>Continue</b>, then <b>Add</b>. Leave the settings as they are.</li>` +
      `<li>Click <b>Connect</b> and sign in with your Cozi email and password.</li></ol>` +
      `<p>To add it by hand, this is the connector URL:<br><code>${escapeHtml(connector)}</code></p>` +
      `<p>Version ${escapeHtml(SERVER_VERSION)}. Automatic updates: ${status}.</p>` +
      `<p><a href="${AFTER_SETUP}">Updates, settings and troubleshooting</a></p>`,
  );
}
