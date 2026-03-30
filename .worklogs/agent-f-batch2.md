# Agent-F Batch 2 Work Log

**Task:** CLI Commands (start/stop/send/status + tui/web/log + conv subcommands)
**File modified:** `src/claude_comms/cli.py`
**Date:** 2026-03-29

## What was done

Modified the existing `cli.py` to add all specified CLI commands while preserving Agent-A's existing `app`, `conv_app`, `console`, and `init` command.

### Top-level commands added

| Command | Description |
|---------|-------------|
| `start` | Start daemon (broker + MCP + optional web). Supports `--background`/`-b` for daemonization and `--web`/`-w` for web UI. Foreground mode uses asyncio event loop with signal handlers for graceful shutdown. Background mode re-launches as detached subprocess. |
| `stop` | Read PID file, send SIGTERM, poll for 10s, escalate to SIGKILL. Handles stale PID files. |
| `send` | Send message as configured identity. Options: `-c/--conversation`, `-t/--to`. Uses short-lived aiomqtt client to publish directly to broker. Validates identity exists and daemon is running. |
| `status` | Shows daemon PID status, broker config (host/connect mode), MCP endpoint, web UI status, identity, default conversation. If daemon is running, probes broker connectivity via aiomqtt. |
| `tui` | Launches Textual TUI chat (imports `claude_comms.tui.app.ChatApp`). Graceful error if module not yet available. |
| `web` | Opens `http://127.0.0.1:{web_port}` in default browser via `webbrowser.open`. Warns if daemon not running. |
| `log` | Tails `{conv}.log` in real-time using `tail -f` with Python polling fallback. |

### Conv subcommands added

| Command | Description |
|---------|-------------|
| `conv list` | Lists conversations from auto_join config + discovered log/jsonl files. Uses Rich table. |
| `conv create <name>` | Validates conv_id, publishes retained metadata JSON to `claude-comms/conv/{name}/meta`. |
| `conv delete <name>` | Safety confirmation prompt (skip with `--force`), clears retained meta by publishing empty payload. |

### Helpers added

- `_require_config()` -- loads config with friendly error if not initialized
- `_read_pid()` / `_is_daemon_running()` -- thin wrappers around `EmbeddedBroker` static methods

### Design decisions

- **Broker imports are lazy** -- `EmbeddedBroker` and `aiomqtt` are imported inside functions to keep CLI responsive and avoid import errors when optional deps aren't installed
- **`start --background`** re-launches the same CLI without `--background` as a detached subprocess (via `start_new_session=True`), avoiding double-fork complexity
- **`start` foreground** writes its own PID file immediately (separate from broker's internal PID write) so `stop` works whether or not the broker fully started
- **Signal handling** uses `loop.add_signal_handler` for clean asyncio integration
- **`send`** creates a `Message` via `Message.create()` and publishes directly via aiomqtt -- does not go through MCP
- **`conv create`** publishes retained metadata matching the architecture's Conversation Meta schema (`conv_id`, `created_by`, `created_at`, `topic`)
- **`conv delete`** publishes empty retained message to clear the topic (standard MQTT retained message deletion)
- **Auth** is conditionally applied on all MQTT client connections when `auth.enabled` + credentials are present

### Dependencies used

- `typer` (Option, Argument, confirm)
- `rich` (Console, Table)
- `asyncio`, `signal`, `subprocess`, `webbrowser`, `json`, `os`, `sys`, `time`
- `aiomqtt` (lazy import for send/status/conv commands)
- `claude_comms.broker.EmbeddedBroker` (lazy import)
- `claude_comms.message.Message`, `validate_conv_id` (lazy import)
- `claude_comms.config` (load_config, get_config_path, etc.)

### Not yet wired (placeholders for future batches)

- MCP server startup in `start` command (prints ready message but doesn't actually start mcp_tools server yet)
- Web server startup in `start` command (prints available message but doesn't serve static files yet)
- TUI app import path (`claude_comms.tui.app.ChatApp`) -- will work once TUI agent delivers
