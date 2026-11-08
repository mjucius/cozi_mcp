// Stand-in for the workerd-only `cloudflare:workers` module, so Node tests can import the
// OAuth provider: the class only has to exist, and the global mirrors the deployed
// compatibility flags (the provider refuses CIMD without global_fetch_strictly_public).
export class WorkerEntrypoint {}
(globalThis as { Cloudflare?: unknown }).Cloudflare = { compatibilityFlags: { global_fetch_strictly_public: true } };
