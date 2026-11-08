import { SERVER_VERSION } from './server.js';
import { UPDATE_KEYS } from './update-keys.js';

/**
 * The remote Worker's daily self-update. It adopts a release only when the manifest is
 * signed by a key in UPDATE_KEYS within MAX_SIGNATURE_AGE_MS, names a newer version it has
 * not installed before (so an owner's rollback sticks), has stayed the same signed release
 * for HOLD_MS from this Worker's own first sighting (so whoever signs cannot shorten the
 * hold, and a pulled release that reappears waits again), and the downloaded worker.js
 * matches the signed hash. It then replaces its own code through the Cloudflare API with
 * the token the owner gave it.
 */

export const PACKAGE_NAME = '@mjucius/cozi-mcp';
export const RELEASES = 'https://github.com/mjucius/cozi_mcp/releases';
export const HOLD_MS = 3 * 24 * 3600_000;
export const MAX_SIGNATURE_AGE_MS = 30 * 24 * 3600_000;
const API = 'https://api.cloudflare.com/client/v4';

export interface UpdateKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface UpdateEnv {
  OAUTH_KV: UpdateKv;
  CF_API_TOKEN?: string;
}

export interface UpdateOptions {
  keys?: Record<string, string>;
  releases?: string;
  now?: number;
  fetch?: typeof fetch;
}

/** `<script name>.<account subdomain>`, learned from the Worker's own workers.dev address. */
export const WORKER_HOST_KEY = 'update:host';
export const STATUS_KEY = 'update:status';
/** {version, sha256, since}: the signed release this Worker is holding, and since when. */
export const PENDING_KEY = 'update:pending';
/** The last version this Worker installed itself; finding it again means the owner rolled back. */
export const INSTALLED_KEY = 'update:installed';

export function updatesEnabled(env: { CF_API_TOKEN?: string }): boolean {
  const token = env.CF_API_TOKEN?.trim();
  return !!token && token.toLowerCase() !== 'off';
}

/** True when `a` is a later x.y.z than `b`. */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** `sig` is the release's worker-manifest.sig: `<keyId>:<base64 signature>`. */
export async function verifyManifest(
  manifest: ArrayBuffer,
  sig: string,
  keys: Record<string, string>,
): Promise<boolean> {
  const [keyId, signature] = sig.trim().split(':');
  const raw = keyId && Object.hasOwn(keys, keyId) ? keys[keyId] : undefined;
  if (typeof raw !== 'string' || !signature) return false;
  try {
    const key = await crypto.subtle.importKey('raw', fromBase64(raw), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, fromBase64(signature), manifest);
  } catch {
    return false;
  }
}

/** Runs one check, records its outcome in KV for the landing page, and returns it. */
export async function checkForUpdate(env: UpdateEnv, options: UpdateOptions = {}): Promise<string> {
  const result = await runCheck(env, options).catch((err: Error) => `error: ${err.message}`);
  await env.OAUTH_KV.put(STATUS_KEY, JSON.stringify({ at: new Date(options.now ?? Date.now()).toISOString(), result }));
  return result;
}

