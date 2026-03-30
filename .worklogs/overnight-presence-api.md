# Presence API Endpoint — Work Log

**Date:** 2026-03-30
**Task:** Fix presence visibility bug — web UI and TUI don't show participants from other transports

## Problem

The web UI connects to the MQTT broker via WebSocket (:9001), while the TUI and MCP clients connect via TCP (:1883). Presence messages published on one transport are not reliably forwarded to subscribers on the other transport by amqtt. This means:

- Web UI only sees "Phil (web)" — misses TUI and MCP participants
- TUI sees itself but not MCP-connected participants

## Root Cause

amqtt's bridge between TCP and WebSocket listeners does not reliably forward retained presence messages across transports. Messages on `claude-comms/system/participants/+` published via TCP never arrive at WebSocket subscribers, and vice versa.

## Solution

Added a REST API endpoint that returns the server-side participant registry, bypassing MQTT transport entirely. The web UI polls this endpoint to discover participants that MQTT presence didn't deliver.

### Changes

1. **`src/claude_comms/mcp_server.py`** — Added `get_channel_participants()` function that queries the `ParticipantRegistry` for members of a given channel.

2. **`src/claude_comms/cli.py`** — Added `GET /api/participants/{channel}` REST endpoint (with CORS headers and OPTIONS preflight) that returns the participant list as JSON.

3. **`web/src/lib/mqtt-store.svelte.js`** — Added:
   - `#fetchParticipants(channel)` — fetches participant list from REST API and merges into the reactive participants map
   - `#startParticipantPolling()` / `#stopParticipantPolling()` — 30-second polling lifecycle
   - Wired polling to `connect()`, `disconnect()`, and `switchChannel()`

### API Response Format

```
GET /api/participants/general
{
  "channel": "general",
  "participants": [
    {"key": "abcd1234", "name": "Phil", "type": "human"},
    {"key": "ef567890", "name": "test-crossbrowser", "type": "claude"}
  ]
}
```

## Verification

- All 714 Python tests pass
- Web UI builds successfully (vite build)
- Python files compile cleanly
