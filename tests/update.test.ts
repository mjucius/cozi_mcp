import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SERVER_VERSION } from '../src/server.js';
import {
  HOLD_MS,
  INSTALLED_KEY,
  MAX_SIGNATURE_AGE_MS,
  PACKAGE_NAME,
  PENDING_KEY,
  STATUS_KEY,
  WORKER_HOST_KEY,
  checkForUpdate,
  isNewer,
  verifyManifest,
  type UpdateEnv,
} from '../src/update.js';

// The self-update decides with signed bytes it fetched itself; these drive it with a test
// key and a stubbed network, the way `npm run sign-release` produces a release.

const RELEASES = 'https://github.example/releases';
const NOW = Date.UTC(2026, 10, 1);
const toB64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const sha256 = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
const bump = (v: string) => v.replace(/\d+$/, (n) => String(Number(n) + 1));

let keys: Record<string, string>;
let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  privateKey = pair.privateKey;
  keys = { k1: toB64(await crypto.subtle.exportKey('raw', pair.publicKey)) };
});

async function release(
  opts: { version?: string; code?: string; tamper?: boolean; keyId?: string; signedAt?: number } = {},
) {
  const code = new TextEncoder().encode(opts.code ?? 'export default {}');
  const manifest = new TextEncoder().encode(
    JSON.stringify({
      name: PACKAGE_NAME,
      version: opts.version ?? bump(SERVER_VERSION),
      sha256: await sha256(code),
      signedAt: new Date(opts.signedAt ?? NOW).toISOString(),
    }),
  );
  const sig = `${opts.keyId ?? 'k1'}:${toB64(await crypto.subtle.sign('Ed25519', privateKey, manifest))}`;
  if (opts.tamper) code[0] = 0;
  return { code, manifest, sig };
}

type Release = Awaited<ReturnType<typeof release>>;

function setup(initial: Release | null, env: Partial<UpdateEnv> = {}, accounts: Record<string, string> = { acct: 'family' }) {
  let rel = initial;
  const kv = new Map<string, string>([[WORKER_HOST_KEY, 'calendar-connector.family']]);
  const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const u = String(url);
    if (!rel && u.includes('/latest/download/')) return new Response('', { status: 404 });
    if (u.endsWith('/latest/download/worker-manifest.json')) return new Response(rel!.manifest);
    if (u.endsWith('/latest/download/worker-manifest.sig')) return new Response(rel!.sig);
    if (u.endsWith('/worker.js')) return new Response(rel!.code);
    if (u.endsWith('/accounts')) return Response.json({ result: Object.keys(accounts).map((id) => ({ id })) });
    const owned = u.match(/\/accounts\/([^/]+)\/workers\/subdomain$/);
    if (owned) return Response.json({ result: { subdomain: accounts[owned[1]!] } });
    if (u.includes('/workers/scripts/')) return Response.json({ success: true });
    return new Response('unexpected', { status: 500 });
  });
  const fullEnv: UpdateEnv = {
    OAUTH_KV: {
      get: async (k) => kv.get(k) ?? null,
      put: async (k, v) => void kv.set(k, v),
      delete: async (k) => void kv.delete(k),
    },
    CF_API_TOKEN: 'tok',
    ...env,
  };
  const run = (now = NOW) => checkForUpdate(fullEnv, { keys, releases: RELEASES, now, fetch: fetch as typeof globalThis.fetch });
  const uploads = () => fetch.mock.calls.filter(([u]) => String(u).includes('/workers/scripts/'));
  const publish = (next: Release | null) => void (rel = next);
  return { kv, fetch, run, uploads, publish };
}

describe('versions and signatures', () => {
  it('compares x.y.z numerically', () => {
    expect(isNewer('2.10.0', '2.9.9')).toBe(true);
    expect(isNewer('2.6.0', '2.6.0')).toBe(false);
    expect(isNewer('2.5.9', '2.6.0')).toBe(false);
  });

  it('accepts only a known key over the exact bytes', async () => {
    const { manifest, sig } = await release();
    expect(await verifyManifest(manifest.buffer as ArrayBuffer, sig, keys)).toBe(true);
    expect(await verifyManifest(manifest.buffer as ArrayBuffer, sig.replace('k1:', 'k2:'), keys)).toBe(false);
    const changed = new Uint8Array(manifest);
    changed[changed.length - 2] = 0x20;
    expect(await verifyManifest(changed.buffer, sig, keys)).toBe(false);
    expect(await verifyManifest(manifest.buffer as ArrayBuffer, 'garbage', keys)).toBe(false);
  });
});

