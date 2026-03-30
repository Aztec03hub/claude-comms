# MQTT Broadcast for Reactions, Pins, and Deletions

**Date:** 2026-03-29
**File:** `web/src/lib/mqtt-store.svelte.js`
**Audit items:** #18 (deletions), #21 (reactions), #22 (pins) from placeholder-audit.md

---

## Problem

`addReaction()`, `togglePin()`, and `deleteMessage()` only modified local state. Other connected clients never saw these changes because no MQTT messages were published.

## Changes

### 1. MQTT Publishing (outbound)

- **addReaction** -- after toggling locally, publishes to `claude-comms/conv/{channel}/reactions` with `{message_id, emoji, action: "add"|"remove", sender}`.
- **togglePin** -- after toggling locally, publishes to `claude-comms/conv/{channel}/pins` with `{message_id, action: "pin"|"unpin", sender}`.
- **deleteMessage** -- after removing locally, publishes to `claude-comms/conv/{channel}/deletions` with `{message_id, sender}`.

### 2. MQTT Subscriptions (inbound)

Added three new subscriptions in `#subscribeAll()`:
- `claude-comms/conv/+/reactions` (qos 1)
- `claude-comms/conv/+/pins` (qos 1)
- `claude-comms/conv/+/deletions` (qos 1)

### 3. Message Handlers (inbound from other clients)

- **#handleRemoteReaction** -- increments/decrements reaction counts on matching messages; ignores own broadcasts.
- **#handleRemotePin** -- adds/removes from `pinnedMessages` array; looks up the full message object for pin.
- **#handleRemoteDeletion** -- filters message out of `messages` array and also removes from `pinnedMessages` if present; ignores own broadcasts.

All three handlers skip messages from `this.userProfile.key` to avoid double-applying local changes.

### 4. Routing

`#handleMessage` now routes `reactions`, `pins`, and `deletions` topic segments to the new handlers.

## Build

`npm run build` passes with no new warnings.
