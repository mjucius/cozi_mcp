// Shared by release-sign.mjs (the maintainer's machine, offline key) and release-sign-ci.mjs
// (release.yml's sign-worker job). Node built-ins only: the CI signing job installs no
// dependencies, so no package code runs next to the key.
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const NAME = '@mjucius/cozi-mcp';
export const run = (cmd, argv, cwd) => execFileSync(cmd, argv, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
export const previousTag = (tag) => run('git', ['describe', '--tags', '--abbrev=0', `${tag}^`]).trim();

/** The raw public key (base64) and its id, as `src/update-keys.ts` lists them. */
export function publicHalf(privateKey) {
  const raw = Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x, 'base64url');
  return { raw: raw.toString('base64'), keyId: sha256(raw).slice(0, 8) };
}

/** Refuses unless the bundle and the tag's package.json both report `version`. */
export function checkVersion(worker, version, pkgVersion) {
  const built = /SERVER_VERSION = "(\d+\.\d+\.\d+)"/.exec(worker.toString())?.[1];
  if (pkgVersion !== version || built !== version) {
    throw new Error(`v${version} has package.json ${pkgVersion} and SERVER_VERSION ${built}; not signing.`);
  }
}

/** npm's published dist/worker.js, unpacked under `dir`. `tries` covers a publish that is still propagating. */
export function publishedWorker(version, dir, tries = 1) {
  for (let i = 1; ; i++) {
    try {
      run('npm', ['pack', `${NAME}@${version}`, '--pack-destination', dir, '--prefer-online', '--silent'], dir);
      break;
    } catch (err) {
      if (i >= tries) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
    }
  }
  run('tar', ['-xzf', `mjucius-cozi-mcp-${version}.tgz`, 'package/dist/worker.js'], dir);
  return readFileSync(join(dir, 'package', 'dist', 'worker.js'));
}

/**
 * Deployed Workers verify a release with the keys of the release they run, so the key must
 * already be in the previous release's src/update-keys.ts, and still be in this one's.
 */
export function checkKeyTrusted(privateKey, tag, previous) {
  const { raw, keyId } = publicHalf(privateKey);
  const keysAt = (ref) => {
    try {
      return run('git', ['show', `${ref}:src/update-keys.ts`]);
    } catch {
      return null;
    }
  };
  if (keysAt(tag) === null) throw new Error(`${tag} has no src/update-keys.ts; not signing.`);
  for (const ref of [tag, previous]) {
    const keys = keysAt(ref);
    // The first release with self-update has no earlier key file; nothing runs an older updater.
    if (keys !== null && !keys.includes(`'${raw}'`)) {
      throw new Error(
        `Key ${keyId} is not in ${ref}'s src/update-keys.ts; not signing. A new key signs only from ` +
          'the release after the one that adds it, so sign this release with a key it already trusts.',
      );
    }
  }
}

/** The signed document: deployed Workers check its name, version, age and the bundle's hash. */
export function manifestFor(version, worker, now = new Date()) {
  return Buffer.from(JSON.stringify({ name: NAME, version, sha256: sha256(worker), signedAt: now.toISOString() }));
}

/** worker-manifest.sig: `<keyId>:<base64 Ed25519 signature>`, what verifyManifest in src/update.ts reads. */
export function signatureLine(manifest, privateKey) {
  return `${publicHalf(privateKey).keyId}:${sign(null, manifest, privateKey).toString('base64')}\n`;
}

export function upload(tag, dir, worker, manifest, sigLine) {
  mkdirSync(dir);
  writeFileSync(join(dir, 'worker.js'), worker);
  writeFileSync(join(dir, 'worker-manifest.json'), manifest);
  writeFileSync(join(dir, 'worker-manifest.sig'), sigLine);
  run('gh', ['release', 'upload', tag, ...['worker.js', 'worker-manifest.json', 'worker-manifest.sig'].map((f) => join(dir, f)), '--clobber']);
}