async function runCheck(env: UpdateEnv, options: UpdateOptions): Promise<string> {
  if (!updatesEnabled(env)) return 'off';
  const keys = options.keys ?? UPDATE_KEYS;
  const releases = options.releases ?? RELEASES;
  const now = options.now ?? Date.now();
  const get = options.fetch ?? fetch;

  const [manifestRes, sigRes] = await Promise.all([
    get(`${releases}/latest/download/worker-manifest.json`),
    get(`${releases}/latest/download/worker-manifest.sig`),
  ]);
  // CI publishes a release before the maintainer signs it; a deleted signature also lands here.
  if (manifestRes.status === 404 || sigRes.status === 404) {
    await clearPending(env);
    return 'up to date (latest release not signed yet)';
  }
  if (!manifestRes.ok || !sigRes.ok) return `error: release download failed (${manifestRes.status}/${sigRes.status})`;
  const manifestBytes = await manifestRes.arrayBuffer();
  if (!(await verifyManifest(manifestBytes, await sigRes.text(), keys))) {
    await clearPending(env);
    return 'error: release signature not valid';
  }

  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
    name?: string;
    version?: string;
    sha256?: string;
    signedAt?: string;
  };
  const { version, sha256 } = manifest;
  if (manifest.name !== PACKAGE_NAME || !version || !/^\d+\.\d+\.\d+$/.test(version) || !sha256) {
    return 'error: release manifest malformed';
  }
  if (!isNewer(version, SERVER_VERSION)) return 'up to date';
  // A signature expires, so one saved from a release that was pulled cannot be put back later.
  const signedAt = Date.parse(manifest.signedAt ?? '');
  if (!(now - signedAt <= MAX_SIGNATURE_AGE_MS && signedAt - now < 24 * 3600_000)) {
    return `${version} skipped: its signature is too old; waiting for a newer release`;
  }
  if ((await env.OAUTH_KV.get(INSTALLED_KEY)) === version) {
    return `rolled back from ${version}; waiting for a newer release`;
  }

  const pending = JSON.parse((await env.OAUTH_KV.get(PENDING_KEY)) ?? 'null') as
    | { version: string; sha256: string; since: number }
    | null;
  if (pending?.version !== version || pending.sha256 !== sha256) {
    await env.OAUTH_KV.put(PENDING_KEY, JSON.stringify({ version, sha256, since: now }));
    return `${version} found, installing after a ${HOLD_MS / 3600_000} h hold`;
  }
  if (now - pending.since < HOLD_MS) return `${version} waiting for its hold to end`;

  const [scriptName, subdomain] = ((await env.OAUTH_KV.get(WORKER_HOST_KEY)) ?? '').split('.');
  if (!scriptName || !subdomain) return 'waiting: open the Worker URL once so it learns its own name';

  // A token can see several accounts, or only the wrong one. A same-named Worker elsewhere must
  // never be overwritten, so upload only to the account this Worker's own address belongs to.
  const auth = { Authorization: `Bearer ${env.CF_API_TOKEN!.trim()}` };
  const accounts = (await (await get(`${API}/accounts`, { headers: auth })).json()) as { result?: { id: string }[] };
  let accountId: string | undefined;
  for (const { id } of accounts.result ?? []) {
    const res = await get(`${API}/accounts/${id}/workers/subdomain`, { headers: auth });
    const owned = res.ok && ((await res.json()) as { result?: { subdomain?: string } }).result?.subdomain === subdomain;
    if (owned) {
      accountId = id;
      break;
    }
  }
  if (!accountId) return "error: the update token cannot see this server's Cloudflare account";

  const codeRes = await get(`${releases}/download/v${version}/worker.js`);
  if (!codeRes.ok) return `error: worker.js download failed (${codeRes.status})`;
  const code = await codeRes.blob();
  if (hex(await crypto.subtle.digest('SHA-256', await code.arrayBuffer())) !== sha256) {
    return 'error: worker.js does not match the signed hash';
  }

  const form = new FormData();
  form.append('metadata', JSON.stringify({ main_module: 'worker.js' }));
  form.append('worker.js', code.slice(0, code.size, 'application/javascript+module'), 'worker.js');
  const upload = await get(`${API}/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/content`, {
    method: 'PUT',
    headers: auth,
    body: form,
  });
  if (!upload.ok) return `error: Cloudflare refused the update (${upload.status})`;
  await env.OAUTH_KV.put(INSTALLED_KEY, version);
  await clearPending(env);
  return `updated to ${version}`;
}

async function clearPending(env: UpdateEnv): Promise<void> {
  if (await env.OAUTH_KV.get(PENDING_KEY)) await env.OAUTH_KV.delete(PENDING_KEY);
}
