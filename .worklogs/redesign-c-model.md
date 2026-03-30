# Phase 4 (Partial): Python Data Model — ConnectionInfo + Participant Updates

**Date:** 2026-03-30
**Agent:** redesign-c-model
**Commit:** 1ef10ce

## What Was Done

### participant.py
- Added `CONNECTION_TYPES` tuple: `("web", "tui", "mcp", "cli", "api")`
- Added `ConnectionInfo(BaseModel)` with fields: `client`, `instance_id`, `since`, `last_seen`
- Added `connections: dict[str, ConnectionInfo]` field to `Participant` (default empty dict)
- Changed `client` field from `str` (default `"unknown"`) to `str | None` (default `None`) for backward compat during migration
- Added `is_online` property: `True` when `connections` is non-empty
- Added `active_client_types` property: unique list of client types across all connections

### mcp_tools.py
- Updated `tool_comms_members` response to include:
  - `connections` dict (serialized via `model_dump()`)
  - `online` boolean from `is_online`
  - Backward-compat `client` and `status` fields at top level

### mcp_server.py (adjacent fix)
- Updated `get_channel_participants` to match new model shape (connections, online, backward-compat client/status)

### Tests Updated
- `test_participant.py`: Updated JSON keys assertion to include `connections`
- `test_api_endpoints.py`: Updated shape/value assertions for new fields
- `test_mcp_server_extended.py`: Updated shape/value assertions for new fields

## Test Results
All 818 tests passing.
