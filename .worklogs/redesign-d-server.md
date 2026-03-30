# Phase 4: Server-Side Changes — Participant System Redesign

**Agent:** D (server)
**Status:** COMPLETE
**Files Modified:** `mcp_server.py`, `cli.py`

## Changes Made

### mcp_server.py

1. **Imported** `CONNECTION_TYPES` and `ConnectionInfo` from `participant.py`

2. **`_mqtt_subscriber`** — Added dual-subscription for new presence topic:
   - Subscribes to `claude-comms/presence/+/+` (new) in addition to old topics
   - Parses new topic format: `['claude-comms', 'presence', '{key}', '{client}-{instanceId}']`
   - Validates `client` against `CONNECTION_TYPES` — rejects unknown types
   - On `status: "online"`: creates/updates participant, adds `ConnectionInfo` to `participant.connections[connKey]`
   - On `status: "offline"`: removes that specific connection from participant
   - Preserves `since` timestamp on reconnect (doesn't overwrite existing connection's `since`)
   - Old presence handler also updated to track connections when client type is valid
   - Skips empty payloads (retained message cleanup)

3. **`get_channel_participants`** — Already returns connections dict (was updated in Phase C model changes). No changes needed beyond what was already there.

### cli.py

4. **`_api_participants`** — Added `version: 2` to the REST API response:
   - Response format: `{ version: 2, channel: "...", participants: [...] }`
   - Each participant includes: `key`, `name`, `type`, `connections`, `online`, `client` (backward compat), `status` (backward compat)

## Test Results

All 818 tests pass with no failures.
