# Phase 5: TUI Participant System Redesign

**Agent:** E (TUI)
**Files:** `tui/app.py`, `tui/participant_list.py`
**Status:** COMPLETE

## Changes Made

### tui/participant_list.py
- Changed internal dict `_items` from `{composite_key: entry}` to `{user_key: entry}`
- `ParticipantItem` now carries a `connections: dict[str, dict]` sub-dict
- Added `CONNECTION_LABELS` mapping for display indicators: `[W]`, `[T]`, `[M]`, `[C]`, `[A]`
- `_refresh_display()` shows connection type indicators next to names
- `set_participant()` accepts `connection_key` and `connection_info` params, merges connections
- Added `remove_connection()` method to remove a single connection (removes participant if empty)
- `get_name_to_key()` now returns bare user keys (not composite)
- One row per user, no duplicates

### tui/app.py
- Added `self._instance_id = secrets.token_hex(2)` (4 hex chars) on startup
- New presence topic: `claude-comms/presence/{key}/tui-{instanceId}`
- LWT set on the per-instance presence topic
- Subscribe to `claude-comms/presence/+/+` (new) plus old `conv/{channel}/presence/+` (dual subscription)
- `_handle_presence` rewritten:
  - Validates `client` against `CONNECTION_TYPES` from `participant.py`
  - Builds `conn_key` from `{client}-{instanceId}`
  - Aggregates by user key (one entry per user)
  - Skips own TUI instance specifically (by key + client + instanceId)
  - Online: calls `set_participant` with connection info
  - Offline: calls `remove_connection` to remove specific connection
- Added `_heartbeat_loop()` coroutine (60-second periodic presence re-publish) via `asyncio.create_task`
- Added `_graceful_disconnect()`: publishes offline + empty retained to clean up instance topic
- Self-add uses user key with `connection_key="tui-{instance_id}"`
- Backward compat: still publishes to old conv-level and system/participants topics

### tests/test_tui.py
- Updated all 12+ presence handler tests for new data model
- Tests use new topic format `claude-comms/presence/{key}/{client}-{instanceId}`
- Tests check `_items` by user key (not composite)
- Tests verify connection sub-dict entries
- All 92 tests pass

## Test Results
```
92 passed in 17.20s
```