describe('checkForUpdate', () => {
  it('does nothing, not even a download, when the token is missing or off', async () => {
    for (const CF_API_TOKEN of [undefined, ' OFF ']) {
      const { fetch, run, kv } = setup(await release(), CF_API_TOKEN === undefined ? { CF_API_TOKEN: '' } : { CF_API_TOKEN });
      expect(await run()).toBe('off');
      expect(fetch).not.toHaveBeenCalled();
      expect(JSON.parse(kv.get(STATUS_KEY)!)).toMatchObject({ result: 'off' });
    }
  });

  it('waits quietly while the latest release is unsigned', async () => {
    const { run, uploads } = setup(null);
    expect(await run()).toMatch(/not signed yet/);
    expect(uploads()).toHaveLength(0);
  });

  it('holds a new release from its first sighting, then installs it', async () => {
    const rel = await release();
    const { run, uploads, kv } = setup(rel);
    expect(await run()).toMatch(/found, installing after a 72 h hold/);
    expect(JSON.parse(kv.get(PENDING_KEY)!)).toMatchObject({ version: bump(SERVER_VERSION), since: NOW });
    expect(await run(NOW + HOLD_MS - 1)).toMatch(/waiting for its hold/);
    expect(uploads()).toHaveLength(0);

    expect(await run(NOW + HOLD_MS)).toBe(`updated to ${bump(SERVER_VERSION)}`);
    const [[url, init]] = uploads() as [[string, RequestInit]];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/workers/scripts/calendar-connector/content');
    expect(init.method).toBe('PUT');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok');
    const form = init.body as FormData;
    expect(JSON.parse(form.get('metadata') as string)).toEqual({ main_module: 'worker.js' });
    const part = form.get('worker.js') as Blob;
    expect(part.type).toBe('application/javascript+module');
    expect(await part.text()).toBe('export default {}');
    expect(kv.get(INSTALLED_KEY)).toBe(bump(SERVER_VERSION));
    expect(kv.has(PENDING_KEY)).toBe(false);
  });

  it('restarts the hold when the same version comes back with different signed code', async () => {
    const { run, uploads, publish } = setup(await release({ code: 'export default {}' }));
    await run();
    publish(await release({ code: 'export default { evil: 1 }' }));
    expect(await run(NOW + HOLD_MS)).toMatch(/found, installing after/);
    expect(await run(NOW + 2 * HOLD_MS - 1)).toMatch(/waiting for its hold/);
    expect(uploads()).toHaveLength(0);
  });

  it('a release that is pulled and put back waits a full hold again', async () => {
    const rel = await release();
    const { run, uploads, publish, kv } = setup(rel);
    await run();
    publish(null);
    expect(await run(NOW + 1)).toMatch(/not signed yet/);
    expect(kv.has(PENDING_KEY)).toBe(false);
    publish(rel);
    expect(await run(NOW + HOLD_MS)).toMatch(/found, installing after/);
    expect(uploads()).toHaveLength(0);
  });

  it("an owner's rollback sticks until a newer release", async () => {
    const { run, uploads, kv } = setup(await release());
    kv.set(INSTALLED_KEY, bump(SERVER_VERSION));
    expect(await run()).toMatch(/rolled back from/);
    expect(uploads()).toHaveLength(0);
  });

  it('refuses a signature older than the window or dated in the future', async () => {
    for (const signedAt of [NOW - MAX_SIGNATURE_AGE_MS - 1, NOW + 2 * 24 * 3600_000]) {
      const { run, uploads, kv } = setup(await release({ signedAt }));
      expect(await run()).toMatch(/signature is too old/);
      expect(kv.has(PENDING_KEY)).toBe(false);
      expect(uploads()).toHaveLength(0);
    }
  });

  it('refuses a release that is not newer, badly signed, or whose code does not match', async () => {
    const cases: [Awaited<ReturnType<typeof release>>, RegExp][] = [
      [await release({ version: SERVER_VERSION }), /^up to date$/],
      [await release({ keyId: 'unknown' }), /signature not valid/],
      [await release({ tamper: true }), /does not match the signed hash/],
    ];
    for (const [rel, expected] of cases) {
      const { run, uploads } = setup(rel);
      await run();
      expect(await run(NOW + HOLD_MS)).toMatch(expected);
      expect(uploads()).toHaveLength(0);
    }
  });

  it('cannot install until the Worker has learned its own name', async () => {
    const { run, kv, uploads } = setup(await release());
    kv.delete(WORKER_HOST_KEY);
    await run();
    expect(await run(NOW + HOLD_MS)).toMatch(/learns its own name/);
    expect(uploads()).toHaveLength(0);
  });

  it("uploads only to the account that holds this Worker's address", async () => {
    const { run, uploads } = setup(await release(), {}, { other: 'someone-else', acct: 'family' });
    await run();
    expect(await run(NOW + HOLD_MS)).toBe(`updated to ${bump(SERVER_VERSION)}`);
    const [[url]] = uploads() as [[string, RequestInit]];
    expect(url).toContain('/accounts/acct/workers/scripts/calendar-connector/content');
  });

  it('refuses a token made in a different account, before downloading anything', async () => {
    const { run, uploads, fetch } = setup(await release(), {}, { other: 'someone-else' });
    await run();
    expect(await run(NOW + HOLD_MS)).toMatch(/cannot see this server's Cloudflare account/);
    expect(uploads()).toHaveLength(0);
    expect(fetch.mock.calls.some(([u]) => String(u).endsWith('/worker.js'))).toBe(false);
  });
});
