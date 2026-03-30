# Participant System Redesign -- Complete Summary

**Date:** 2026-03-30
**Plan:** `/mnt/c/Users/plafayette/Documents/New_Laptop/Artifacts/plans/2026-03-30-participant-system-redesign.md`

## What Changed

The participant system was redesigned from a composite-key model (`key-web`, `key-tui`, `key-unknown`) to a connection-based model where each user has a single entry with a `connections` sub-object tracking their active sessions.

### Key Changes by Phase

**Phase 1 -- Data Model (mqtt-store.svelte.js)**
- `participants` dict keyed by user key (not composite key)
- Each entry has `connections: { "web-3f2a": {...}, "tui-0001": {...} }`
- Online/offline derived from whether `connections` is empty
- Removed all composite key logic, skip/filter hacks

**Phase 2 -- Presence Topics**
- New topic: `claude-comms/presence/{key}/{client}-{instanceId}`
- Per-instance LWT prevents multi-tab conflicts
- Heartbeat (60s) and TTL cleanup (120s stale, 5min offline removal)
- Graceful disconnect publishes empty retained to clean broker

**Phase 3 -- MemberList.svelte**
- Single row per user with Lucide connection icons (Globe, Monitor, Plug, Terminal, Link)
- CSS fade transitions for icon appear/disappear
- Removed duplicate entries and client badge spans

**Phase 4 -- Server (participant.py, mcp_server.py, mcp_tools.py, cli.py)**
- `Participant` model has `connections: dict[str, ConnectionInfo]`
- REST API v2 format with backward-compat `client`/`status` top-level fields
- MCP subscriber tracks per-user connections

**Phase 5 -- TUI (app.py, participant_list.py)**
- New presence topic with instanceId
- Connection-aware participant tracking
- Connection type indicators `[W]` `[T]` `[M]` next to names

**Phase 6 -- Cleanup and Tests**
- All 818 tests passing
- Vite build succeeds
- Ruff lint clean
- Ruff format applied to test files
- Note: 6 src/ files have formatting drift (cli.py, mcp_server.py, mcp_tools.py, participant.py, tui/app.py, tui/participant_list.py) -- deferred since src/ was exclusive to earlier phases

## Results

- ONE entry per user in member list (no duplicates)
- Connection icons show/hide reactively
- No "unknown" badges
- DMs target users by key, visible on all devices
- Adding a new client type requires only: add to CONNECTION_TYPES + add icon mapping
