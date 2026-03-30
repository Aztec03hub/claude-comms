# Svelte 5 Reactivity Fix v2 -- Messages Not Rendering

**Date:** 2026-03-30
**Agent:** Claude Opus 4.6 (1M context)
**Duration:** ~60 minutes

## Problem

Messages were not rendering in the web UI despite being correctly stored in the MQTT store's `$state` arrays. The `$derived` fields computed correctly (debug logs confirmed `activeMessages.length: 31`), but the ChatView component's template never updated from the "No messages yet" empty state.

## Root Cause

**Not a `$derived` reactivity issue.** The real bug was in `ConnectionStatus.svelte`, which had two `$effect` blocks that both read AND wrote the same `$state` variables:

1. **Effect 1 (line 14-33):** Read `prevConnected` and then wrote `prevConnected = currentConnected` -- circular read/write dependency
2. **Effect 2 (line 36-52):** `retryCount++` reads AND writes `retryCount` in the same effect -- circular dependency

Both created `effect_update_depth_exceeded` errors that crashed Svelte 5's entire reactive batch processing system. Once the batch processor hit the infinite loop guard (>1000 iterations), it abandoned the batch, which meant NO reactive updates could propagate to ANY component -- including ChatView's message rendering.

The error was silent because:
- It threw as a `pageerror` event, not a console.error
- Previous debugging sessions focused on the store's `$derived` mechanism, not the ConnectionStatus component
- The ConnectionStatus banner itself appeared to work (it showed "Connected") because it rendered on the initial pass before the infinite loop triggered

## Investigation Path

1. Confirmed `$derived.by()` on the store class computes correctly (debug logs showed 31+ messages)
2. Tried getter pattern -- same result (store computes, template doesn't update)
3. Checked compiled Svelte output to understand `$.prop()`, `$.get()`, and `$.derived()` chains
4. Found ChatView had stale Vite-cached compiled code (cleared `.vite` cache)
5. Discovered `effect_update_depth_exceeded` page error via Playwright `pageerror` event
6. Traced the error to `ConnectionStatus.svelte:60` via stack trace
7. Fixed the circular read-write dependencies using `untrack()`

## Fix

### ConnectionStatus.svelte (the actual fix)

Wrapped self-referencing state reads in `untrack()` to break circular dependencies:

```javascript
// BEFORE (infinite loop):
$effect(() => {
  prevConnected = currentConnected;  // writes prevConnected which was implicitly read
  retryCount++;                       // reads AND writes retryCount
});

// AFTER (no loop):
$effect(() => {
  const prev = untrack(() => prevConnected);
  prevConnected = currentConnected;
  retryCount = untrack(() => retryCount) + 1;
});
```

### mqtt-store.svelte.js (kept $derived.by, removed debug log)

The store's `$derived.by()` pattern was already correct. Removed the temporary `console.log` debug in `#handleChatMessage`. The `$derived` fields work fine -- the issue was never in the store.

## Files Modified

- `web/src/components/ConnectionStatus.svelte` -- Fixed `effect_update_depth_exceeded` infinite loop
- `web/src/lib/mqtt-store.svelte.js` -- Removed debug console.log (kept `$derived.by()` pattern)

## Verification

1. Build passes: `npx vite build` succeeds
2. Dev server: no `effect_update_depth_exceeded` errors
3. Messages from MQTT history render in ChatView (45 messages visible)
4. Messages sent from web UI appear immediately (local echo + MQTT roundtrip)
5. Message input clears after send
6. Connection status banner works correctly

## Key Lesson

When debugging Svelte 5 reactivity issues where `$state`/`$derived` appear correct but templates don't update, check for `effect_update_depth_exceeded` errors first. This error kills the entire reactive batch processor, not just the offending component. It can manifest as "nothing updates" even in completely unrelated components.
