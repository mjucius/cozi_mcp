import { OAuthError, OAuthProvider, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { handleAuthorize, handleMcp, landingPage, refreshProps, tokenGate, type RemoteProps, type UpdateStatus } from './remote.js';
import { checkForUpdate, STATUS_KEY, updatesEnabled, WORKER_HOST_KEY } from './update.js';

/**
 * Cloudflare Worker entry for the remote deploy (deploy/cloudflare). One OAuthProvider per
 * origin guards /mcp; everything else is the sign-in page, the landing page and the daily
 * signed self-update. Secrets: ALLOWED_EMAIL (the one Cozi account allowed to sign in) and
 * CF_API_TOKEN (Workers Scripts: Edit, for self-update; "off" disables it).
 */

interface Env {
  OAUTH_KV: KVNamespace;
  ALLOWED_EMAIL?: string;
  CF_API_TOKEN?: string;
  SIGNIN_LIMIT?: RateLimit;
  OAUTH_PROVIDER: OAuthHelpers;
}

const apiHandler = {
  fetch: (request: Request, _env: Env, ctx: ExecutionContext) => handleMcp(request, ctx.props as RemoteProps),
};

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/authorize') return handleAuthorize(request, env);
    if (url.pathname === '/' && request.method === 'GET') {
      const status = await env.OAUTH_KV.get<UpdateStatus>(STATUS_KEY, 'json');
      return landingPage(url.origin, { enabled: updatesEnabled(env), status });
    }
    return new Response('Not found', { status: 404 });
  },
};

// The protected resource must name the exact URL Claude connects to, so it is built from
// the request's own origin: nobody has to enter it, and renaming the Worker just works.
const providers = new Map<string, OAuthProvider<Env>>();
function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler,
      defaultHandler,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      clientIdMetadataDocumentEnabled: true,
      resourceMetadata: { resource: `${origin}/mcp`, resource_name: 'Cozi' },
      refreshTokenIdleTTL: 30 * 24 * 3600,
      async tokenExchangeCallback({ grantType, props }) {
        if (grantType !== 'refresh_token') return;
        try {
          return { newProps: await refreshProps(props as RemoteProps) };
        } catch {
          throw new OAuthError('temporarily_unavailable', {
            description: 'Cozi did not accept the saved sign-in. If the Cozi password changed, reconnect in Claude.',
            statusCode: 503,
            headers: { 'Retry-After': '300' },
          });
        }
      },
    });
    providers.set(origin, provider);
  }
  return provider;
}

let workerHostSaved = false;
// The cron has no request to learn the Worker's own address from, and the update API needs it.
async function rememberWorkerHost(url: URL, env: Env): Promise<void> {
  if (workerHostSaved || !url.hostname.endsWith('.workers.dev')) return;
  const host = url.hostname.split('.').slice(0, 2).join('.');
  if ((await env.OAUTH_KV.get(WORKER_HOST_KEY)) !== host) await env.OAUTH_KV.put(WORKER_HOST_KEY, host);
  workerHostSaved = true;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/token') {
      const refused = await tokenGate(request);
      if (refused) return refused;
    }
    ctx.waitUntil(rememberWorkerHost(url, env));
    // A per-request view of env: the provider caches its helpers on env, which would otherwise
    // tie every later sign-in in this isolate to whichever origin was served first.
    return providerFor(url.origin).fetch(request, Object.create(env) as Env, ctx);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(checkForUpdate(env));
  },
} satisfies ExportedHandler<Env>;
