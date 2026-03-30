# Python Test Coverage Report

**Date:** 2026-03-30
**Tests:** 818 passed, 0 failed (+72 tests since last report)
**Overall Coverage:** 76% (577 of 2376 statements missing) -- up from 68%

## Coverage by File

| File | Stmts | Miss | Cover | Prev | Delta |
|------|-------|------|-------|------|-------|
| `__init__.py` | 1 | 0 | 100% | 100% | -- |
| `__main__.py` | 3 | 3 | **0%** | 0% | -- |
| `broker.py` | 227 | 26 | 89% | 89% | -- |
| `cli.py` | 501 | 293 | **42%** | 22% | +20% |
| `config.py` | 64 | 3 | 95% | 95% | -- |
| `hook_installer.py` | 132 | 14 | 89% | 89% | -- |
| `log_exporter.py` | 160 | 7 | 96% | 96% | -- |
| `mcp_server.py` | 160 | 86 | **46%** | 19% | +27% |
| `mcp_tools.py` | 264 | 4 | 98% | 98% | -- |
| `mention.py` | 26 | 0 | 100% | 100% | -- |
| `message.py` | 68 | 0 | 100% | 100% | -- |
| `participant.py` | 49 | 0 | 100% | 100% | -- |
| `tui/__init__.py` | 5 | 3 | 40% | 40% | -- |
| `tui/app.py` | 312 | 93 | **70%** | 55% | +15% |
| `tui/channel_list.py` | 93 | 3 | 97% | 97% | -- |
| `tui/chat_view.py` | 129 | 8 | 94% | 94% | -- |
| `tui/message_input.py` | 71 | 6 | 92% | 92% | -- |
| `tui/participant_list.py` | 72 | 10 | 86% | 82% | +4% |
| `tui/status_bar.py` | 39 | 18 | **54%** | 54% | -- |

## Biggest Improvements

1. **`mcp_server.py`** -- 19% -> 46% (+27%, 43 new lines covered)
2. **`cli.py`** -- 22% -> 42% (+20%, 97 new lines covered)
3. **`tui/app.py`** -- 55% -> 70% (+15%, 47 new lines covered)
4. **`tui/participant_list.py`** -- 82% -> 86% (+4%, 3 new lines covered)

## Remaining Gaps

### 1. `cli.py` -- 42% (293 lines missing)
- Lines 175-570: `send`, `listen`, `logs`, `log-export`, `history`, `search` commands
- Lines 602-624: `participants` command
- Lines 701-712, 800-834: `channel` and `hook` subcommands
- Lines 929-949, 1020-1120: `daemon` commands, `start-broker`

### 2. `mcp_server.py` -- 46% (86 lines missing)
- Lines 125-163: Server configuration and tool registration
- Lines 248-280: Request handlers
- Lines 410-466: Server lifecycle management

### 3. `tui/app.py` -- 70% (93 lines missing)
- Lines 149-228: Channel switching, message sending, participant updates
- Lines 232-291: Connection management, reconnection logic
- Lines 390-444: MQTT message processing

### 4. `tui/status_bar.py` -- 54% (18 lines missing)
- Lines 38-73: All rendering and update logic

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

Overall coverage rose from **68% to 76%** with 72 new tests (746 -> 818 total). The three previously weakest files all saw significant improvement: `mcp_server.py` (+27%), `cli.py` (+20%), and `tui/app.py` (+15%). Together these 72 tests covered 190 previously-untested lines. The remaining 577 missing lines are concentrated in CLI command handlers (293), MCP server lifecycle (86), and TUI app interaction flows (93).
