# Agent-E Batch 2 Work Log: MCP Server + Tools

**Date:** 2026-03-29
**Status:** COMPLETE

## Files Created

1. **`src/claude_comms/mcp_tools.py`** -- Tool logic and ParticipantRegistry
2. **`src/claude_comms/mcp_server.py`** -- FastMCP HTTP server with MQTT subscriber
3. **`tests/test_mcp_tools.py`** -- 42 tests covering all tool functions
4. **`tests/conftest.py`** -- Shared fixtures (registry, store, publish_spy, tmp_config)

## Architecture Decisions

### MCP Server (`mcp_server.py`)
- Uses `FastMCP` with `stateless_http=True` and `json_response=True`
- Binds to `127.0.0.1` only (from `mcp.host` config), port from `mcp.port` (default 9920)
- On startup: replays JSONL logs into MessageStore, seeds MessageDeduplicator
- Background task subscribes to `claude-comms/conv/+/messages` via aiomqtt
- Separate publish client for sending messages (persistent connection)
- Auto-reconnect on subscriber disconnect (2s backoff)
- No `print()` calls anywhere -- logging only

### Tool Layer (`mcp_tools.py`)
- Pure functions that take registry/store/publish_fn as explicit dependencies
- `ParticipantRegistry`: thread-safe in-memory participant tracking with:
  - Per-conversation membership tracking
  - Name-to-key index for O(1) name resolution
  - Read cursors for unread tracking
  - Mixed name/key recipient resolution
- All tools validate key registration and return structured `{"error": True, "message": "..."}` on failure
- `comms_send` is the only async tool (needs publish_fn)
- Token-aware pagination: estimates ~4 chars/token, caps output at 80,000 chars (~20k tokens) to stay under MCP 25k limit

### MCP Tools Implemented (9 total)
| Tool | Sync/Async | Description |
|------|-----------|-------------|
| `comms_join` | sync | Join conv, return key. Name-based idempotency. |
| `comms_leave` | sync | Leave conversation |
| `comms_send` | async | Send message, resolve names to keys, prepend @mention prefix |
| `comms_read` | sync | Read messages with count/since pagination + token truncation |
| `comms_check` | sync | Unread counts across conversations |
| `comms_members` | sync | List conversation participants |
| `comms_conversations` | sync | List joined conversations with unread counts |
| `comms_update_name` | sync | Change display name (key preserved) |
| `comms_history` | sync | Search messages by text/sender with token truncation |

### Test Coverage
- 42 tests, all passing
- Covers: join (8), leave (3), send (6), read (6), check (3), members (2), conversations (2), update_name (3), history (4), registry (4), token pagination (1)
- Uses PublishSpy for asserting MQTT publishes without a real broker
- Uses FailingPublish for broker error handling tests
- Existing 251 tests still pass (293 total)

## Dependencies Used
- `claude_comms.broker`: MessageDeduplicator, MessageStore, replay_jsonl_logs, generate_client_id
- `claude_comms.message`: Message model, validate_conv_id, now_iso
- `claude_comms.participant`: Participant model, validate_key, validate_name
- `claude_comms.mention`: build_mention_prefix
- `claude_comms.config`: load_config
- `mcp` SDK: FastMCP
- `pydantic`: Field, Annotated for tool parameter schemas
- `aiomqtt`: MQTT subscriber/publisher (runtime only, not in tests)
