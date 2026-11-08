/**
 * Public Ed25519 keys whose signatures a deployed Worker accepts for self-updates, by key
 * id: the raw 32-byte key, base64. The private halves never touch this repository or CI;
 * the maintainer signs each release offline with `npm run sign-release`. A key added here
 * is only trusted by Workers already running a release that contains it, so rotate by
 * shipping the new key one release before signing with it.
 */
export const UPDATE_KEYS: Record<string, string> = {
  c007fd07: 'mHc5gqCng+zprBNxkxgyI+3lNCuYLqSyk4KQA5sHybY=',
};
