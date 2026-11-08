# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Node 20+/TypeScript MCP server that exposes Cozi Family Organizer (lists + calendar) to AI assistants. Distributed three ways: MCPB bundle (drag-and-drop into Claude Desktop), `npx @mjucius/cozi-mcp` for any other MCP client, and a deploy-your-own Cloudflare Worker (`deploy/cloudflare/`, behind a Deploy to Cloudflare button) that serves Claude's custom connectors over HTTPS (#22). Smithery distribution was dropped in 2.2.3 (zero installs, and its stale listings leaked into the official MCP Registry — #14); don't re-add a registry without a reason to expect users there.

**v2.0 (2026-05)** is a ground-up Node/TypeScript rewrite of the prior Python v1. The runtime changed AND the tool surface was consolidated (14 → 12 tools, slim projections). See `README.md` for the v1→v2 migration table. Legacy Python source is preserved at git tag `v1.0.0`.

## Development Commands

- `npm install` — install dependencies
- `npm test` — vitest (260 tests, mocks `CoziClient` at the boundary; no creds needed)
- `npm run test:live` — live conformance suite against the real Cozi API (`tests/live/`; reads `creds.env` or `COZI_USERNAME`/`COZI_PASSWORD`, skips without them). ~43 tests, ~2.5 min, self-cleaning. **Required before every release** — see Testing.
- `npm run typecheck` — `tsc --noEmit`
- `npm run build` — tsup → `dist/server.js` + `dist/bin.js`
- `npm run dev` — local stdio dev (needs `COZI_USERNAME` + `COZI_PASSWORD` env vars)
- `npm run bundle:mcpb` — produces `cozi-mcp.mcpb` at repo root


## Architecture

### Core components

