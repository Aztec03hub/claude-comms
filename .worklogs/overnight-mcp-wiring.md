# Overnight: Wire MCP Server + Web UI into Daemon Start

**Date:** 2026-03-29
**Files modified:** `src/claude_comms/cli.py`

---

## Problem

The `claude-comms start` command printed "MCP server ready" and "Web UI available" but never actually started either server. Both were placeholder print statements (audit items #1 and #2 from placeholder-audit.md).

## Changes

### Task 1: MCP Server Wiring (`cli.py` ~line 215)

Replaced the placeholder comment with actual MCP server startup:

- Calls `create_server(config)` from `mcp_server.py` to build the FastMCP instance with all tools registered
- Extracts the Starlette ASGI app via `mcp.streamable_http_app()`
- Runs it on `mcp_host:mcp_port` using `uvicorn.Server` as an asyncio task
- Starts the MQTT subscriber background task to feed live messages into the MCP message store
- Creates a persistent MQTT publish client so MCP tools (`comms_send`) can actually publish messages to the broker
- Wires the publish function into the `mcp_server` module's `_publish_fn` global

### Task 2: Web UI Static File Server (`cli.py` ~line 265)

Replaced the placeholder with a real static file server:

- Uses Starlette `StaticFiles` (already a transitive dependency via mcp/uvicorn) to serve `web/dist/`
- Mounts `/assets/` and `/` routes with `html=True` for SPA support
- Runs on `127.0.0.1:{web_port}` via uvicorn as an asyncio task
- Gracefully handles missing `web/dist/` directory with a warning

### Graceful Shutdown

Added proper cleanup in the shutdown path:
- Sets `should_exit = True` on both uvicorn servers
- Cancels the MQTT subscriber task
- Closes the MQTT publish client
- Awaits all tasks to completion

## Verification

1. `claude-comms stop` -- killed existing daemon
2. `claude-comms start --web --background` -- started successfully
3. MQTT broker on :1883 -- aiomqtt client connected successfully
4. MCP server on :9920 -- JSON-RPC `initialize` returned valid response with protocol version and tool capabilities
5. Web UI on :9921 -- HTTP 200, serves the Svelte app
6. `claude-comms stop` -- clean shutdown
7. All 547 tests pass, no regressions
