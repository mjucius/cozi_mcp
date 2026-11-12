import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs release script, no type declarations
import { manifestFor, publicHalf, signatureLine } from '../scripts/release-lib.mjs';
import { UPDATE_KEYS } from '../src/update-keys.js';
import { verifyManifest } from '../src/update.js';

// The release scripts sign what deployed Workers verify. A mismatch would stop every
// server from updating, and nothing else checks it before a real release.
describe('release signing', () => {
  it('produces a manifest and signature that the Worker accepts', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const { raw, keyId } = publicHalf(privateKey);
    const manifest: Buffer = manifestFor('9.9.9', Buffer.from('export default {}'));
    const sig: string = signatureLine(manifest, privateKey);

    expect(await verifyManifest(manifest, sig, { [keyId]: raw })).toBe(true);
    expect(await verifyManifest(Buffer.from(manifest.toString().replace('9.9.9', '9.9.8')), sig, { [keyId]: raw })).toBe(false);
    expect(await verifyManifest(manifest, sig, { ...UPDATE_KEYS })).toBe(false);
  });

  it('derives key ids the way the shipped keys were named', () => {
    for (const [keyId, raw] of Object.entries(UPDATE_KEYS)) {
      expect(createHash('sha256').update(Buffer.from(raw, 'base64')).digest('hex').slice(0, 8)).toBe(keyId);
    }
  });
});
