# Changelog

All notable changes to this project are documented here.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.2] - 2026-09-20

### Fixed

- **Timed appointments are no longer created a day too long**
  ([#12](https://github.com/mjucius/cozi_mcp/issues/12)). Since 2.2.0 every
  `create_appointment` and re-spanning `update_appointment` with real start/end
  times produced an event that ended one day after the requested end — a 9:00–17:00
  meeting ran until 17:00 the *next* day in the Cozi app. All-day events were
  unaffected. The cause was a misreading of Cozi's `dateSpan` field (see below),
  compounded by a `>= 1` clamp in the payload builders. Both are gone: timed writes
  now send `dateSpan = lastDay − startDay` (`0` for a same-day event, exactly what
  2.1.x sent); all-day writes are unchanged.
- **`create_appointment` and `update_appointment` return what Cozi stored**, parsed
  from the write response the same way `get_calendar` parses a page, instead of
  echoing the request back. A write that Cozi interprets differently from what was
  asked is now visible in the tool result; before, the echo hid #12 entirely.
- **`get_calendar` reads timed spans correctly.** A timed event with `dateSpan: 1`
  (an overnight) was reported as ending on its start day.

### Changed

- **Live conformance suite replaces the smoke scripts.** `npm run test:live` runs
  `tests/live/` against the real Cozi API with the credentials in `creds.env` (or
  `COZI_USERNAME`/`COZI_PASSWORD`): creates, updates and deletes in a fixed past
  sandbox window, verifies each write by a fresh read of the raw wire, checks span
  semantics through the month pages Cozi lists the appointment on, asserts the tool
  result equals a fresh read, and cleans up after itself. The three
  `scripts/smoke*.ts` files are removed. `npm test` is unchanged and still needs
  no credentials.
- Events created by 2.2.0 or 2.2.1 with start/end times are stored a day too long;
  re-setting `end` once with `update_appointment` (or in the Cozi app) corrects each.

### Notes on the wire format (correcting 2.2.0)

`dateSpan` is a **day offset**, not an inclusive count: an appointment's end
instant is `day + dateSpan` days later, at `endTime`, for timed and all-day events
alike. An all-day event is stored as `00:00:00`/`00:00:00`, so its end instant is
the midnight *after* its last covered day — the same exclusive-end convention as
iCal `DTEND`. That is why a one-day holiday carries `1` while a same-day timed
event carries `0` (usually omitted), and why a timed event with `dateSpan: 1` is an
overnight. Established by write-then-observe against the live API: Cozi lists a
spanning appointment on every month page its `[day, day + dateSpan]` range
touches, and a same-day timed event written with `dateSpan: 1` on the last day of
a month is paged onto the following month. The 2.2.0 note below inferred an
inclusive count from a read-only survey and was wrong for timed events.

## [2.2.1] - 2026-09-17

### Added

- **`create_appointment` and `update_appointment` accept a bare date for
  all-day events.** `start`/`end` may now be `'2026-06-15'` instead of
  `'2026-06-15T00:00:00'` when `all_day=true` (or, on update, when the event is
  already all-day and `all_day` is not passed). A bare date on a timed event is
  rejected with a `ValidationError` naming the argument and the fix, rather than
  defaulting to midnight or silently converting the event to all-day.

## [2.2.0] - 2026-09-08

Multi-day appointments now work end to end. Two defects were fixed: the one
reported in #8, and a second, pre-existing one found while verifying it.

### Fixed

- **`create_appointment` no longer drops the end date on multi-day events**
  ([#8](https://github.com/mjucius/cozi_mcp/issues/8)). The handler parsed `end`
  and then used only its *time* component — the end **date** was discarded
  outright, so an event spanning several days was created as a single-day event
  and the call still returned success. Nothing surfaced the loss unless you
  re-opened the event in the Cozi app. `update_appointment` had the identical
  defect. Both now derive Cozi's `dateSpan` from the supplied range.
- **`get_calendar` no longer collapses a multi-day event's end onto its start
  day.** The projection bound the reported `end` to `startDay`, so even an event
  created in the Cozi app was misreported. This is why the tool result echoed the
  wrong end date straight back at the caller.
- **All-day appointments could never be created.** Every `all_day=true` create
  and every switch-to-all-day edit was rejected by Cozi with `Operation rejected
  due to request data problem. Detail: start_time and end_time are required` —
  the payload builders sent `null` times, which Cozi refuses. An all-day event is
  stored as `00:00:00`/`00:00:00`, which the read path already coerces back to
  `null`. Pre-existing, unrelated to #8, and fixed here because vacations — the
  dominant multi-day case — are all-day.
- **An `end` before its `start` is now rejected** with a `ValidationError` raised
  before any network call, instead of being silently mangled. An `endTime`
  earlier than `startTime` *across* days stays legal, because real events do that
  — a trip leaving at 17:00 and returning at 15:00 eight days later.

### Added

- **`end_day` in the calendar tool output.** Present only on multi-day events. It
  is the sole span signal available for an all-day multi-day event, which carries
  no times at all. `get_calendar` now returns
  `[{id, subject, day, all_day, start?, end?, end_day?, attendees?, location?, notes?}]`.
- **`scripts/smoke-multiday.ts`**, a live round-trip covering the issue's exact
  repro, shrinking and growing a span, a single-day control, and a cross-month
  all-day span. Cleans up after itself.

### Notes on the wire format

> **Corrected in 2.2.2.** The inclusive-count reading below is wrong for timed
> events; see the 2.2.2 notes for the actual rule.

`dateSpan` is an **inclusive** day count, not a count of extra days. Established
by probing a live account read-only across 24 months and 782 appointments:
one-day holidays carry `dateSpan: 1`, a Feb 7 → Feb 15 trip carries 9, a
Jul 14 → Aug 4 summer camp carries 22, and 658 ordinary same-day events omit the
field entirely. So `endDay = startDay + max(dateSpan, 1) - 1`. A spanning event
is returned by the calendar GET for *every* month it overlaps, always keyed with
`day` = its start day — so `day` may fall outside the month you asked for.

Two changes are visible on the wire but not in the tool surface: every create and
edit now sends `dateSpan >= 1` rather than `0` (a bare `0` is ambiguous on a
full-replace edit when shrinking a span back to one day), and all-day writes send
`00:00`/`00:00` rather than `null`.

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

[2.2.2]: https://github.com/mjucius/cozi_mcp/compare/v2.2.1...v2.2.2
[2.2.1]: https://github.com/mjucius/cozi_mcp/compare/v2.2.0...v2.2.1
[2.2.0]: https://github.com/mjucius/cozi_mcp/compare/v2.1.1...v2.2.0
[2.1.1]: https://github.com/mjucius/cozi_mcp/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/mjucius/cozi_mcp/compare/v2.0.1...v2.1.0
[2.0.1]: https://github.com/mjucius/cozi_mcp/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/mjucius/cozi_mcp/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/mjucius/cozi_mcp/releases/tag/v1.0.0
