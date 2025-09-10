# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Python-based MCP (Model Context Protocol) server that exposes Cozi Family Organizer API functionality as tools for AI assistants like Claude Desktop. The server provides comprehensive access to Cozi lists, calendar, and family management features.

**🚀 Smithery.ai Deployment Ready**: This project is now configured for deployment on Smithery.ai with proper credential management and cloud deployment capabilities.

## Development Commands

### Local Development with uv (Recommended for Smithery)

- `uv sync` - Install dependencies and sync virtual environment
- `uv run playground` - Start interactive Smithery playground for testing tools
- `uv run dev` - Start development server
- `pip install -e .` - Alternative: Install the package in development mode

### Legacy Development Commands

Based on the Claude Code permissions configured in `.claude/settings.local.json`:

- `COZI_USERNAME=test COZI_PASSWORD=test python debug_appointment.py` - Debug appointment functionality

## Environment Variables

The MCP server requires these environment variables:
- `COZI_USERNAME` - Your Cozi account username/email
- `COZI_PASSWORD` - Your Cozi account password

For testing, use `test` for both values.

## Architecture

### Core Components

- `src/cozi_mcp/server.py` - FastMCP server implementation with all 13 tool handlers
- `src/cozi_mcp/__init__.py` - Package initialization and exports
- `debug_appointment.py` - Debug script for testing appointment functionality

### Dependencies

- `py-cozi-client>=1.2.0` - Published Cozi API client library
- `mcp>=1.0.0` - Model Context Protocol framework (using FastMCP)

### Available MCP Tools

The server exposes these tools for AI assistants:

**Family Management:**
- `get_family_members` - Get all family members in the account

**List Management:**
- `get_lists` - Get all lists (shopping and todo)
- `get_lists_by_type` - Filter lists by type (shopping/todo)
- `create_list` - Create new lists
- `delete_list` - Delete existing lists

**Item Management:**
- `add_item` - Add items to lists
- `update_item_text` - Update item text
- `mark_item` - Mark items complete/incomplete
- `remove_items` - Remove items from lists

**Calendar Management:**
- `get_calendar` - Get appointments for a specific month
- `create_appointment` - Create new calendar appointments
- `update_appointment` - Update existing appointments
- `delete_appointment` - Delete appointments

## Testing

### Local Testing with Smithery Playground

The recommended way to test the MCP server locally:

```bash
# Install dependencies
uv sync

# Start interactive playground (opens browser interface)
uv run playground
```

The playground will:
- Start the MCP server on `http://127.0.0.1:8081`
- Open Smithery's interactive testing interface
- Allow you to test all 13 MCP tools with real-time responses
- Show validation errors and debug information

**Note**: The playground will show config validation warnings since no credentials are provided locally. This is expected behavior.

### Legacy Testing

Test appointment functionality:
```bash
COZI_USERNAME=test COZI_PASSWORD=test python debug_appointment.py
```

## Integration

### Local Development
To use this MCP server with Claude Desktop or other MCP clients, configure the client to connect to this server's stdio interface. The server communicates via JSON-RPC over stdin/stdout.

### Smithery.ai Deployment

This project is configured for deployment on Smithery.ai with the following files:

- `smithery.yaml` - Runtime configuration (Python)
- `pyproject.toml` - Dependencies and server configuration pointing to `cozi_mcp.server:create_server`
- `requirements.txt` - Python dependencies for deployment

#### Deployment Process:
1. Push this code to GitHub
2. Connect your GitHub repository to Smithery.ai
3. Configure the Cozi username and password in Smithery's deployment settings
4. Deploy via the Smithery dashboard

#### Configuration:
The server uses Smithery's configuration system to securely manage Cozi credentials. When deployed, users configure their `username` and `password` through Smithery's interface, eliminating the need for environment variables.