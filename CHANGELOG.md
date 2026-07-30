# Changelog

All notable changes to this project are documented here.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.1] - 2026-07-30

Diagnostics only — no change to the tool surface, the wire format, or the
security model. Every fix here targets a failure that was silent or misleading
rather than incorrect.

### Fixed

- **Authentication failures now name the actual cause.** `COZI_USERNAME` and
  `COZI_PASSWORD` are read once when the process starts, so correcting them in
  an MCP client's settings has no effect until that client respawns the server.
  Until now this surfaced as a bare `Authentication failed`, which points at the
  password rather than at the stale process — users re-typed a correct password
  repeatedly and got the same error. The message now explains the startup
  capture and the need for a full client restart. Status code and response data
  pass through unchanged, so no additional detail is exposed (VULN-006).
- **The lockout message states how long to wait.** `Too many failed login
  attempts; try again later` became `...try again in 8s`, computed from the
  remaining backoff, so the wait is knowable instead of guessed at.
- **The startup warning names which variable is missing.** It previously always
  named both `COZI_USERNAME` and `COZI_PASSWORD` regardless of which was unset,
  and did not say where to set them. It now reports only what is actually
  missing and points at the client's configuration. The deliberate fail-open
  behavior is unchanged — the server still starts without credentials so
  Smithery's registry scanner can enumerate tools.

### Added

- **Version-drift guard.** The version is declared in three places that ship
  independently: `package.json` (npx), `manifest.json` (MCPB), and the version
  advertised in the MCP handshake, which was previously a hardcoded literal in
  `server.ts`. When these drift, a running server misreports which build it is,
  making "did my update take effect?" unanswerable from the outside — exactly
  the confusion that prompted this release. `server.ts` now exports
  `SERVER_VERSION` and feeds it to the `McpServer` constructor, and
  `tests/version-consistency.test.ts` asserts all three agree.
- Test coverage for the above: `tests/auth-diagnostics.test.ts` (6 tests) and
  `tests/version-consistency.test.ts` (2 tests).

### Known limitation

There is no in-process fix for stale credentials. Claude Desktop injects them
into the environment at spawn, and a running process's environment cannot be
changed from outside, so re-reading `process.env` per call would return the same
stale values. A restart is genuinely required; this release makes that legible
rather than avoidable.

## [2.1.0] - 2026-07-30

### Added

- Read-only tool mode via `COZI_READ_ONLY`, hiding all create/update/delete
  tools from the MCP client.
- Write verification for calendar operations. Cozi answers `200` even when it
  discards an operation, reporting the reason in a `rejectedItems` array; a
  failed write previously looked identical to a successful one.
- Smithery publish job in the release workflow.

### Security

- Prompt-injection fencing: every tool result is wrapped in
  `<cozi_data boundary="…">` markers with a random per-response token, so
  household-writable content (item text, appointment notes, family member names)
  cannot forge a closing marker to break out of the data fence.
- Path traversal, login-response leak, credential-cache and recurrence-
  preservation fixes from the VulnHunter audit.
- Time-bounded credential cache and failed-login rate limiting.

## [2.0.1] - 2026-05-11

### Fixed

- npm publishing moved to Trusted Publishing (OIDC); publish step made
  idempotent so a re-run skips a version already on the registry.

## [2.0.0] - 2026-05-10

Node/TypeScript rewrite of the previous Python implementation, distributed as
MCPB, npx, and Smithery. **Breaking:** the tool surface was consolidated from 14
tools to 12 — see the migration table in the README.

## [1.0.0] - 2026-05-10

Initial Python release.

[2.1.1]: https://github.com/mjucius/cozi_mcp/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/mjucius/cozi_mcp/compare/v2.0.1...v2.1.0
[2.0.1]: https://github.com/mjucius/cozi_mcp/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/mjucius/cozi_mcp/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/mjucius/cozi_mcp/releases/tag/v1.0.0
