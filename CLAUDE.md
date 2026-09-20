# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Node 20+/TypeScript MCP server that exposes Cozi Family Organizer (lists + calendar) to AI assistants. Distributed three ways: MCPB bundle (drag-and-drop into Claude Desktop), Smithery cloud deployment, and `npx @mjucius/cozi-mcp` for power users.

**v2.0 (2026-05)** is a ground-up Node/TypeScript rewrite of the prior Python v1. The runtime changed AND the tool surface was consolidated (14 → 12 tools, slim projections). See `README.md` for the v1→v2 migration table. Legacy Python source is preserved at git tag `v1.0.0`.

## Development Commands

- `npm install` — install dependencies
- `npm test` — vitest (154 tests, mocks `CoziClient` at the boundary; no creds needed)
- `npm run test:live` — live conformance suite against the real Cozi API (`tests/live/`; reads `creds.env` or `COZI_USERNAME`/`COZI_PASSWORD`, skips without them). ~25 tests, ~40 s, self-cleaning. **Required before every release** — see Testing.
- `npm run typecheck` — `tsc --noEmit`
- `npm run build` — tsup → `dist/server.js` + `dist/bin.js`
- `npm run dev` — local stdio dev (needs `COZI_USERNAME` + `COZI_PASSWORD` env vars)
- `npm run playground` — `@smithery/cli` local playground UI
- `npm run bundle:mcpb` — produces `cozi-mcp.mcpb` at repo root


## Architecture

### Core components

- `src/server.ts` — `createServer({ config })` factory. Smithery default export. Per-credentials `Map<string, CoziClient>` cache so concurrent sessions stay isolated.
- `src/bin.ts` — npx + MCPB stdio entry point (`#!/usr/bin/env node`). Reads `COZI_USERNAME`/`COZI_PASSWORD` env vars, instantiates `createServer`, pipes to `StdioServerTransport`.
- `src/instructions.ts` — `SERVER_INSTRUCTIONS` constant injected into the MCP server.
- `src/cozi/` — Inlined Cozi HTTP client. **No separate npm package.** Cozi API access lives here.
  - `client.ts` — `CoziClient` class with 13 methods (auth + list/item/calendar CRUD).
  - `http.ts` — fetch wrapper with per-client cookie jar, 100ms rate-limit gate, 3-attempt retry/backoff, 401-once-then-reauth.
  - `models.ts` — Zod schemas with `.transform()` for camelCase↔snake_case wire mapping.
  - `appointment-payloads.ts` — `toApiCreate/Edit/DeleteFormat()` builders for the three Cozi appointment payload shapes.
  - `errors.ts` — `CoziError` hierarchy.
- `src/tools/` — 12 MCP tools. Each tool has a `*Handler` function (directly testable) and a `register*Tool(server, getClient)` registrar.
  - `projections.ts` — `slimPerson` / `slimListSummary` / `slimItem` / `slimAppt`. **Wire keys are exact strings** (`type`, `item_count`, `all_day` — not `listType`, `itemCount`, `allDay`).
  - `parsers.ts` — `parseIsoDateTime`, `parseListType`.

### Cozi auth quirks (real bugs if you forget)

