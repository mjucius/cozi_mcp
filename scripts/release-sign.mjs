#!/usr/bin/env node
// Signs a published release with the maintainer's offline key, for when release.yml's
// sign-worker job can't (a release that adds a new CI key, or a key rotation):
//   npm run sign-release -- vX.Y.Z --key <(op read "op://…/cozi-mcp release key")
//
// 1. Requires the tag to carry your valid signature, and shows what changed since the
//    previous release, so you review what you are about to sign.
// 2. Builds dist/worker.js from a clean checkout of the tag (dependency install scripts
//    off) and refuses unless it is byte for byte the worker.js npm published, and both
//    report the tag's version.
// 3. Only after you confirm, reads the key, checks that the release before this one already
//    trusts it (Workers verify a release with the keys of the one they run), signs
//    {name, version, sha256, signedAt}, and uploads worker.js, worker-manifest.json and
//    worker-manifest.sig to the GitHub release.
// Deployed Workers install a signed release three days after they first see it.
import { createPrivateKey } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { checkKeyTrusted, checkVersion, manifestFor, previousTag, publishedWorker, run, sha256, signatureLine, upload } from './release-lib.mjs';

const args = process.argv.slice(2);
const tag = args.find((a) => /^v\d+\.\d+\.\d+$/.test(a));
const keyPath = args[args.indexOf('--key') + 1];
if (!tag || !args.includes('--key') || !keyPath) {
  process.stderr.write('usage: npm run sign-release -- vX.Y.Z --key <path-to-private-key.pem>\n');
  process.exit(1);
}
const version = tag.slice(1);

const work = mkdtempSync(join(tmpdir(), 'cozi-sign-'));
const tree = join(work, 'tree');
const cleanup = () => {
  try {
    run('git', ['worktree', 'remove', '--force', tree]);
  } catch {}
  rmSync(work, { recursive: true, force: true });
};
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

try {
  try {
    run('git', ['verify-tag', tag]);
  } catch {
    throw new Error(
      `${tag} has no signature this machine can verify. Tags are SSH-signed; one-time setup:\n` +
        '  echo "$(git config user.email) $(cat "$(git config user.signingkey)")" > ~/.config/git/allowed_signers\n' +
        '  git config --global gpg.ssh.allowedSignersFile ~/.config/git/allowed_signers',
    );
  }
  const previous = previousTag(tag);
  process.stdout.write(
    `\nChanges ${previous}..${tag}:\n${run('git', ['log', '--oneline', `${previous}..${tag}`])}\n` +
      run('git', ['diff', '--stat', `${previous}..${tag}`]),
  );

  run('git', ['worktree', 'add', '--detach', tree, tag]);
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], tree);
  run('npm', ['run', 'build', '--silent'], tree);
  const local = readFileSync(join(tree, 'dist', 'worker.js'));
  checkVersion(local, version, JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8')).version);

  const published = publishedWorker(version, work);
  if (!local.equals(published)) {
    throw new Error(`dist/worker.js built from ${tag} (${sha256(local)}) differs from npm's (${sha256(published)}); not signing.`);
  }

  const manifest = manifestFor(version, local);
  process.stdout.write(`\n${manifest}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Sign and upload to GitHub release ${tag}? [y/N] `);
  rl.close();
  if (answer.trim().toLowerCase() !== 'y') throw new Error('Not signed.');

  const privateKey = createPrivateKey(readFileSync(keyPath));
  checkKeyTrusted(privateKey, tag, previous);
  upload(tag, join(work, 'out'), local, manifest, signatureLine(manifest, privateKey));
  process.stdout.write(`Uploaded. Deployed Workers install ${version} three days after their next daily check.\n`);
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
} finally {
  cleanup();
}
