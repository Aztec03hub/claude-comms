# Broker Resilience Work Log

**Date:** 2026-03-30
**Issue:** amqtt MQTT broker crashes when WebSocket clients disconnect abruptly, throwing `struct.error('unpack requires a buffer of 1 bytes')` and `ConnectionClosedOK` exceptions that propagate up and kill the daemon.

## Changes

### 1. `src/claude_comms/broker.py` - EmbeddedBroker.start()

Added a custom asyncio exception handler installed on the event loop during broker startup. This handler intercepts and suppresses two known benign amqtt exceptions:

- `struct.error` with "unpack requires" in the message (malformed WS frame on disconnect)
- `websockets.exceptions.ConnectionClosedOK` (clean WS close that amqtt fails to handle)

Both are logged as warnings instead of crashing the process. All other exceptions fall through to the default handler.

### 2. `src/claude_comms/cli.py` - start command (_run_daemon)

Wrapped the broker lifecycle in `_run_broker_with_retry()`:

- Runs broker in a retry loop (max 10 attempts)
- If broker.start() or the running broker raises an exception, logs the error, waits 2 seconds, and restarts
- Shutdown event integration: the retry loop exits cleanly on daemon shutdown
- Broker is now launched as an asyncio task so MCP/web servers can start independently
- Broker task is included in graceful shutdown cleanup

## Testing

- All 647 tests pass (excluding test_tui.py which has a pre-existing missing `textual` dep)
- Imports verified clean
