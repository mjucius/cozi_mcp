#!/usr/bin/env node
// One-time: node scripts/release-keygen.mjs <path-for-private-key.pem>
//
// Creates the offline Ed25519 key that signs remote self-update releases. Move the private
// key file into your password manager (plus one backup) and delete it from disk: it must
// never sit in this repository, in CI, or anywhere a dependency's install script can read
// it. Paste the printed line into src/update-keys.ts.
import { createHash, generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const out = process.argv[2];
if (!out) {
  process.stderr.write('usage: node scripts/release-keygen.mjs <path-for-private-key.pem>\n');
  process.exit(1);
}
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
// 'wx' refuses to overwrite an existing key.
writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
const keyId = createHash('sha256').update(raw).digest('hex').slice(0, 8);
process.stdout.write(
  `Private key written to ${out}. Move it into your password manager now and delete the file.\n\n` +
    `Add this entry to UPDATE_KEYS in src/update-keys.ts:\n\n  '${keyId}': '${raw.toString('base64')}',\n`,
);
