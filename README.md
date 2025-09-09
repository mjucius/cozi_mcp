# Cozi MCP Server

An unofficial Model Context Protocol (MCP) server that provides AI assistants like Claude Desktop with access to [Cozi Family Organizer](https://www.cozi.com/) functionality. This server exposes Cozi's lists, calendar, and family management features through a standardized MCP interface so you can ask your AI to manage events and lists for you.

## Features

### Family Management
- Get family members and their information

### List Management  
- View all lists (shopping and todo lists)
- Filter lists by type
- Create and delete lists

### Item Management
- Add items to lists
- Update item text
- Mark items as complete/incomplete
- Remove items from lists

### Calendar Management
- View appointments for any month
- Create new appointments
- Update existing appointments
- Delete appointments

## Installation

1. Install the package:
```bash
pip install cozi-mcp
```

2. Set up your Cozi credentials by copying the example environment file:
```bash
cp .env.example .env
```

3. Edit `.env` and add your Cozi account credentials:
```
COZI_USERNAME=your-email@example.com
COZI_PASSWORD=your-password
```

## Usage

### Running the Server

Start the MCP server:
```bash
python cozi_mcp.py
```

The server communicates via JSON-RPC over stdin/stdout, following the MCP protocol specification.

### Testing

You can test the server with test credentials:
```bash
COZI_USERNAME=test COZI_PASSWORD=test timeout 3 python cozi_mcp.py
```

### Integration with Claude Desktop

To use this server with Claude Desktop, add the following configuration to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cozi": {
      "command": "python",
      "args": ["/path/to/cozi_mcp.py"],
      "env": {
        "COZI_USERNAME": "your-email@example.com",
        "COZI_PASSWORD": "your-password"
      }
    }
  }
}
```

## Development

### Requirements
- Python 3.8+
- Cozi Family Organizer account

### Dependencies
- `mcp>=1.0.0` - Model Context Protocol framework
- `py-cozi-client>=1.3.0` - Cozi API client library

### Development Setup

1. Clone the repository:
```bash
git clone https://github.com/yourusername/cozi-mcp.git
cd cozi-mcp
```

2. Install in development mode:
```bash
pip install -e .
```

3. Set up your environment variables as described above.

## Available MCP Tools

The server exposes these tools for AI assistants:

### Family Management
- `get_family_members` - Get all family members in the account

### List Management  
- `get_lists` - Get all lists (shopping and todo)
- `get_lists_by_type` - Filter lists by type (shopping/todo)  
- `create_list` - Create new lists
- `delete_list` - Delete existing lists

### Item Management
- `add_item` - Add items to lists
- `update_item_text` - Update item text
- `mark_item` - Mark items complete/incomplete
- `remove_items` - Remove items from lists

### Calendar Management
- `get_calendar` - Get appointments for a specific month
- `create_appointment` - Create new calendar appointments
- `update_appointment` - Update existing appointments  
- `delete_appointment` - Delete appointments

## Architecture

This MCP server is built using:
- **FastMCP** - Simplified MCP server framework
- **py-cozi-client** - Python client library for Cozi's API
- **Pydantic models** - All API responses use structured data models

The server maintains a single authenticated session with Cozi and exposes all functionality through the MCP protocol.

## License

MIT License - see LICENSE file for details.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.