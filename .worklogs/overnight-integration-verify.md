# Integration Verification: Web UI + TUI + MCP Coexistence

**Date:** 2026-03-30
**Status:** COMPLETE -- fixes applied

## Scope

Conceptual integration test verifying that the Web UI (`mqtt-store.svelte.js`), TUI (`tui/app.py`), and MCP server (`mcp_server.py`) can coexist on the same MQTT broker and see each other's messages, presence, and typing indicators.

## Topic Pattern Verification

### Messages -- PASS (all match)

| Client | Publish Topic | Subscribe Pattern |
|--------|--------------|-------------------|
| Web    | `claude-comms/conv/{ch}/messages` | `claude-comms/conv/+/messages` |
| TUI    | `claude-comms/conv/{ch}/messages` (via `Message.topic`) | `claude-comms/conv/+/messages` |
| MCP    | `claude-comms/conv/{ch}/messages` (via `Message.topic`) | `claude-comms/conv/+/messages` |

All three use the same topic pattern. Cross-client message delivery works.

### Presence -- FIXED (was partial mismatch)

| Client | Conv Presence | System Presence | QoS |
|--------|--------------|-----------------|-----|
| Web    | `conv/{ch}/presence/{key}` | `system/participants/{key}` (LWT) | 1 |
| TUI    | `conv/{ch}/presence/{key}` | **was missing** -- now publishes to `system/participants/{key}` | **was 0** -- now 1 |
| MCP    | `conv/{ch}/presence/{key}` | **was missing** -- now publishes to `system/participants/{key}` | 1 |

**Issue found:** Web subscribes to `system/participants/+` for its global participant registry. TUI and MCP were not publishing to that topic, so they were invisible in the Web's member sidebar unless they happened to be in the same channel.

**Fix:** Both TUI and MCP now publish to both `conv/{ch}/presence/{key}` AND `system/participants/{key}`.

### Presence `ts` field -- FIXED

| Client | Included `ts`? |
|--------|---------------|
| Web    | Yes |
| TUI    | **was missing** -- now included |
| MCP    | **was missing** -- now included |

Web handles missing `ts` gracefully (`msg.ts || new Date().toISOString()`) but consistency is better.

### Typing -- KNOWN GAP (not fixed, out of scope)

| Client | Publishes typing? | Subscribes typing? |
|--------|------------------|-------------------|
| Web    | Yes (`conv/{ch}/typing/{key}`) | Yes (`conv/+/typing/+`) |
| TUI    | **No** | Yes (conv-scoped) |
| MCP    | No | No |

TUI users typing won't be visible to Web users. This is a feature gap, not a bug -- implementing typing in the TUI requires keypress event handling in the Textual input widget. Not in scope for this fix.

### Subscription Scope

- **Web** subscribes to `conv/+/...` (all channels at once)
- **TUI** subscribes to messages globally (`conv/+/messages`) but presence/typing per-channel only
- This means TUI won't see presence from other channels, but this is by design -- it only displays the active channel's participants

## Message JSON Schema Verification -- PASS

All three clients produce identical wire format:

```json
{
  "id": "uuid4",
  "ts": "ISO 8601",
  "sender": {
    "key": "8 hex chars",
    "name": "display name",
    "type": "human|claude"
  },
  "recipients": null | ["key1", "key2"],
  "body": "message text",
  "reply_to": null | "parent uuid",
  "conv": "channel-id"
}
```

- Web constructs this manually in `sendMessage()`
- TUI and MCP both use `Message.create()` + `to_mqtt_payload()` (Pydantic model)
- Fields are identical, serialization is compatible

## Presence Schema Verification -- PASS (after fix)

All three now publish:

```json
{
  "key": "8 hex",
  "name": "display name",
  "type": "human|claude",
  "status": "online|offline",
  "ts": "ISO 8601"
}
```

## Files Changed

- `src/claude_comms/tui/app.py` -- `_publish_presence()`: added `ts` field, upgraded QoS 0 -> 1, added `system/participants/{key}` publish
- `src/claude_comms/mcp_server.py` -- `comms_join()` presence block: added `ts` field, added `system/participants/{key}` publish

## Remaining Gaps (not blocking)

1. **TUI doesn't publish typing indicators** -- Web users won't see TUI users typing. Feature gap.
2. **MCP doesn't publish typing** -- Expected; MCP tools are request/response, not real-time input.
3. **TUI presence subscription is channel-scoped** -- By design; TUI only shows active channel participants.
4. **No LWT (Last Will and Testament) in TUI** -- If the TUI crashes, its retained presence stays "online". Web uses LWT to auto-publish "offline". Would require aiomqtt `will` parameter.
