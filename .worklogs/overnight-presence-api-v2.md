# Presence REST API - v2 Enhancement

**Date:** 2026-03-30
**Agent:** Claude Opus 4.6 (1M context)
**Scope:** Enrich `/api/participants/{channel}` response with `client` and `status` fields

## Summary

The REST API endpoint `/api/participants/{channel}` and its corresponding
`get_channel_participants()` function in `mcp_server.py` were already implemented
(from the v1 presence API work). The web UI's `mqtt-store.svelte.js` already had
`#fetchParticipants()`, `#startParticipantPolling()`, `#stopParticipantPolling()`,
and all three call sites (connect, channel switch, 30s interval).

The only missing piece was that the API response did not include `client` and
`status` fields, which the web UI's `#fetchParticipants()` merge logic expects.

## Changes

### `src/claude_comms/mcp_server.py`
- Updated `get_channel_participants()` to include `"client": "mcp"` and
  `"status": "online"` in each participant dict. Registry members are by
  definition online (they joined via the MCP server), and their client type
  is `mcp` since the registry is populated by MCP tool calls.

## Not Committed (from another agent)

The `mqtt-store.svelte.js` working tree had uncommitted changes converting
`$derived` fields to getters. Per task instructions ("Do NOT touch $derived
fields -- another agent is fixing those"), these were left unstaged.

## Verification

- Python tests: 714 passed (0 failures)
- Web build: successful (vite, 5.23s)
- Commit: `0f1f09b` pushed to `origin/main`

## Architecture Notes

The full presence pipeline:
1. MCP clients join via `comms_join` -> `ParticipantRegistry.join()`
2. `get_channel_participants()` reads from registry -> REST API response
3. Web UI polls `/api/participants/{channel}` every 30s + on connect/switch
4. `#fetchParticipants()` merges server-side participants into local `participants` state
5. MQTT presence messages provide real-time updates between polls
