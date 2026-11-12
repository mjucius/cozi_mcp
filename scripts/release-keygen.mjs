#!/usr/bin/env node
// Makes an Ed25519 key that signs remote self-update releases. Two kinds:
//
//   node scripts/release-keygen.mjs <path-for-private-key.pem>
//     The maintainer's offline key. Move the file into your password manager (plus one
//     backup) and delete it from disk: it must never sit in this repository, in CI, or
//     anywhere a dependency's install script can read it.
//
//   node scripts/release-keygen.mjs - | gh secret set WORKER_SIGNING_KEY --env worker-signing
//     The key release.yml signs with after you approve. The private key goes straight from
//     stdout into the environment secret and never touches disk.
//
// Either way, add the printed line to UPDATE_KEYS in src/update-keys.ts.
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { publicHalf } from './release-lib.mjs';

const out = process.argv[2];
if (!out) {
  process.stderr.write('usage: node scripts/release-keygen.mjs <path-for-private-key.pem | ->\n');
  process.exit(1);
}
const { privateKey } = generateKeyPairSync('ed25519');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
// 'wx' refuses to overwrite an existing key.
if (out === '-') process.stdout.write(pem);
else writeFileSync(out, pem, { mode: 0o600, flag: 'wx' });
const { raw, keyId } = publicHalf(privateKey);
(out === '-' ? process.stderr : process.stdout).write(
  (out === '-' ? '' : `Private key written to ${out}. Move it into your password manager now and delete the file.\n\n`) +
    `Add this entry to UPDATE_KEYS in src/update-keys.ts:\n\n  '${keyId}': '${raw}',\n`,
);
