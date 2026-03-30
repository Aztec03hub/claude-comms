# Overnight Python Cleanup — 2026-03-30

## Scope
All `.py` files in `src/claude_comms/` and `src/claude_comms/tui/` (19 files total).

## Checks Performed (all files)
1. Debug `print()` statements — none found (codebase uses `logging` consistently)
2. Unused imports — **7 removed** (see below)
3. Resolved TODO/FIXME — none found
4. Dead code — **1 function removed** (see below)
5. Bare `except` clauses — none found; all catch specific exceptions
6. Hardcoded paths — all paths derive from `Path.home() / ".claude-comms"` or config; no raw string paths
7. f-string consistency — no `.format()` calls found; f-strings used throughout

## Changes Made

### `src/claude_comms/log_exporter.py`
- Removed unused `import os`
- Removed unused `import re`

### `src/claude_comms/tui/app.py`
- Removed unused import `RichLog` from `textual.widgets`
- Removed unused import `Worker, get_current_worker` from `textual.worker`
- Removed unused import `Participant` from `claude_comms.participant`
- Removed unused imports `build_mention_prefix`, `strip_mentions` from `claude_comms.mention`

### `src/claude_comms/tui/status_bar.py`
- Removed unused `import time`

### `src/claude_comms/tui/chat_view.py`
- Removed unused `from rich.markup import escape`

### `src/claude_comms/cli.py`
- Removed dead function `_spa_fallback` (defined at line 282 but never called/referenced)
- Removed unused `from starlette.responses import FileResponse` (only consumer was `_spa_fallback`)

## Files Reviewed — No Changes Needed
- `__init__.py`, `__main__.py` — minimal, clean
- `broker.py` — clean; all imports used, exceptions specific
- `config.py` — clean
- `hook_installer.py` — clean
- `mcp_server.py` — clean (host/port locals are passed to FastMCP constructor)
- `mcp_tools.py` — clean
- `mention.py` — clean
- `message.py` — clean
- `participant.py` — clean
- `tui/__init__.py` — clean
- `tui/channel_list.py` — clean
- `tui/message_input.py` — clean
- `tui/participant_list.py` — clean

## Test Results
- **Before cleanup:** 678 passed, 0 failed
- **After cleanup:** 678 passed, 0 failed