- `src/server.ts` — `createServer({ config, getClient? })` factory, called by `bin.ts` and the Worker. Per-credentials `Map<string, CoziClient>` cache so concurrent sessions stay isolated; the Worker injects its own per-request `getClient` instead (module-level promises shared across Worker requests can hang).
- `src/bin.ts` — npx + MCPB stdio entry point (`#!/usr/bin/env node`). Reads `COZI_USERNAME`/`COZI_PASSWORD` env vars, instantiates `createServer`, pipes to `StdioServerTransport`.
- `src/instructions.ts` — `SERVER_INSTRUCTIONS` constant injected into the MCP server.
- `src/worker.ts` — Cloudflare Worker entry (`@mjucius/cozi-mcp/worker`, `dist/worker.js`, uploaded as-is by self-update so it must stay one self-contained module importing only `cloudflare:workers`). One `@cloudflare/workers-oauth-provider` per origin guards `/mcp`; `/token` requests from any client but Claude are refused before the provider sees them; the cron runs the self-update.
- `src/remote.ts` — the Worker's gates, sign-in and landing pages, refresh and stateless MCP handling, free of `cloudflare:workers` so the Node suite can drive it.
- `src/update.ts` / `src/update-keys.ts` — daily signed self-update (Ed25519 over `{name, version, sha256, signedAt}`, 3-day hold from the Worker's own first sighting of that exact release, rollback sticks, `PUT …/workers/scripts/{name}/content` with the owner's `CF_API_TOKEN`, only into the account whose `workers.dev` subdomain matches the Worker's own address). `UPDATE_KEYS` holds public keys only.
- `deploy/cloudflare/` — the template the Deploy button clones (it becomes the user's repo root): pins `@mjucius/cozi-mcp` and wrangler, one KV (`OAUTH_KV`), the `SIGNIN_LIMIT` rate limiter, the daily cron, secrets `ALLOWED_EMAIL` + `CF_API_TOKEN` via `.dev.vars.example`. The Worker is named `calendar-connector`, never anything with "cozi": Cloudflare's Developer Platform terms prohibit other businesses' names in `workers.dev` subdomains. Keep each `cloudflare.bindings` description in its `package.json` short: the deploy form silently drops a long one (406 characters vanished, 342 shows; the limit looks like 400).
- `src/cozi/` — Inlined Cozi HTTP client. **No separate npm package.** Cozi API access lives here.
  - `client.ts` — `CoziClient` class (auth with cookie refresh + list/item/calendar CRUD, calendar search). Every request carries the apikey.
  - `http.ts` — fetch wrapper with per-client cookie jar, 100ms rate-limit gate, 3-attempt retry/backoff, 401-once-then-reauth.
  - `models.ts` — Zod schemas with `.transform()` for camelCase↔snake_case wire mapping.
  - `appointment-payloads.ts` — `toApiCreate/Edit/DeleteFormat()` builders for the three Cozi appointment payload shapes.
  - `errors.ts` — `CoziError` hierarchy.
- `src/tools/` — 15 MCP tools. Each tool has a `*Handler` function (directly testable) and a `register*Tool(server, getClient)` registrar.
  - `projections.ts` — `slimPerson` / `slimListSummary` / `slimItem` / `slimAppt`. **Wire keys are exact strings** (`type`, `item_count`, `all_day` — not `listType`, `itemCount`, `allDay`).
  - `parsers.ts` — `parseIsoDateTime`, `parseListType`.
  - `untrusted.ts` — `toolResult` returns two text blocks: `content[0]` is the boundary-fenced Cozi data, `content[1]` a local-time stamp from `localNow()` (host clock; `TZ` overrides) so assistants with a UTC clock resolve "tomorrow" correctly.

### Cozi auth quirks (real bugs if you forget)

- Login URL MUST include `?apikey=coziwc|v251_production` query param. Cozi started enforcing this in early 2026 — without it you get 401 with the misleading "browser does not understand how to supply credentials" message regardless of credential validity. Since the 2026-10 audit every request carries it (`HttpClient` `defaultParams`), as Cozi's own web client does.
- Login with `issueRefresh: true` sets a `cozi_refresh` cookie; an empty `POST /2111/{acct}/auth/reauth` with that cookie returns a fresh token (same shape as login). `CoziClient.refresh()` uses it before expiry and on a 401, falling back to the password; logins and refreshes are single-flight per client. Through `createServer` the before-expiry path never runs: `getClient` drops a cached client at 90% of its token life and logs in again with the password (VULN-004, so a changed password is noticed), and the cookie only serves a 401 mid-session.
- All requests need browser-shaped headers: `Origin: https://my.cozi.com`, `Referer: https://my.cozi.com/`, a real Chrome `User-Agent`. Cloudflare in front of `rest.cozi.com` 401s anything that looks like a Node/Python default UA.
- Auth response: `{accessToken, accountId, expiresIn}`. Send `Authorization: Bearer <accessToken>` on subsequent requests. On 401 mid-session, re-authenticate once and replay.
- Calendar GET returns `{items: {<itemId>: {...}}}` (a map, not an array). Iterate `Object.entries`.
- Appointment `notes` and `location` live in `itemDetails.notes` / `itemDetails.location` on the GET response — not at the top level. `parseCalendarItem` hoists them.
- `createAppointment` doesn't return an ID. Client matches by `day + description` in the response to find the new appointment.
- Multi-day events are expressed by top-level `dateSpan`, a **day offset**: the end instant is `day + dateSpan` days later at `endTime`, for timed and all-day events alike. A same-day timed event is `0` (usually the field is simply absent); a timed overnight is `1`. An all-day event is stored `00:00:00`/`00:00:00`, so its end instant is the midnight *after* its last covered day (iCal exclusive `DTEND`) — hence a one-day all-day event is `1` and Jul 30 → Aug 2 all-day is `4`. The ±1 between "last covered day" and "end instant" lives only in `lastDayOf` / `dateSpanForLastDay` in `models.ts`. **Never clamp or "normalise" `dateSpan` on the write path** — a `>= 1` clamp is exactly what made every timed appointment a day too long in 2.2.0/2.2.1 (#12). A spanning event is returned by the GET for *every* month it overlaps, always keyed with `day` = its start day; that month-page listing is the **only server-side view of how Cozi reads a span**, and `tests/live/calendar.test.ts` uses it as the oracle. Do not confuse `dateSpan` with `endDay`, which is the recurring-series end nested in `recurrence`.
- A month page also carries `days: {"YYYY-MM-DD": [{id}]}`, Cozi's own expansion of every item onto the days it falls on: recurring series expanded, deleted occurrences left out, multi-day items listed on every covered day with the occurrence they belong to as `multiday: {startDay, endDay}` (`endDay` is the end instant's day, one past an all-day item's last day), exactly the requested month. `get_calendar` lists one entry per occurrence start day from it, which may lie in the previous month; never expand rules ourselves. An item with no day in the month is not on the page at all: a series whose only occurrence that month was deleted, or edited into a stand-in, vanishes from it (all live-verified 2026-10-14).
- Occurrence-level writes put `selectedDay` + `extent` beside the operation (the web client's shape). `extent: 'day'` excludes one occurrence (`exdates` entry); on an edit Cozi stores the changed copy as a new appointment and links it as `standinApptId` in that exdate. `extent: 'forward'` ends the series the day before; on an edit a new series starts there. Neither ever returns the new id, so `CoziClient.storedOccurrenceEdit` re-reads to find it. `selectedDay` is the occurrence's start day as the day map names it, and may lie in the previous month: a delete is POSTed to the page the caller named, an edit to the page of the start day sent, and Cozi takes either (both live-verified). A day inside a multi-day occurrence is mapped to the occurrence on a delete, but an edit stores the stand-in on the `startDay` sent, and one past the series' end made the whole series vanish from every page (live-observed 2026-10-14), so the tools only ever send a start day get_calendar listed.
- Calendar search (`/search/calendar/?q=`) wraps hits as `{highlight, item}` and keys them `<uuid>-a`; strip the suffix before using the id. It does not reach back to 2019, and trails writes by a few seconds.
- A list `PUT /list/{id}` with only `{title}` renames it and keeps its items; an unknown id is a 400 (unlike item PUT, which upserts).
- All-day appointments must be written as `startTime`/`endTime` of `"00:00"`, never `null` — Cozi rejects a null with *"start_time and end_time are required"*. The read path coerces the stored `00:00:00` pair back to `null`.

## Credentials and security model

Each user runs their own instance against their own Cozi account. No multi-tenancy.

Three credential entry points. The two stdio ones share the downstream `getClient(username, password)` cache:

- **MCPB**: Claude Desktop prompts for `user_config.username` / `user_config.password` declared in `manifest.json`. Stored in the OS keychain. Wired to `COZI_USERNAME` / `COZI_PASSWORD` env vars at extension launch.
- **npx**: `bin.ts` reads `COZI_USERNAME` / `COZI_PASSWORD` directly from `process.env`.
- **Remote Worker**: the person signs in on the Worker's own `/authorize` page; the email must equal the `ALLOWED_EMAIL` secret before anything reaches Cozi, then a Cozi login must succeed. The password and the Cozi session live only in the grant's props, which the OAuth library encrypts under a key only that grant's tokens unwrap. Each token refresh logs in to Cozi again, so a changed password cuts every connector off within the hour (VULN-004 on this path); any refresh failure is `temporarily_unavailable`, never `invalid_grant`, because Cozi's wrong-password 401 is byte-identical to its outage 401s (live-verified 2026-10-27). Only Claude's published client (`https://claude.ai/oauth/mcp-oauth-client-metadata`, CIMD) is accepted, and nothing is written to KV before a successful Cozi login, so anonymous traffic cannot spend the free plan's 1,000 writes/day. The caller-auth gate lives at the Worker edge; `getClient` itself still has none (see the trust model in memory).

**Never `console.log`** anywhere in the codebase. Stdio uses stdout for JSON-RPC frames; any stray write corrupts the protocol. Diagnostics → `process.stderr.write(...)` only.

## Testing

`npm test` runs vitest. Test layout:

- `tests/projections.test.ts` — pure dict-shape tests for the slim helpers.
- `tests/parsers.test.ts` — `parseIsoDateTime` (datetime, bare date, offset, rejects) and `parseListType`.
- `tests/tools-lists.test.ts` — list/item tool handlers with mocked `CoziClient`.
- `tests/tools-calendar.test.ts` — calendar tools, including the fetch-then-merge regression tests for `update_appointment`.
- `tests/client-cache.test.ts` — per-credentials `Map` cache.
- `tests/client-occurrence-edit.test.ts` — where the changed copy of an occurrence edit is found, and the occurrence starts read from a page's day map, against a stubbed Cozi.
- `tests/create-server.test.ts` — tool registration in read-write and read-only mode.
- `tests/errors.test.ts` — error propagation.
- `tests/write-verification.test.ts` — calendar writes Cozi silently discards (`rejectedItems`) surface as errors; item updates refuse the phantom-create upsert.
- `tests/auth-refresh.test.ts` — the apikey on every request, the `cozi_refresh` cookie renewal, and seeding a client from a saved session.
- `tests/auth-diagnostics.test.ts` — what a bare auth failure tells the user (credentials are read once at process start).
- `tests/security-*.test.ts` — one file per audit finding: id validation before any I/O (VULN-001/002), the untrusted-data envelope and local-time stamp (VULN-003), cache TTL and per-username lockout (VULN-004/007), recurrence kept on update (VULN-005), no login response in errors (VULN-006).
- `tests/version-consistency.test.ts` — `package.json`, `manifest.json` and `SERVER_VERSION` agree, and a release has a signing key.
- `tests/remote.test.ts` / `tests/update.test.ts` — the Worker's gates, sign-in, refresh, stateless MCP handling, landing page; the self-update's signature, hold, rollback, expiry and account-matching rules.
- `tests/worker.test.ts` — the real Worker entry with the real OAuth provider under Node (`cloudflare:workers` aliased to `tests/helpers/cloudflare-workers.ts`, in-memory KV, stubbed network): 401 without a token, the client gate, and sign-in → token → tool call → refresh through a Cozi outage.
- `tests/helpers/factories.ts` — `makePerson` / `makeItem` / `makeList` / `makeAppointment` (mirrors prior `conftest.py` factories).
- `tests/helpers/mock-client.ts` — `makeMockClient()` returns a stand-in with `vi.fn()` for each method.

260 tests total, ~3s wall time, no network access required. `npm test` is the source of truth for counts.

### Live conformance suite (`tests/live/`, `npm run test:live`)

The unit suite can only check what we *send*: it mocks `CoziClient` and asserts against our own model of Cozi. Issue #12 shipped with 20 green unit tests and a 15/15 smoke script because both encoded the same wrong belief about `dateSpan`. The live suite is the guard against that class of bug:

- `tests/live/harness.ts` — credential loading, a fixed **past** sandbox window (`2019-01..03`, plus `2022-01` for search, which does not reach back to 2019), raw wire GET/POST and the raw day map, `monthsListing(id)` (the span oracle), sweep + teardown of every `LIVE_TEST_DELETE_ME` subject. It reads whole month pages (Cozi has no other calendar GET) but only ever asserts on and deletes its own subjects, and writes nothing to disk.
- `tests/live/calendar.test.ts` — create / update / delete across timed same-day, overnight, multi-day, trip-shaped, all-day single, all-day cross-month, attendees/location/notes, timed↔all-day switches, a bounded recurring series, and validation. Every write is checked three ways: exact raw read-back, the set of month pages Cozi lists it on, and tool result `toEqual` a fresh `get_calendar` projection.
- `tests/live/auth.test.ts` — the cookie token refresh works without the password (the password fallback would otherwise hide a broken refresh).
- `tests/live/lists.test.ts` — list/item create, rename, mark, remove, delete, the 201-upsert guard, each verified by a fresh `GET /list/`.

Rules for this suite: assertions are exact (no `<=`), every claim about wire semantics must come from a write-then-observe case here (never from a read-only survey), and any change to how an appointment field is *written* also gets one manual look at the canonical shapes in the Cozi app before release.

## Deployment

Release gate, in order: `npm run typecheck`, `npm test`, `npm run test:live` (all green, sandbox months empty afterwards), then bump `package.json`, `manifest.json`, `package-lock.json` (root + `packages[""]`) and `SERVER_VERSION` in `src/server.ts`, date the changelog entry, and add its compare link. After CI has published the tag, sign it for the remote Workers (below); Dependabot (`.github/dependabot.yml`) then opens the PR that moves `deploy/cloudflare`'s pin to the new version; merge it once CI passes. The template has no lockfile yet: once 2.6.0 is on npm, run `npm install --package-lock-only` in `deploy/cloudflare` and commit it, and Dependabot keeps it current from then on.

### Remote Worker (Cloudflare template + signed self-update)

- **User guide:** the install steps are the walkthrough page `docs/setup/index.html` (served by GitHub Pages from `main` `/docs`, with `docs/.nojekyll`, at `https://mjucius.github.io/cozi_mcp/setup/`; one self-contained file, no outside resources, and the only copy of the AI-assistant install prompt). Screenshots live in `docs/images/cloudflare/`. `docs/cloudflare-setup.md` holds only the after-setup reference (updates, settings, troubleshooting, removal) and is what the server page links to. Dashboard labels change (the token button became **Review token**), so re-walk the real screens before a release that touches this flow. Screenshots must never show real account names, subdomains, emails or chat titles.

- **Signing, after every release:** `npm run sign-release -- vX.Y.Z --key <(password-manager read …)`. It verifies the tag's SSH signature (one-time: `gpg.ssh.allowedSignersFile`, the script prints the command), shows the changes since the previous tag, builds `dist/worker.js` from a clean checkout with install scripts off, refuses unless it is byte-identical to npm's and reports the tag's version, and after confirmation signs and uploads `worker.js` + `worker-manifest.json` + `.sig` to the GitHub release. Until then deployed Workers report "latest release not signed yet". Deleting the `.sig` within the 3-day hold stops a release everywhere.
- **The private key never enters the repo, CI, or a file a dependency's install script could read.** `scripts/release-keygen.mjs <path>` makes one; its public half goes in `src/update-keys.ts`, and `tests/version-consistency.test.ts` refuses a release without one. A new key must ship one release before anything is signed with it (Workers verify with the keys of the version they run; `sign-release` refuses otherwise).
- **Update contract.** The updater that runs is the *previous* release's, and a user's copy of `deploy/cloudflare` never changes after the button clones it (only `@mjucius/cozi-mcp` moves, and only on a redeploy). So `dist/worker.js` must keep working on the template's original bindings, compatibility date/flags and wrangler; a new required binding, secret or flag ships in two steps, or not at all. Tool changes stay additive (Claude caches tool lists for hours).
- **Free-plan budgets** the code is written against: 10 ms CPU per request and per cron run (a self-update measured 7 ms on 780 KB), 1,000 KV writes/day (≈2 per token refresh, 0 per MCP call, ~1/day for the updater).

### MCPB (.mcpb bundle)

```bash
npm run bundle:mcpb            # writes cozi-mcp.mcpb at repo root
# Drag onto Claude Desktop. Enter credentials in the keychain prompt.
```

Manifest at `manifest.json` (v0.4 schema). Validate with:

```bash
npx -y @anthropic-ai/mcpb validate manifest.json
```

### npm (npx)

```bash
npm publish --access public --dry-run   # confirm tarball is dist/ + README + LICENSE only
npm publish --access public
```

Published as `@mjucius/cozi-mcp`. Verify with `npx -y @mjucius/cozi-mcp` (will fail with helpful error if env vars not set).
