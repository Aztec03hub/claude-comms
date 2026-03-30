# Changelog

All notable changes to Claude Comms are documented here.

## [0.1.0] - 2026-03-29

Initial implementation across three development batches.

### Batch 1 -- Project Scaffolding + Core Modules (2026-03-13)

- Project scaffolding with hatchling build system and src layout
- YAML config management (`~/.claude-comms/config.yaml`) with deep merge defaults, chmod 600, and env var password resolution
- Typer CLI with `init` command (identity key generation, config creation)
- Pydantic message model with UUID4 IDs, sender blocks, conversation routing, and @mention recipients
- Participant identity model (8-hex key, mutable name, type) with MQTT serialization
- @mention parsing: `[@name1, @name2]` prefix extraction, name-to-key resolution, prefix building
- Embedded amqtt MQTT broker wrapper with lifecycle management
- Message deduplication (bounded LRU set) and in-memory message store (per-conversation, capped)
- JSONL log replay for history reconstruction on startup
- Test suite: config, message, participant, mention, broker modules

### Batch 2 -- Integration Layer (2026-03-29)

- MCP server via FastMCP with Streamable HTTP transport (`stateless_http=True`)
- Full `comms_*` tool suite: join, send, read, history, check, members, conversations, leave, update_name
- Token-aware pagination for MCP output (20k token cap with headroom)
- Participant registry with thread-safe in-memory storage, per-conversation membership, and read cursors
- MQTT log exporter with dual-format output (.log human-readable + .jsonl structured)
- Log rotation support (configurable max size and file count)
- PostToolUse notification hook installer for Claude Code (Unix + Windows)
- CLI commands: start/stop daemon, send, status, tui, web, log tail, conv list/create/delete
- Background daemon mode with PID file management and graceful SIGTERM/SIGKILL shutdown
- Broker connectivity probe in status command
- Test suite: MCP tools, log exporter, notification hook modules

### Batch 3 -- UI Clients (2026-03-29)

- Textual TUI client with 3-column layout (channels, chat, participants)
- TUI features: @mention Tab completion, unread badges, presence dots, code block highlighting
- TUI keybindings: Ctrl+Q quit, Ctrl+N new conversation, Ctrl+K cycle channels
- Carbon Ember TCSS theme for TUI
- Svelte 5 web UI with MQTT.js WebSocket connection
- Web components: Avatar, ChatView, MessageBubble, MessageGroup, MessageActions, Sidebar
- Reactive MQTT store and notification system (Svelte 5 runes)
- Vite 6 build with Tailwind CSS 4

### Known Issues

- `amqtt` pins `typer==0.15.4` while `mcp[cli]` requires `typer>=0.16.0`. May need to install mcp without the `[cli]` extra.
- WSL2 with Windows-mounted filesystems may not support chmod 600 on config files (falls back to warning).
