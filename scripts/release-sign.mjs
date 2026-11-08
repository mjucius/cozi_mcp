#!/usr/bin/env node
// After CI has published a release:
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
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

const args = process.argv.slice(2);
const tag = args.find((a) => /^v\d+\.\d+\.\d+$/.test(a));
const keyPath = args[args.indexOf('--key') + 1];
if (!tag || !args.includes('--key') || !keyPath) {
  process.stderr.write('usage: npm run sign-release -- vX.Y.Z --key <path-to-private-key.pem>\n');
  process.exit(1);
}
const version = tag.slice(1);
const NAME = '@mjucius/cozi-mcp';
const run = (cmd, argv, cwd) => execFileSync(cmd, argv, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const keysAt = (ref) => {
  try {
    return run('git', ['show', `${ref}:src/update-keys.ts`]);
  } catch {
    return null;
  }
};

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
  const previous = run('git', ['describe', '--tags', '--abbrev=0', `${tag}^`]).trim();
  process.stdout.write(
    `\nChanges ${previous}..${tag}:\n${run('git', ['log', '--oneline', `${previous}..${tag}`])}\n` +
      run('git', ['diff', '--stat', `${previous}..${tag}`]),
  );

  run('git', ['worktree', 'add', '--detach', tree, tag]);
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], tree);
  run('npm', ['run', 'build', '--silent'], tree);
  const local = readFileSync(join(tree, 'dist', 'worker.js'));
  const pkgVersion = JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8')).version;
  const builtVersion = /SERVER_VERSION = "(\d+\.\d+\.\d+)"/.exec(local.toString())?.[1];
  if (pkgVersion !== version || builtVersion !== version) {
    throw new Error(`${tag} has package.json ${pkgVersion} and SERVER_VERSION ${builtVersion}; not signing.`);
  }

  run('npm', ['pack', `${NAME}@${version}`, '--pack-destination', work, '--silent'], work);
  run('tar', ['-xzf', `mjucius-cozi-mcp-${version}.tgz`, 'package/dist/worker.js'], work);
  const published = readFileSync(join(work, 'package', 'dist', 'worker.js'));
  if (!local.equals(published)) {
    throw new Error(`dist/worker.js built from ${tag} (${sha256(local)}) differs from npm's (${sha256(published)}); not signing.`);
  }

  const manifest = Buffer.from(
    JSON.stringify({ name: NAME, version, sha256: sha256(local), signedAt: new Date().toISOString() }),
  );
  process.stdout.write(`\n${manifest}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Sign and upload to GitHub release ${tag}? [y/N] `);
  rl.close();
  if (answer.trim().toLowerCase() !== 'y') throw new Error('Not signed.');

  const privateKey = createPrivateKey(readFileSync(keyPath));
  const raw = Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x, 'base64url').toString('base64');
  const keyId = createHash('sha256').update(Buffer.from(raw, 'base64')).digest('hex').slice(0, 8);
  for (const ref of [tag, previous]) {
    const keys = keysAt(ref);
    // The first release with self-update has no earlier key file; nothing runs an older updater.
    if (keys !== null && !keys.includes(`'${raw}'`)) throw new Error(`Key ${keyId} is not in ${ref}'s src/update-keys.ts; not signing.`);
  }
  if (keysAt(tag) === null) throw new Error(`${tag} has no src/update-keys.ts; not signing.`);

  const out = join(work, 'out');
  mkdirSync(out);
  writeFileSync(join(out, 'worker.js'), local);
  writeFileSync(join(out, 'worker-manifest.json'), manifest);
  writeFileSync(join(out, 'worker-manifest.sig'), `${keyId}:${sign(null, manifest, privateKey).toString('base64')}\n`);
  run('gh', ['release', 'upload', tag, ...['worker.js', 'worker-manifest.json', 'worker-manifest.sig'].map((f) => join(out, f)), '--clobber']);
  process.stdout.write(`Uploaded. Deployed Workers install ${version} three days after their next daily check.\n`);
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
} finally {
  cleanup();
}
