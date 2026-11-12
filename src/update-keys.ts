/**
 * Public Ed25519 keys whose signatures a deployed Worker accepts for self-updates, by key
 * id: the raw 32-byte key, base64. c007fd07 is the maintainer's offline key (`npm run
 * sign-release`), kept as the backup. edfa4948 is the worker-signing environment's key,
 * which release.yml's sign-worker job signs with after the maintainer approves. The private
 * halves never touch this repository. A key added here is only trusted by Workers already
 * running a release that contains it, so rotate by shipping the new key one release before
 * signing with it.
 */
export const UPDATE_KEYS: Record<string, string> = {
  c007fd07: 'mHc5gqCng+zprBNxkxgyI+3lNCuYLqSyk4KQA5sHybY=',
  edfa4948: '4NUPMzC7uigLu5OUIP1zwEEpzH+Hr4GBzaa78I7YlCs=',
};
