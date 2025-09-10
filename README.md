# Cozi MCP Server

An unofficial Model Context Protocol (MCP) server that provides AI assistants like Claude Desktop with access to [Cozi Family Organizer](https://www.cozi.com/) functionality. This server exposes Cozi's lists, calendar, and family management features through a standardized MCP interface so you can ask your AI to manage events and lists for you.

🚀 **Now deployable on [Smithery.ai](https://smithery.ai)** - Deploy this MCP server to the cloud with secure credential management!

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

### Using Smithery.ai (Recommended)

The easiest way to use this MCP server is through Smithery.ai:

**🚀 [Deploy on Smithery.ai](https://smithery.ai/server/@mjucius/cozi_mcp)**

Visit the server page for complete installation instructions and one-click deployment to your AI assistant.

### Local Development

For developers who want to modify or contribute to the project:

1. Clone the repository:
```bash
git clone https://github.com/mjucius/cozi-mcp.git
cd cozi-mcp
```

2. Install dependencies:
```bash
uv sync
```

3. Start the development playground:
```bash
uv run playground
```

## Usage

### Cloud Deployment (Smithery.ai)

Once deployed on Smithery.ai, your MCP server runs in the cloud and can be accessed by any MCP-compatible AI assistant using the provided endpoint URL.

### Local Development & Testing

Test the server locally with the interactive playground:
```bash
# Start the interactive playground
uv run playground

# Or start development server
uv run dev
```

The playground provides a web interface to test all MCP tools with real-time responses and debugging information.

### Integration with AI Assistants

The easiest way to integrate this MCP server is through the [Smithery.ai server page](https://smithery.ai/server/@mjucius/cozi_mcp), which provides step-by-step instructions for your specific AI assistant.

For advanced users doing local development, the server can be run locally using the stdio interface.

## Development

### Requirements
- Python 3.10+
- Cozi Family Organizer account
- uv (recommended) or pip

### Dependencies
- `mcp>=1.0.0` - Model Context Protocol framework
- `py-cozi-client>=1.3.0` - Cozi API client library
- `smithery` - Smithery.ai deployment framework

### Development Setup

1. Clone the repository:
```bash
git clone https://github.com/yourusername/cozi-mcp.git
cd cozi-mcp
```

2. Install dependencies:
```bash
# With uv (recommended)
uv sync

# Or with pip
pip install -e .
```

3. Start the development playground:
```bash
uv run playground
```

### Project Structure

```
cozi-mcp/
├── smithery.yaml              # Smithery.ai deployment config
├── pyproject.toml             # Project dependencies and metadata  
├── src/
│   └── cozi_mcp/
│       ├── __init__.py       # Package exports
│       └── server.py         # MCP server implementation
└── [other files...]
```

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
- **Smithery.ai** - Cloud deployment and credential management
- **py-cozi-client** - Python client library for Cozi's API
- **Pydantic models** - All API responses use structured data models

The server maintains a single authenticated session with Cozi and exposes all functionality through the MCP protocol. When deployed on Smithery.ai, credentials are securely managed through the platform's configuration system.

## License

MIT License - see LICENSE file for details.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.