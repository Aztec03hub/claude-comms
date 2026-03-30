# Emoji Picker & Reaction System - Test Report

**Date:** 2026-03-29
**Result:** 10/10 tests passing

## Bugs Found & Fixed

### Bug 1: React button in message action bar had no onclick handler
- **File:** `web/src/components/MessageActions.svelte`
- **Issue:** The "React" button (`[data-testid="action-react"]`) had no `onclick` handler, so clicking it did nothing.
- **Fix:** Added `onReact` prop and wired it to the button's `onclick`.

### Bug 2: Emoji selection did not add reactions to messages
- **File:** `web/src/App.svelte`
- **Issue:** `handleEmojiSelect` closed the picker but never called any store method to add the reaction to the target message. The comment said "could add reaction" -- it was a TODO.
- **Fix:** Added `handleReact(message)` function and updated `handleEmojiSelect` to call `store.addReaction(emojiPickerTarget.id, emojiData.emoji)`.

### Bug 3: Store had no addReaction method
- **File:** `web/src/lib/mqtt-store.svelte.js`
- **Issue:** No method existed to add/toggle reactions on messages.
- **Fix:** Added `addReaction(messageId, emoji)` method that creates/toggles reactions on messages with proper count tracking and active state.

### Prop threading for onReact callback
- **Files:** `MessageBubble.svelte`, `MessageGroup.svelte`, `ChatView.svelte`, `App.svelte`
- **Issue:** The `onReact` callback needed to be threaded from App through ChatView -> MessageGroup -> MessageBubble -> MessageActions.
- **Fix:** Added `onReact` prop to all intermediate components and wired it through.

## Test Infrastructure Note

The MQTT client (mqtt.js) blocks the browser event loop during connection/reconnection cycles, causing Playwright's standard `page.click()`, `page.fill()`, and `page.evaluate()` to hang indefinitely. The test suite uses two workarounds:
1. **WebSocket mock via `addInitScript`** -- prevents MQTT from actually connecting
2. **CDP `Runtime.evaluate`** -- bypasses Playwright's actionability wait system

The Playwright config was also updated to use port 5175 and add `navigationTimeout: 10000`.

## Files Modified
- `web/src/components/MessageActions.svelte` -- added onReact prop + onclick
- `web/src/components/MessageBubble.svelte` -- added onReact prop passthrough
- `web/src/components/MessageGroup.svelte` -- added onReact prop passthrough
- `web/src/components/ChatView.svelte` -- added onReact prop passthrough
- `web/src/App.svelte` -- added handleReact, updated handleEmojiSelect
- `web/src/lib/mqtt-store.svelte.js` -- added addReaction method
- `web/playwright.config.js` -- port 5175, navigationTimeout
- `web/e2e/emoji-picker.spec.js` -- new test file (10 tests)

## Screenshots
All saved to `mockups/test-emoji-01-messages.png` through `test-emoji-10-category-tabs.png`.
