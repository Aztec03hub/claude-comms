# Overnight: Message History REST API + Web UI Persistence

**Date:** 2026-03-30
**Status:** Complete

## Issues Addressed

### Issue 1: Web UI doesn't show messages sent via MCP/TCP
- **Diagnosis:** The amqtt broker configures both TCP (1883) and WebSocket (9001) listeners. Messages published via TCP SHOULD be bridged to WebSocket clients since both are listeners on the same broker instance.
- **Action:** Added `console.debug` logging in `#handleMessage` in `mqtt-store.svelte.js` to trace all incoming MQTT messages. This will confirm whether the broker is properly bridging between TCP and WS listeners.
- **Next steps for verification:** Start daemon, open web UI, publish via `mosquitto_pub` or `claude-comms send`, check browser console for `[claude-comms] MQTT` debug lines. If no messages appear, the issue is in amqtt's internal bridging and may require switching to a different broker or adding an explicit relay.

### Issue 2: No message persistence on web UI refresh
- **Root cause:** `messages = $state([])` starts empty on every page load. The MCP server has a `MessageStore` with JSONL-replayed history, but the web UI had no way to access it.
- **Fix:** Added a REST API endpoint and client-side fetch.

## Changes Made

### `src/claude_comms/mcp_server.py`
- Added `get_channel_messages(channel, count)` public function that reads from the shared `_store` singleton. Returns empty list if store not yet initialized.

### `src/claude_comms/cli.py`
- Added REST API routes on the MCP Starlette app (port 9920):
  - `GET /api/messages/{channel}?count=50` — returns JSON `{channel, count, messages}`
  - `OPTIONS /api/messages/{channel}` — CORS preflight
- Routes inserted at position 0 so they take priority over MCP catch-all routes.
- CORS headers (`Access-Control-Allow-Origin: *`) included for cross-origin web UI requests.

### `web/src/lib/mqtt-store.svelte.js`
- Added `MCP_API_URL` constant (`http://localhost:9920`)
- Added `#fetchHistory(channel)` private async method:
  - Fetches from REST API
  - Deduplicates against `#seenIds` set (so live MQTT messages don't duplicate)
  - Sorts messages chronologically after merge
  - Logs count to console
- Called on MQTT connect (for active channel)
- Called on channel switch (for new channel)
- Added `console.debug` in `#handleMessage` for Issue 1 broker bridging diagnosis

## Verification
- Web build: passes (vite build successful)
- Python import: `get_channel_messages` imports correctly
- Tests: 714 passed, 0 failed
