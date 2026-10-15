<p align="center">
  <img src="assets/cozi_mcp_logo.svg" width="128" alt="Cozi MCP logo" />
</p>

# Cozi MCP Server

An unofficial [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI assistants like Claude read and update your [Cozi Family Organizer](https://www.cozi.com/) lists and calendar.

Each user runs their own instance against their own Cozi account. Your credentials are stored in your MCP client's secure config (Claude Desktop's OS keychain or your local environment) and never leave your machine — the author of this server has no access to your data.

## Install

### 1. MCPB (recommended for Claude Desktop)

Download the latest `.mcpb` from the [Releases page](https://github.com/mjucius/cozi_mcp/releases) and double-click to install in Claude Desktop. You'll be prompted for your Cozi username and password — they're stored securely in your OS keychain.

This path requires no Node, npm, or Python install on your machine.

### 2. npx (any other MCP client)

Add this to your Claude Desktop `claude_desktop_config.json` (or any other MCP client config file):

```json
{
  "mcpServers": {
    "cozi": {
      "command": "npx",
      "args": ["-y", "@mjucius/cozi-mcp"],
      "env": {
        "COZI_USERNAME": "you@example.com",
        "COZI_PASSWORD": "your-password",
        "COZI_READ_ONLY": "true"
      }
    }
  }
}
```

Requires Node 20+. The package will be downloaded on first run.

Set `COZI_READ_ONLY=true` to expose only read operations. In read-only mode, the server registers
`family_members`, `get_lists`, `get_list_items`, `get_calendar`, `search_calendar`, and `today`; tools that create, update, or
delete Cozi data are hidden from MCP clients. Omit the variable, or set it to any value other than
`1`, `true`, `yes`, or `on`, for the default read-write tool surface.

## Troubleshooting

### Tools fail with "Authentication failed" even after I corrected my password

`COZI_USERNAME` and `COZI_PASSWORD` are read once, when the server process
starts. Editing them in your MCP client's settings updates the stored config but
does not reach a server that is already running — it keeps presenting the old
credentials until it is respawned.

Fully quit and relaunch your MCP client (on macOS, Cmd-Q rather than closing the
window). Reloading, reconnecting, or toggling the extension off and on is
usually not enough.

### How do I tell which version is actually running?

The running server advertises its version in the MCP handshake; your client
displays it (Claude Desktop: Settings > Extensions). That is independent of what
is in your working tree — installing an MCPB installs whatever is inside the
`.mcpb` file, which is only as current as the last `npm run bundle:mcpb`. Build
the bundle immediately before installing it, or install from a GitHub release.

### Repeated failures start returning "Too many failed login attempts"

Five consecutive failed authentications for a username trigger an exponential
backoff, capped at 15 minutes; the message states the remaining wait. The
counter lives in process memory, so restarting the client clears it.

## Trust and Security

Cozi has no OAuth — username/password authentication is the only way the API supports. This server handles that fact honestly:

- **Per-user, by architecture.** Each user runs their own instance against their own Cozi account. There is no shared backend, no proxy, no multi-tenant database. The author of this server never sees anyone's credentials or data.
- **Credentials live only in your MCP client's secure config.** Claude Desktop stores them in your OS keychain. The npx path reads them from environment variables you set yourself. Nothing is logged, written to disk by this server, or sent anywhere except `https://rest.cozi.com`.
- **API surface is constrained.** This server only contacts `rest.cozi.com` for the same endpoints the Cozi web app uses (auth, lists, calendar, family members). The full request/response code lives in `src/cozi/` — about 500 lines of TypeScript you can audit yourself.
- **Open source, MIT licensed.** Pin a specific version (`@mjucius/cozi-mcp@2.0.0`) if you want a stable target, or fork the repo and run your own build if you want zero supply-chain trust.

### Security & trust model

This is a single-user server by design. The Cozi credential holder **is** the principal — there is no separate per-caller authentication gate, because each user runs their own instance against their own Cozi account. Concretely:

- **stdio (npx / MCPB) trusts the local user.** Whoever can launch the process and read the configured `COZI_USERNAME` / `COZI_PASSWORD` (or the OS keychain entry) is treated as the account owner. The trust boundary is your machine and its user account.
- **No multi-tenancy.** Each user configures their own instance with their own Cozi account. There is no shared backend, no tenant isolation to breach, and no per-caller authentication beyond possession of valid Cozi credentials — which is the same access model as the Cozi web app itself.

Two defensive measures narrow the blast radius of that model:

- **Time-bounded credential cache.** Authenticated clients are cached only for a bounded lifetime, so a rotated or revoked Cozi password stops working rather than being honored indefinitely from a stale cached session.
- **Failed-login rate limiting.** Repeated failed authentication attempts are rate-limited to blunt credential-guessing against the Cozi endpoint.

## Tools

The server exposes 15 tools by default, or 6 read-only tools when `COZI_READ_ONLY=true` (or
the MCPB read-only setting) is enabled. Returns are slim dicts with `null`/empty fields omitted.

### Family

- `family_members()` → `[{id, name, color?}]` — call this first to get attendee IDs for appointments.

### Lists

- `get_lists(list_type?)` → `[{id, title, type, item_count, completed_count}]` — `list_type` is optional, `'shopping'` or `'todo'`.
- `get_list_items(list_id, include_completed=false)` → `[{id, text, status, position?, header?}]` — `header: true` marks a section heading (e.g. "PRODUCE"), not an item.
- `create_list(name, list_type)` → `{id, title, type}`.
- `rename_list(list_id, title)` → `{id, title, type}` — the items stay as they are.
- `delete_list(list_id)` → `boolean`.

`create_list`, `rename_list` and `delete_list` are hidden in read-only mode.

### Items

- `add_item(list_id, text, position=0)` → `{id, text}`.
- `update_item(list_id, item_id, text?, completed?)` → `{id, text, status}` — pass either or both. **Non-atomic when both are passed**: the text is updated first, then the status.
- `remove_items(list_id, item_ids)` → `boolean`.

All item tools are hidden in read-only mode.

### Calendar

- `today()` → `{date, weekday, time, timezone}` — the current local time on your machine. Every tool result also ends with this as a separate line, so the assistant resolves "tomorrow" against your clock rather than its own (often UTC). Set the standard `TZ` env var (e.g. `TZ=America/New_York`) if the server runs somewhere other than your own computer.
- `get_calendar(year, month)` → `[{id, subject, day, all_day, start?, end?, end_day?, attendees?, location?, notes?, reminders?, kind?, read_only?, source?, recurring?, recurrence?, series_start?, series_end?, skipped_days?}]`. `day` is the day the entry happens; `end_day` appears only on multi-day events, which Cozi lists in every month they overlap (so `day` may fall outside the month you asked for). A recurring series is listed **once per occurrence** in the month, on the days Cozi itself expands it to: each entry has the series `id`, its own `day` (and `end_day` when the occurrence spans days), `series_start`, and `recurrence` (Cozi's wording of the rule). Occurrences deleted in the Cozi app are left out and named in `skipped_days`; a series with no occurrence left in a month is not listed for that month. `kind` marks non-appointments such as birthdays; `read_only` items (holidays, subscribed calendars, named by `source`) cannot be changed. `reminders` are minutes before the start.
- `search_calendar(query)` → `{appointments: [...same fields, last_day?, next_days?], more?}` — Cozi's own search across months. A recurring series reports its latest past occurrence and the next ten. Cozi searches from a few years back onward, and a brand-new appointment can take a few seconds to show up.
- `create_appointment(subject, start, end, attendees?, all_day=false, notes='', location?, repeat?, reminders?, notify?)` — `start` and `end` are ISO datetimes (e.g. `'2026-06-15T10:00:00'`). For all-day events (`all_day=true`) a bare date (e.g. `'2026-06-15'`) is also accepted and `end` may equal `start`; a bare date on a timed event is an error. Put `end` on a later date for a multi-day event; the result reports the span as `end_day`. An `end` before `start` is an error. `repeat` makes it a series: `{frequency: 'daily'|'weekly'|'monthly'|'yearly', interval?, weekdays?, monthly_by?: 'day_of_month'|'weekday', until?}` (no `until` repeats forever). `reminders` are minutes before the start, e.g. `[30, 1440]`.
- `update_appointment(appointment_id, year, month, ...)` — partial update via fetch-then-merge: pass `(appointment_id, year, month)` plus any fields to change. Omitted fields are preserved. To switch a timed appointment to all-day pass `all_day=true`; to switch to timed pass new `start`/`end`. Passing `end` re-spans the event against its (possibly newly set) start day, so an `end` on a later date makes it multi-day and one on the start day collapses it back; passing `start` alone moves the event and keeps its length. A bare date is accepted for `start`/`end` when the event is, or is being made, all-day; on a timed event it is an error. A recurring series needs `scope`: `'this'` changes only the occurrence on `occurrence_day` (Cozi stores the changed copy as its own appointment, which is returned), `'this_and_following'` changes it and every later one (Cozi splits the series), `'series'` changes every occurrence. `repeat` replaces a series' rule or turns a one-off into a series; `reminders` replace the existing ones (`[]` clears them).
- `delete_appointment(appointment_id, year, month, scope?, occurrence_day?, notify?)` → `boolean`. Errors if the id is not on the `(year, month)` page. A recurring series needs `scope`: `'this'` removes the occurrence on `occurrence_day`, `'this_and_following'` ends the series before it, `'series'` removes every occurrence. Single-occurrence deletes are read back to confirm Cozi applied them.

Holidays, subscribed calendars and birthdays are refused by `update_appointment` and `delete_appointment`. `notify=true` on any calendar write sends Cozi's change notification to the attendees who have notifications on (like the Cozi app's "notify" option); it is off by default.

`create_appointment`, `update_appointment`, and `delete_appointment` are hidden in read-only mode.

### Workflow tip

When creating or updating appointments with specific attendees, call `family_members()` first and use those `id` values in the `attendees` arg. Calendar tools are scoped to a `(year, month)` page — pass the same `year`/`month` back when updating or deleting an appointment from that page.

## Migration from v1 (Python)

v2.0 is a Node/TypeScript rewrite of the previous Python implementation, distributed as MCPB and npx. The runtime changed AND the tool surface was consolidated — if you have prompts written against v1, update them as follows:

| v1 (Python, 14 tools) | v2 (Node, 12 tools) |
|---|---|
| `get_family_members` | `family_members` |
| `get_lists_by_type(t)` | `get_lists(list_type=t)` |
| `update_item_text(...)` + `mark_item(...)` | `update_item(text?, completed?)` (merged) |
| `add_item(list_id, item_text, ...)` | `add_item(list_id, text, ...)` (param renamed) |
| `update_appointment(appointment_obj)` | `update_appointment(appointment_id, year, month, ...partial)` |
| `update_list` (item reordering) | removed |
| `delete_appointment(id)` | `delete_appointment(id, year, month)` |
| `get_lists` returned nested items | now summary only — fetch items via `get_list_items(list_id)` |

The legacy v1 Python source is preserved at git tag [`v1.0.0`](https://github.com/mjucius/cozi_mcp/releases/tag/v1.0.0) for reference.

## Development

Requires Node 20+ (see `.nvmrc`).

```bash
nvm use
npm install
npm test               # vitest, mocked at the CoziClient boundary; no credentials
npm run test:live      # live conformance suite against real Cozi (creds.env); required before a release
npm run typecheck
npm run build          # tsup → dist/
npm run dev            # local stdio dev with COZI_USERNAME / COZI_PASSWORD env vars
npm run bundle:mcpb    # produces cozi-mcp.mcpb at repo root
```

The repo layout:

```
cozi_mcp/
├── src/
│   ├── server.ts              # MCP server factory
│   ├── bin.ts                 # npx + MCPB stdio entry point
│   ├── instructions.ts
│   ├── cozi/                  # Inlined Cozi HTTP client (no separate npm package)
│   └── tools/                 # 13 MCP tools
├── tests/                     # vitest, mocks CoziClient at the boundary
├── manifest.json              # MCPB manifest (Claude Desktop)
└── package.json
```

The Cozi HTTP client is inlined under `src/cozi/` rather than published as a separate npm package — it's small, only useful for this MCP server, and avoids the supply-chain surface area of a separate dependency. If you'd prefer the Python equivalent for your own projects, see [py-cozi-client](https://github.com/mjucius/py-cozi-client).

## Acknowledgments

- The `?apikey=coziwc|v…_production` requirement on the Cozi auth endpoint was reverse-engineered from the live `my.cozi.com` web bundle by [Wetzel402/py-cozi PR #3](https://github.com/Wetzel402/py-cozi/pull/3). Without that discovery, every login attempt from a server environment fails with a misleading 401 regardless of credential validity.
- Built on the [Model Context Protocol](https://modelcontextprotocol.io) and its [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) by Anthropic.

## Trademark and affiliation

Cozi and the Cozi logo are trademarks of Cozi Group Inc. This project is unofficial and not affiliated with, endorsed by, or sponsored by Cozi Group Inc. Use of the Cozi API is at your own risk and subject to [Cozi's Terms of Service](https://www.cozi.com/terms-of-service/).

## License

MIT — see [LICENSE](LICENSE).

## Contributing

PRs welcome. Please run `npm test` and `npm run typecheck` before submitting.
