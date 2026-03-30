# Python Test Coverage Report

**Date:** 2026-03-30
**Tests:** 746 passed, 0 failed
**Overall Coverage:** 68% (767 of 2376 statements missing)

## Coverage by File

| File | Stmts | Miss | Cover |
|------|-------|------|-------|
| `__init__.py` | 1 | 0 | 100% |
| `__main__.py` | 3 | 3 | **0%** |
| `broker.py` | 227 | 26 | 89% |
| `cli.py` | 501 | 390 | **22%** |
| `config.py` | 64 | 3 | 95% |
| `hook_installer.py` | 132 | 14 | 89% |
| `log_exporter.py` | 160 | 7 | 96% |
| `mcp_server.py` | 160 | 129 | **19%** |
| `mcp_tools.py` | 264 | 4 | 98% |
| `mention.py` | 26 | 0 | 100% |
| `message.py` | 68 | 0 | 100% |
| `participant.py` | 49 | 0 | 100% |
| `tui/__init__.py` | 5 | 3 | 40% |
| `tui/app.py` | 312 | 140 | **55%** |
| `tui/channel_list.py` | 93 | 3 | 97% |
| `tui/chat_view.py` | 129 | 8 | 94% |
| `tui/message_input.py` | 71 | 6 | 92% |
| `tui/participant_list.py` | 72 | 13 | 82% |
| `tui/status_bar.py` | 39 | 18 | **54%** |

## Lowest Coverage Files (action needed)

### 1. `__main__.py` -- 0% (3 lines missing)
- Lines 3-6: Entry point (`__main__` block) -- trivial but untested.

### 2. `mcp_server.py` -- 19% (129 lines missing)
- Lines 60-73: Server startup/initialization
- Lines 125-163: Server configuration and tool registration
- Lines 186-394: All MCP request handlers (the bulk of the server logic)
- Lines 410-466: Server lifecycle management
- **Impact:** Nearly all MCP server functionality is untested. This is the highest-risk gap -- the MCP server is a core integration surface.

### 3. `cli.py` -- 22% (390 lines missing)
- Lines 88-96: Config loading helpers
- Lines 175-570: The `send`, `listen`, `logs`, `log-export`, `history`, `search` commands
- Lines 585-624: `participants` command
- Lines 654-727: `channel` subcommands (create, list, join, leave, info, delete)
- Lines 760-989: `hook install/uninstall/status/test`, `forward` commands
- Lines 1001-1120: `start-broker`, `daemon start/stop/status/restart`
- **Impact:** Most CLI commands beyond `init` and `status` have zero test coverage. These are the primary user-facing entry points.

### 4. `tui/app.py` -- 55% (140 lines missing)
- Lines 149-228: Channel switching, message sending, participant updates
- Lines 232-291: Connection management, reconnection logic
- Lines 295-368: Event handlers (on_mount, on_key, compose)
- Lines 390-444: MQTT message processing
- Lines 478-537: Status updates, error handling
- **Impact:** Core TUI interaction flows (sending messages, switching channels, handling connection drops) are untested.

### 5. `tui/status_bar.py` -- 54% (18 lines missing)
- Lines 38-73: All rendering and update logic in the status bar widget.

## Well-Covered Files (90%+)

- `message.py` -- 100%
- `mention.py` -- 100%
- `participant.py` -- 100%
- `mcp_tools.py` -- 98%
- `channel_list.py` -- 97%
- `log_exporter.py` -- 96%
- `config.py` -- 95%
- `chat_view.py` -- 94%
- `message_input.py` -- 92%

## Summary

The data model layer (`message.py`, `mention.py`, `participant.py`, `mcp_tools.py`) is thoroughly tested. The biggest gaps are in the **MCP server** (19%), **CLI commands** (22%), and **TUI app** (55%). These three files account for 659 of the 767 missing lines (86% of all uncovered code). Prioritizing `mcp_server.py` and the untested CLI commands would yield the greatest coverage improvement.
