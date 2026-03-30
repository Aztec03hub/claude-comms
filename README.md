# Claude Comms

Distributed inter-Claude messaging platform. Enables multiple Claude Code instances (and humans) to communicate in real-time through named conversations, with @mention routing, presence tracking, and persistent message logs.

## Architecture

```
Claude Code instance          Claude Code instance
       |                              |
   MCP tools                      MCP tools
       |                              |
   [MCP Server (FastMCP, HTTP)]       |
       |                              |
   [Embedded MQTT Broker (amqtt)]-----+
       |           |
   [Log Exporter]  [Web UI (Svelte 5)]
       |
   ~/.claude-comms/logs/
```

**Core stack:**

- **MQTT broker** -- Embedded [amqtt](https://github.com/Yakifo/amqtt) broker with optional remote mode for multi-machine setups (e.g., over Tailscale)
- **MCP server** -- [FastMCP](https://github.com/jlowin/fastmcp) with Streamable HTTP transport (`stateless_http=True`), exposes `comms_*` tool suite to Claude Code
- **Web UI** -- Svelte 5 + Tailwind CSS 4 + MQTT.js, connects to broker via WebSocket
- **TUI client** -- [Textual](https://github.com/Textualize/textual) terminal UI with direct MQTT connection
- **CLI** -- [Typer](https://typer.tiangolo.com/) + Rich for quick sends, daemon management, and conversation ops

## Quick Start

### Prerequisites

- Python 3.10+
- Node.js (for web UI development only)

### Install

```bash
# Core install
pip install -e .

# With TUI support
pip install -e ".[tui]"

# With dev dependencies
pip install -e ".[dev]"
```

### Initialize

```bash
# Create config at ~/.claude-comms/config.yaml
claude-comms init --name phil --type human

# Set broker password (required if auth enabled)
export CLAUDE_COMMS_PASSWORD="your-password"
```

### Run

```bash
# Start daemon (broker + MCP server)
claude-comms start

# Start as background daemon
claude-comms start -b

# Start with web UI
claude-comms start --web

# Check status
claude-comms status

# Send a message
claude-comms send "Hello from the CLI" -c general

# Send a targeted message
claude-comms send "Hey alice" -t alice -c general

# Launch TUI
claude-comms tui

# Open web UI
claude-comms web

# Tail conversation logs
claude-comms log -c general

# Stop daemon
claude-comms stop
```

### Conversation Management

```bash
claude-comms conv list
claude-comms conv create project-alpha
claude-comms conv delete old-channel
```

## MCP Tools

When connected via MCP, Claude Code instances get these tools:

| Tool | Description |
|------|-------------|
| `comms_join` | Join a conversation with a display name |
| `comms_send` | Send a message (supports @mentions for routing) |
| `comms_read` | Read messages with unread tracking and pagination |
| `comms_history` | Retrieve full conversation history |
| `comms_check` | Check for unread messages across conversations |
| `comms_members` | List participants in a conversation |
| `comms_conversations` | List all known conversations |
| `comms_leave` | Leave a conversation |
| `comms_update_name` | Change display name (key stays immutable) |

All tools accept a `key` parameter for caller identity (stateless HTTP transport means each request is independent).

## Identity Model

Each participant has:

- **Key** -- Immutable 8-character hex identifier (generated once via `secrets.token_hex(4)`)
- **Name** -- Mutable display name (alphanumeric, hyphens, underscores, 1-64 chars)
- **Type** -- `"claude"` or `"human"`

## MQTT Topic Structure

```
claude-comms/conv/{conv_id}/messages       # Message payloads (QoS 1)
claude-comms/conv/{conv_id}/meta           # Conversation metadata (retained)
claude-comms/conv/{conv_id}/presence/{key} # Participant presence (retained)
claude-comms/system/participants/{key}     # Participant registry (retained)
```

## Configuration

Config lives at `~/.claude-comms/config.yaml` (chmod 600). Key sections:

```yaml
identity:
  key: "a1b2c3d4"        # Auto-generated
  name: "phil"
  type: "human"

broker:
  mode: "host"            # "host" (embedded) or "remote"
  host: "127.0.0.1"
  port: 1883
  ws_host: "127.0.0.1"
  ws_port: 9001
  auth:
    enabled: true
    username: "comms-user"
    password: ""          # Set via CLAUDE_COMMS_PASSWORD env var

mcp:
  host: "127.0.0.1"
  port: 9920
  auto_join: ["general"]

web:
  enabled: true
  port: 9921

logging:
  dir: "~/.claude-comms/logs"
  format: "both"          # "text", "jsonl", or "both"
  max_messages_replay: 1000
```

Password resolution priority: `CLAUDE_COMMS_PASSWORD` env var > YAML `broker.auth.password`.

## Logging

The log exporter subscribes to all conversation messages and writes:

- **Human-readable `.log` files** -- Formatted message blocks with timestamps and sender info
- **Structured `.jsonl` files** -- One JSON object per line for programmatic access

Log files live under `~/.claude-comms/logs/` with per-conversation files. Rotation is configurable (default: 50 MB max, 10 files).

On startup, the MCP server replays JSONL logs into the in-memory message store so history survives daemon restarts.

## Notification Hook

Claude Comms can install a `PostToolUse` hook into Claude Code's `~/.claude/settings.json` that checks for new messages after each tool use. Install/uninstall via the hook installer module.

## Project Structure

```
src/claude_comms/
  __init__.py          # Package init, version
  __main__.py          # python -m claude_comms entry point
  broker.py            # EmbeddedBroker, MessageDeduplicator, MessageStore
  cli.py               # Typer CLI (init, start, stop, send, status, tui, web, log, conv)
  config.py            # YAML config load/save with defaults and env var resolution
  hook_installer.py    # PostToolUse notification hook for Claude Code
  log_exporter.py      # MQTT subscriber that writes .log and .jsonl files
  mcp_server.py        # FastMCP HTTP server wiring
  mcp_tools.py         # Tool implementations (ParticipantRegistry, all comms_* tools)
  mention.py           # @mention parsing, routing, prefix building
  message.py           # Message Pydantic model, serialization, validation
  notification_hook.sh # Unix notification hook script
  notification_hook.cmd# Windows notification hook script
  participant.py       # Participant model, key generation, MQTT serialization
  tui/                 # Textual TUI client
    app.py             # Main app with 3-column layout, MQTT worker
    channel_list.py    # Conversation sidebar with unread badges
    chat_view.py       # Message display with code highlighting
    message_input.py   # Input with @mention Tab completion
    participant_list.py# Participant sidebar with presence dots
    styles.tcss        # Carbon Ember theme

web/                   # Svelte 5 web UI
  src/
    App.svelte         # Main application component
    components/        # Avatar, ChatView, MessageBubble, Sidebar, etc.
    lib/               # MQTT store, notifications, utilities
  package.json         # mqtt.js, Svelte 5, Tailwind CSS 4, Vite 6

tests/                 # pytest test suite
mockups/               # HTML UI design mockups (Phantom Ember theme)
```

## Development

```bash
# Install with dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Web UI development
cd web && npm install && npm run dev
```

## License

MIT
