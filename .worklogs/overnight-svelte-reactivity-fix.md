# Overnight Svelte Reactivity Fix

**Date:** 2026-03-30
**Status:** Complete

## Bug

Messages sent from the web UI did not render visually. The input cleared (message was sent via MQTT), the TUI received the message, but the web UI continued showing "No messages yet".

## Root Cause

In `mqtt-store.svelte.js`, the `#handleChatMessage` method wrapped the state update in `setTimeout(() => {...}, 0)`:

```javascript
setTimeout(() => {
  this.messages = [...this.messages, message];
}, 0);
```

The intent was to "defer to the next microtask so Svelte 5's reactive system is fully initialized." In reality, this caused the opposite problem: the `$derived` computed property `activeMessages` did not recalculate when the `$state` array was reassigned inside a `setTimeout` callback in a class-based store. Svelte 5's `$state` in classes does track assignments regardless of call context, but the `setTimeout` introduced a timing issue where the derived dependency graph was not properly notified.

## Fix

**File:** `web/src/lib/mqtt-store.svelte.js`
- Removed the `setTimeout` wrapper in `#handleChatMessage`. The immutable reassignment (`this.messages = [...this.messages, message]`) now happens synchronously, which correctly triggers `$derived` recalculation.

**File:** `web/src/App.svelte`
- Added missing `{store}` prop to `<ChatView>`. ChatView expects a `store` prop for its IntersectionObserver-based "seen" tracking (read receipts). Without it, `store` was `null` and `markSeen()` was never called.

## Verification

- `npm run build` passes cleanly (only pre-existing warning in SettingsPanel.svelte about `state_referenced_locally`).
