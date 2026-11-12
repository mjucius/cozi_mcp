#!/usr/bin/env node
// Run by release.yml's sign-worker job once the maintainer approves the worker-signing
// environment, from a checkout of the tag:
//   node scripts/release-sign-ci.mjs vX.Y.Z <the build job's dist/worker.js>
// with WORKER_SIGNING_KEY (the environment's PEM secret) and GH_TOKEN set.
//
// The same checks as sign-release, except the tag signature and the rebuild on a machine CI
// doesn't control: npm's published worker.js must be byte for byte the build job's, both
// must report the tag's version, and the key must already be trusted by the previous
// release. Then it signs and uploads worker.js, worker-manifest.json and .sig.
import { createPrivateKey } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkKeyTrusted, checkVersion, manifestFor, previousTag, publishedWorker, sha256, signatureLine, upload } from './release-lib.mjs';

const [tag, workerPath] = process.argv.slice(2);
const pem = process.env.WORKER_SIGNING_KEY;
// npm and gh run as child processes below; they don't need the key.
delete process.env.WORKER_SIGNING_KEY;
if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '') || !workerPath || !pem) {
  process.stderr.write('usage: WORKER_SIGNING_KEY=<pem> node scripts/release-sign-ci.mjs vX.Y.Z <worker.js>\n');
  process.exit(1);
}
const version = tag.slice(1);
const work = mkdtempSync(join(tmpdir(), 'cozi-sign-'));

try {
  const built = readFileSync(workerPath);
  checkVersion(built, version, JSON.parse(readFileSync('package.json', 'utf8')).version);
  // The publish job finished moments ago; give the registry up to five minutes.
  const published = publishedWorker(version, work, 10);
  if (!built.equals(published)) {
    throw new Error(`The build job's worker.js (${sha256(built)}) differs from npm's (${sha256(published)}); not signing.`);
  }
  const privateKey = createPrivateKey(pem);
  checkKeyTrusted(privateKey, tag, previousTag(tag));
  const manifest = manifestFor(version, built);
  upload(tag, join(work, 'out'), built, manifest, signatureLine(manifest, privateKey));
  process.stdout.write(`Signed and uploaded ${manifest}\n`);
} catch (err) {
  process.stderr.write(`::error::${err.message}\n`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
