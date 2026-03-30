# Message Sending, Display, and Input Behavior Tests

**Date:** 2026-03-29
**Test file:** `/home/plafayette/claude-comms/web/e2e/messages.spec.js`
**Screenshots:** `/home/plafayette/claude-comms/mockups/test-messages-*.png` (10 files)

## Test Results Summary

| # | Test | Result | Notes |
|---|------|--------|-------|
| 1 | Type in message input | PASS | Text appears in field correctly |
| 2 | Press Enter to send | PASS (flaky) | Input clears, bubble appears. Page load timing causes flakiness |
| 3 | Click send button | PASS | Same behavior as Enter |
| 4 | Multiple messages grouping | PASS | Consecutive messages have `consecutive` class, avatar-spacer replaces avatar |
| 5 | Long message wrapping | PASS | `word-wrap: break-word` confirmed, bubble width < 85% of chat area |
| 6 | @mention rendering | PASS | `.mention` span with amber background highlight |
| 7 | Empty input + Enter | PASS | No empty bubbles sent (empty or whitespace-only) |
| 8 | Human message alignment | PASS | `align-self: flex-end` and `flex-direction: row-reverse` |
| 9 | Timestamp format | PASS | Matches "Today at H:MM AM/PM" regex pattern |
| 10 | Auto-scroll | PASS | `scrollHeight - scrollTop - clientHeight < 60` after sending 8 messages |

## Flakiness Note

The Vite dev server in WSL2 has intermittent slow page loads (10-40s) that cause `waitForSelector` timeouts. This is an infrastructure issue, not a code bug. Tests pass reliably on retry (with `--retries=2`). The existing `chat.spec.js` tests show the same pattern.

## Bugs Found

**None.** All 10 functional areas tested work correctly:

- `sendMessage()` in `mqtt-store.svelte.js` correctly validates non-empty input via `if (!body.trim()) return`
- Local echo (`#handleChatMessage`) adds messages immediately without requiring MQTT broker
- `MessageGroup.svelte` correctly marks `consecutive={i > 0}` within same-sender groups
- `MessageBubble.svelte` CSS applies proper right-alignment for human messages
- `formatTime()` in `utils.js` produces correct "Today at H:MM AM/PM" format
- `parseMentions()` correctly tokenizes `@word` patterns into styled `.mention` spans
- `ChatView.svelte` auto-scroll via `$effect` works correctly

## Key Files Reviewed

- `/home/plafayette/claude-comms/web/src/components/MessageInput.svelte` - input handling, send logic
- `/home/plafayette/claude-comms/web/src/components/MessageBubble.svelte` - bubble rendering, alignment CSS
- `/home/plafayette/claude-comms/web/src/components/MessageGroup.svelte` - consecutive grouping
- `/home/plafayette/claude-comms/web/src/components/ChatView.svelte` - scroll management, message display
- `/home/plafayette/claude-comms/web/src/lib/mqtt-store.svelte.js` - message store, sendMessage, activeMessages
- `/home/plafayette/claude-comms/web/src/lib/utils.js` - formatTime, parseMentions
