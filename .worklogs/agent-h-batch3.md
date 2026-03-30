# Agent-H Work Log — Batch 3: TUI Client

**Date:** 2026-03-29
**Agent:** Agent-H
**Package:** TUI Client (Textual)

## Files Created

| File | Description |
|------|-------------|
| `src/claude_comms/tui/__init__.py` | Package init with `run()` entry point for `claude-comms tui` |
| `src/claude_comms/tui/app.py` | Main Textual app — 3-column layout, MQTT worker, keybindings |
| `src/claude_comms/tui/chat_view.py` | Scrollable message display with Rich Panels, code highlighting |
| `src/claude_comms/tui/channel_list.py` | Left sidebar — conversation list with unread amber badges |
| `src/claude_comms/tui/participant_list.py` | Right sidebar — participant list with green/amber/gray presence dots |
| `src/claude_comms/tui/message_input.py` | Input widget with @mention Tab completion cycling |
| `src/claude_comms/tui/styles.tcss` | Textual CSS theme — Carbon Ember palette |

## Architecture Decisions

1. **Direct MQTT via aiomqtt** — TUI connects to broker directly (not through MCP), using `@work(thread=False)` async worker for the receive loop. This avoids MCP overhead and gives real-time push delivery.

2. **Client-side dedup** — ChatView maintains a `_seen_ids` set as defense-in-depth against duplicate messages (server-side dedup is primary).

3. **Per-conversation message storage** — ChatView stores messages per conversation in `_messages` dict, enabling instant channel switching without re-fetching from broker.

4. **Deterministic sender colors** — MD5 hash of sender key maps to Carbon Ember palette index, so each participant gets a consistent color across sessions.

5. **Code block rendering** — Messages with triple-backtick fenced code blocks are parsed and rendered with Rich Syntax highlighting (monokai theme).

6. **Modal new-conversation screen** — Ctrl+N opens a ModalScreen for entering a new conversation name, with validation via `validate_conv_id`.

7. **Presence via MQTT retained messages** — Presence published with `retain=True` so new joiners see current state. Topic pattern: `claude-comms/conv/{conv}/presence/{key}`.

## MQTT Topics Subscribed

- `claude-comms/conv/+/messages` (QoS 1) — all conversation messages
- `claude-comms/conv/{conv_id}/presence/+` (QoS 0) — presence for active conversation
- `claude-comms/conv/{conv_id}/typing/+` (QoS 0) — typing indicators (future)

## Keybindings

| Binding | Action |
|---------|--------|
| Ctrl+Q | Quit |
| Ctrl+N | New conversation (modal dialog) |
| Ctrl+K | Cycle to next conversation |
| Tab | @mention autocomplete in input |
| Enter | Send message |

## Dependencies Used

- `claude_comms.message.Message` — wire-format model, `from_mqtt_payload`, `to_mqtt_payload`, `create`
- `claude_comms.mention.resolve_mentions` — @mention name-to-key resolution for recipient routing
- `claude_comms.participant.Participant` — participant identity model
- `claude_comms.config.load_config` — YAML config loading with defaults
- `claude_comms.broker.generate_client_id` — unique MQTT client ID generation

## Status

All 7 files created and complete. Ready for integration testing with a running broker.
