# Cross-Browser Integration Test: MCP <-> Web UI

**Date:** 2026-03-30
**Agent:** Claude Opus 4.6 (1M context)
**Duration:** ~90 minutes

## Objective

Test bidirectional messaging between the Python MCP server and the Svelte web client, both connected to the same amqtt MQTT broker.

## Test Steps Performed

### Step 1: Send messages via MCP tools

Joined `general` as "test-crossbrowser" and sent 3 messages:
1. Short greeting: `CROSSTEST-LIVE: Hello from MCP!...`
2. @mention: `Hey @phil-human, the integration pipeline is looking great!...`
3. Code block with `verify_cross_platform` function

All 3 messages sent successfully and confirmed in the MCP message store.

### Step 2: Screenshot web UI for MCP-sent messages

Launched Playwright against both dev server (port 5173) and production build (port 4173). Waited for MQTT connection and messages.

### Step 3: Send message from web UI

Used Playwright to type and send `CROSSTEST-WEBMSG: Hello from browser at <timestamp>`. Verified via `comms_read` that the MCP server received it.

### Step 4: Verify WebUI -> MCP via comms_read

Confirmed the web-sent message appeared in the MCP message store with correct sender, timestamp, and body.

## Results

### MCP -> WebUI: PARTIAL (messages delivered but not rendered)
- MQTT transport: **WORKS** -- Messages are published to `claude-comms/conv/general/messages` and the web client's MQTT subscription receives them
- Message handling: **WORKS** -- `#handleChatMessage` is called, messages are added to `this.messages` array, `activeMessages` derived correctly shows the count
- DOM rendering: **FAILS** -- Despite messages being in the reactive state, Svelte 5 does not re-render the ChatView component

### WebUI -> MCP: **PASS**
- Messages typed and sent from the web UI are published to MQTT and received by the MCP server
- Confirmed via `comms_read`: web-sent messages appear in the MCP store with correct sender key, name, timestamp, and body
- Multiple web-sent messages confirmed: `CROSSTEST-WEBMSG`, `LOCAL-ECHO-TEST`, `PW-TYPE-TEST`, `test from webui`

### Sender names: **PASS** (verified in MCP store data)
- MCP messages show sender "test-crossbrowser" with type "claude"
- Web messages show sender "Phil" with type "human"

### Timestamps: **PASS** (verified in MCP store data)
- ISO 8601 timestamps present on all messages

### @mentions highlighting: **COULD NOT VERIFY** (rendering issue blocks visual check)
- The `@phil-human` mention text IS in the message body
- The `parseMentions` utility and `.mention` CSS class exist and are wired in MessageBubble.svelte

## Bugs Found & Fixed

### Bug 1: `#fetchHistory` private method parse error (FIXED)

**File:** `web/src/lib/mqtt-store.svelte.js`

The `async #fetchHistory(channel)` private method was declared after its first usage at line 196. The Svelte 5 Vite plugin uses an acorn parser version that doesn't support forward references to private methods in class bodies, causing:

```
Private field '#fetchHistory' must be declared in an enclosing class (196:11)
```

This caused the ENTIRE mqtt-store module to fail compilation. Vite served a stale cached version initially (which is why the first test worked), but after any HMR trigger, the store broke completely.

**Fix:** Moved `#fetchHistory` method declaration above all its call sites (before `connect()`).

### Bug 2: Array `.push()` doesn't trigger `$derived` in Svelte 5 class instances (FIXED)

**File:** `web/src/lib/mqtt-store.svelte.js`

`this.messages.push(message)` in `#handleChatMessage` did not trigger `$derived` recalculation for `activeMessages`. The `$state($.proxy([]))` proxy tracked mutations but the `$derived` didn't re-evaluate.

**Fix:** Changed all `this.messages.push(item)` to `this.messages = [...this.messages, item]` (immutable reassignment). Also changed `this.channels.push(...)`, `this.pinnedMessages.push(...)`, and `.splice()` calls to use immutable patterns (spread/filter).

### Bug 3: Stale retained presence messages flooding broker (IDENTIFIED)

The amqtt broker accumulated dozens of retained presence messages from old sessions. When a new client subscribed, the broker flooded it with ~60+ retained presence messages before delivering any live chat messages. Combined with potential amqtt wildcard matching issues, this caused significant delays in chat message delivery.

**Fix:** Cleaned all retained messages from the broker using empty-payload retained publishes.

### Bug 4: Svelte 5 reactivity gap in MQTT callback context (OPEN)

Even after the spread fix, messages added from the MQTT `on('message')` callback don't always trigger Svelte 5 DOM re-renders. The reactive system may not be fully "listening" when mutations occur inside async MQTT callbacks. The other overnight session partially addressed this with a `setTimeout(0)` deferral in `#fetchHistory`, but the same issue affects `#handleChatMessage`.

**Status:** This is the remaining blocker for MCP->WebUI message display. The MQTT transport and message handling are working correctly.

## Screenshots

- `mockups/crosstest-01-mcp-messages.png` -- Web UI showing connected state (messages not rendering due to Bug 4)
- `mockups/crosstest-02-chat-area.png` -- Chat area view
- `mockups/crosstest-03-after-web-send.png` -- After web UI send attempt
- `mockups/crosstest-diag.png` -- Various diagnostic screenshots

## Files Modified

- `web/src/lib/mqtt-store.svelte.js` -- Moved `#fetchHistory`, replaced `.push()` with spread assignments, replaced `.splice()` with `.filter()`

## Recommendations

1. **Apply setTimeout(0) deferral to `#handleChatMessage`** -- Same pattern as the `#fetchHistory` fix. This would defer the `this.messages = [...]` assignment to the next microtask, giving Svelte 5's reactive system time to process the update.

2. **Clean up retained presence on broker startup** -- Add a broker cleanup step that removes stale retained presence messages older than a configurable threshold.

3. **Consider upgrading Svelte** -- The `$derived` + `$state` reactivity in class instances may have known issues in Svelte 5.55.1 that are fixed in later versions.

4. **Add integration tests** -- The cross-test scripts (`crosstest.mjs`, `crosstest-final.mjs`) provide a foundation for automated MCP<->WebUI testing once the rendering issue is resolved.