- Login URL MUST include `?apikey=coziwc|v251_production` query param. Cozi started enforcing this in early 2026 — without it you get 401 with the misleading "browser does not understand how to supply credentials" message regardless of credential validity.
- All requests need browser-shaped headers: `Origin: https://my.cozi.com`, `Referer: https://my.cozi.com/`, a real Chrome `User-Agent`. Cloudflare in front of `rest.cozi.com` 401s anything that looks like a Node/Python default UA.
- Auth response: `{accessToken, accountId, expiresIn}`. Send `Authorization: Bearer <accessToken>` on subsequent requests. On 401 mid-session, re-authenticate once and replay.
- Calendar GET returns `{items: {<itemId>: {...}}}` (a map, not an array). Iterate `Object.entries`.
- Appointment `notes` and `location` live in `itemDetails.notes` / `itemDetails.location` on the GET response — not at the top level. `parseCalendarItem` hoists them.
- `createAppointment` doesn't return an ID. Client matches by `day + description` in the response to find the new appointment.
- Multi-day events are expressed by top-level `dateSpan`, a **day offset**: the end instant is `day + dateSpan` days later at `endTime`, for timed and all-day events alike. A same-day timed event is `0` (usually the field is simply absent); a timed overnight is `1`. An all-day event is stored `00:00:00`/`00:00:00`, so its end instant is the midnight *after* its last covered day (iCal exclusive `DTEND`) — hence a one-day all-day event is `1` and Jul 30 → Aug 2 all-day is `4`. The ±1 between "last covered day" and "end instant" lives only in `lastDayOf` / `dateSpanForLastDay` in `models.ts`. **Never clamp or "normalise" `dateSpan` on the write path** — a `>= 1` clamp is exactly what made every timed appointment a day too long in 2.2.0/2.2.1 (#12). A spanning event is returned by the GET for *every* month it overlaps, always keyed with `day` = its start day; that month-page listing is the **only server-side view of how Cozi reads a span**, and `tests/live/calendar.test.ts` uses it as the oracle. Do not confuse `dateSpan` with `endDay`, which is the recurring-series end nested in `recurrence`.
- All-day appointments must be written as `startTime`/`endTime` of `"00:00"`, never `null` — Cozi rejects a null with *"start_time and end_time are required"*. The read path coerces the stored `00:00:00` pair back to `null`.

## Credentials and security model

Each user runs their own instance against their own Cozi account. No multi-tenancy.

Three credential entry points, same downstream `getClient(username, password)` cache:

- **MCPB**: Claude Desktop prompts for `user_config.username` / `user_config.password` declared in `manifest.json`. Stored in the OS keychain. Wired to `COZI_USERNAME` / `COZI_PASSWORD` env vars at extension launch.
- **Smithery**: `smithery.yaml` declares the `configSchema`. Smithery injects per-session config into `createServer({ config })`.
- **npx**: `bin.ts` reads `COZI_USERNAME` / `COZI_PASSWORD` directly from `process.env`.

**Never `console.log`** anywhere in the codebase. Stdio uses stdout for JSON-RPC frames; any stray write corrupts the protocol. Diagnostics → `process.stderr.write(...)` only.

## Testing

`npm test` runs vitest. Test layout:

- `tests/projections.test.ts` — pure dict-shape tests for the slim helpers (15 tests).
- `tests/parsers.test.ts` — `parseIsoDateTime` (datetime, bare date, offset, rejects) and `parseListType`.
- `tests/tools-lists.test.ts` — list/item tool handlers with mocked `CoziClient` (17 tests).
- `tests/tools-calendar.test.ts` — calendar tools, including 9 fetch-then-merge regression tests for `update_appointment` (14 tests).
- `tests/client-cache.test.ts` — per-credentials `Map` cache (5 tests).
- `tests/create-server.test.ts` — 12-tool registration smoke (1 test).
- `tests/errors.test.ts` — error propagation (16 tests).
- `tests/helpers/factories.ts` — `makePerson` / `makeItem` / `makeList` / `makeAppointment` (mirrors prior `conftest.py` factories).
- `tests/helpers/mock-client.ts` — `makeMockClient()` returns a stand-in with `vi.fn()` for each method.

154 tests total, ~1s wall time. (The per-file counts above predate several additions — `npm test` is the source of truth.) No network access required.

### Live conformance suite (`tests/live/`, `npm run test:live`)

The unit suite can only check what we *send*: it mocks `CoziClient` and asserts against our own model of Cozi. Issue #12 shipped with 20 green unit tests and a 15/15 smoke script because both encoded the same wrong belief about `dateSpan`. The live suite is the guard against that class of bug:

- `tests/live/harness.ts` — credential loading, a fixed **past** sandbox window (`2019-01..03`), raw wire GET/POST, `monthsListing(id)` (the span oracle), sweep + teardown of every `LIVE_TEST_DELETE_ME` subject. It reads whole month pages (Cozi has no other calendar GET) but only ever asserts on and deletes its own subjects, and writes nothing to disk.
- `tests/live/calendar.test.ts` — create / update / delete across timed same-day, overnight, multi-day, trip-shaped, all-day single, all-day cross-month, attendees/location/notes, timed↔all-day switches, a bounded recurring series, and validation. Every write is checked three ways: exact raw read-back, the set of month pages Cozi lists it on, and tool result `toEqual` a fresh `get_calendar` projection.
- `tests/live/lists.test.ts` — list/item create, rename, mark, remove, delete, the 201-upsert guard, each verified by a fresh `GET /list/`.

Rules for this suite: assertions are exact (no `<=`), every claim about wire semantics must come from a write-then-observe case here (never from a read-only survey), and any change to how an appointment field is *written* also gets one manual look at the canonical shapes in the Cozi app before release.

## Deployment

Release gate, in order: `npm run typecheck`, `npm test`, `npm run test:live` (all green, sandbox months empty afterwards), then bump `package.json`, `manifest.json`, `package-lock.json` (root + `packages[""]`) and `SERVER_VERSION` in `src/server.ts`, date the changelog entry, and add its compare link.

### MCPB (.mcpb bundle)

```bash
npm run bundle:mcpb            # writes cozi-mcp.mcpb at repo root
# Drag onto Claude Desktop. Enter credentials in the keychain prompt.
```

Manifest at `manifest.json` (v0.4 schema). Validate with:

```bash
npx -y @anthropic-ai/mcpb validate manifest.json
```

### Smithery

`smithery.yaml` declares `runtime: typescript`, `target: dist/server.js`. Pushing to `main` on `mjucius/cozi_mcp` triggers Smithery rebuild.

### npm (npx)

```bash
npm publish --access public --dry-run   # confirm tarball is dist/ + README + LICENSE only
npm publish --access public
```

Published as `@mjucius/cozi-mcp`. Verify with `npx -y @mjucius/cozi-mcp` (will fail with helpful error if env vars not set).
