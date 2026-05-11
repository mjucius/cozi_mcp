<p align="center">
  <img src="assets/cozi_mcp_logo.svg" width="128" alt="Cozi MCP logo" />
</p>

# Cozi MCP Server

An unofficial [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI assistants like Claude read and update your [Cozi Family Organizer](https://www.cozi.com/) lists and calendar.

Each user runs their own instance against their own Cozi account. Your credentials are stored in your MCP client's secure config (Claude Desktop's OS keychain, Smithery's encrypted session config, or your local environment) and never leave your machine — the author of this server has no access to your data.

## Install

### 1. MCPB (recommended for Claude Desktop)

Download the latest `.mcpb` from the [Releases page](https://github.com/mjucius/cozi_mcp/releases) and double-click to install in Claude Desktop. You'll be prompted for your Cozi username and password — they're stored securely in your OS keychain.

This path requires no Node, npm, or Python install on your machine.

### 2. Smithery (for other MCP clients)

For Cursor, ChatGPT-style clients, or web agents that connect to Smithery-hosted servers:

**[Deploy on Smithery.ai →](https://smithery.ai/server/@mjucius/cozi_mcp)**

Configure your Cozi credentials in the Smithery UI; each session runs in isolation with its own credential set.

### 3. npx (for power users)

Add this to your Claude Desktop `claude_desktop_config.json` (or any other MCP client config file):

```json
{
  "mcpServers": {
    "cozi": {
      "command": "npx",
      "args": ["-y", "@mjucius/cozi-mcp"],
      "env": {
        "COZI_USERNAME": "you@example.com",
        "COZI_PASSWORD": "your-password"
      }
    }
  }
}
```

Requires Node 20+. The package will be downloaded on first run.

## Trust and Security

Cozi has no OAuth — username/password authentication is the only way the API supports. This server handles that fact honestly:

- **Per-user, by architecture.** Each user runs their own instance against their own Cozi account. There is no shared backend, no proxy, no multi-tenant database. The author of this server never sees anyone's credentials or data.
- **Credentials live only in your MCP client's secure config.** Claude Desktop stores them in your OS keychain. Smithery encrypts them per-session. The npx path reads them from environment variables you set yourself. Nothing is logged, written to disk by this server, or sent anywhere except `https://rest.cozi.com`.
- **API surface is constrained.** This server only contacts `rest.cozi.com` for the same endpoints the Cozi web app uses (auth, lists, calendar, family members). The full request/response code lives in `src/cozi/` — about 500 lines of TypeScript you can audit yourself.
- **Open source, MIT licensed.** Pin a specific version (`@mjucius/cozi-mcp@2.0.0`) if you want a stable target, or fork the repo and run your own build if you want zero supply-chain trust.

## Tools

The server exposes 12 tools. Returns are slim dicts with `null`/empty fields omitted.

### Family

- `family_members()` → `[{id, name, color?}]` — call this first to get attendee IDs for appointments.

### Lists

- `get_lists(list_type?)` → `[{id, title, type, item_count, completed_count}]` — `list_type` is optional, `'shopping'` or `'todo'`.
- `get_list_items(list_id, include_completed=false)` → `[{id, text, status, position?}]`.
- `create_list(name, list_type)` → `{id, title, type}`.
- `delete_list(list_id)` → `boolean`.

### Items

- `add_item(list_id, text, position=0)` → `{id, text}`.
- `update_item(list_id, item_id, text?, completed?)` → `{id, text, status}` — pass either or both. **Non-atomic when both are passed**: the text is updated first, then the status.
- `remove_items(list_id, item_ids)` → `boolean`.

### Calendar

- `get_calendar(year, month)` → `[{id, subject, day, all_day, start?, end?, attendees?, location?, notes?}]`.
- `create_appointment(subject, start, end, attendees?, all_day=false, notes='', location?)` — `start` and `end` are ISO datetimes (e.g. `'2026-06-15T10:00:00'`). For all-day events `end` may equal `start`.
- `update_appointment(appointment_id, year, month, ...)` — partial update via fetch-then-merge: pass `(appointment_id, year, month)` plus any fields to change. Omitted fields are preserved. To switch a timed appointment to all-day pass `all_day=true`; to switch to timed pass new `start`/`end`.
- `delete_appointment(appointment_id, year, month)` → `boolean`.

### Workflow tip

When creating or updating appointments with specific attendees, call `family_members()` first and use those `id` values in the `attendees` arg. Calendar tools are scoped to a `(year, month)` page — pass the same `year`/`month` back when updating or deleting an appointment from that page.

## Migration from v1 (Python)

v2.0 is a Node/TypeScript rewrite of the previous Python implementation, distributed as MCPB / npx / Smithery. The runtime changed AND the tool surface was consolidated — if you have prompts written against v1, update them as follows:

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
npm test               # vitest, 68 tests
npm run typecheck
npm run build          # tsup → dist/
npm run dev            # local stdio dev with COZI_USERNAME / COZI_PASSWORD env vars
npm run playground     # @smithery/cli local playground UI
npm run bundle:mcpb    # produces cozi-mcp.mcpb at repo root
```

The repo layout:

```
cozi_mcp/
├── src/
│   ├── server.ts              # MCP server factory (Smithery default export)
│   ├── bin.ts                 # npx + MCPB stdio entry point
│   ├── instructions.ts
│   ├── cozi/                  # Inlined Cozi HTTP client (no separate npm package)
│   └── tools/                 # 12 MCP tools
├── tests/                     # vitest, mocks CoziClient at the boundary
├── manifest.json              # MCPB manifest (Claude Desktop)
├── smithery.yaml              # Smithery deploy manifest
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
