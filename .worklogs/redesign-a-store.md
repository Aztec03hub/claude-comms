# Redesign Agent A: mqtt-store.svelte.js (Phase 1+2)

## Status: COMPLETE

## Changes Made

### Phase 1: New Data Model
- Changed `participants` from composite-keyed (`key-client`) to user-keyed with `connections` sub-object
- Each connection has `{ client, instanceId, since, lastSeen }`
- Added `CONNECTION_TYPES` constant: `['web', 'tui', 'mcp', 'cli', 'api']`
- Added `CONNECTION_TTL_MS` (120s) and `OFFLINE_DISPLAY_MS` (5 min) constants
- Added `#instanceId` field generated once per session (4 hex chars)
- Updated `onlineParticipants` derived: online = has any connection
- Updated `offlineParticipants` derived: empty connections
- Updated `onlineCount` to use `onlineParticipants.length`
- Rewrote `#handlePresence` to add/remove connections, validate against CONNECTION_TYPES
- Rewrote `#handleParticipantRegistry` for migration compat with new model
- Rewrote `#fetchParticipants` to merge connections without overwriting MQTT state
- Rewrote self-add in `connect()` to create user entry with web connection
- Removed ALL composite key logic (`key + '-' + clientType`)

### Phase 2: New Presence Topics
- Publish to `claude-comms/presence/{key}/web-{instanceId}` (retained, QoS 1)
- Subscribe to `claude-comms/presence/+/+` (new) AND old topics for migration
- LWT goes to per-instance presence topic
- Added heartbeat: `setInterval(60_000)` re-publishes presence to update lastSeen
- Added TTL cleanup: `setInterval(30_000)` removes stale connections (>120s)
  - Publishes empty retained to clean broker for stale connections
  - Removes offline users after 5 min
- Graceful disconnect: publishes offline + empty retained to clean up instance topic
- Added `#stopHeartbeat()` and `#stopTtlCleanup()` helpers, called in `disconnect()`

## Build Verification
- `npx vite build` passes successfully
