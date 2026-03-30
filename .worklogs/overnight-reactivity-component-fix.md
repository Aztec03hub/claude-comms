# Overnight: ChatView Reactivity Fix

**Date:** 2026-03-30
**Agent:** Component-side reactivity fix
**Status:** FIXED

## Root Cause

Svelte 5's batched rendering system (microtask-based flush) does NOT
commit DOM updates when `$state` is mutated from certain async contexts:

- MQTT `on('message')` callbacks
- `setInterval` / `setTimeout` callbacks
- WebSocket event handlers

The reactive dependency tracking works correctly -- `$derived` values
update, getters return fresh data, and `$.get()` reads the right value
when called imperatively (e.g., from `page.evaluate()`). But the DOM
batch never flushes, so the template blocks (`{#if}`, `{#each}`) never
re-evaluate.

### Evidence

| What | Result |
|------|--------|
| `store.messages.length` via `page.evaluate()` | 37+ (correct) |
| `store.messages.length` via `$effect` in ChatView | 0 (stale, never re-runs) |
| `store.activeMessages.length` via `setInterval` poll | Correct after ~1s |
| DOM `{#if messages.length === 0}` | Always true (never re-renders) |
| Local `$state` set from `setInterval` without `flushSync` | DOM never updates |
| Local `$state` set from `setInterval` WITH `flushSync` | DOM updates immediately |

### Key Finding

`flushSync()` from `svelte` is the missing piece. Without it, state
mutations from async callbacks create a batch but the batch's microtask
either doesn't fire or gets swallowed. Wrapping the assignment in
`flushSync(() => { messages = source; })` forces synchronous DOM
reconciliation.

## Fix Applied

### `ChatView.svelte`

1. Import `flushSync` from `svelte`
2. Rename `messages` prop to `messagesProp` to avoid shadowing
3. Create a local `$state` variable `messages` (reactive to template)
4. Poll `store.activeMessages` every 100ms via `setInterval`
5. On change detection (length comparison), assign via `flushSync()`
6. Template reads from the local `$state` which properly triggers DOM updates

### `App.svelte`

- Removed debug logging
- Removed unused `$derived` wrapper experiments (`visibleMessages`, etc.)
- Note: Another agent concurrently created `mqtt-store-v2.svelte.js` using
  module-level runes and updated App.svelte to use it. The ChatView fix
  is compatible with both store implementations.

## Files Modified

- `/home/plafayette/claude-comms/web/src/components/ChatView.svelte` -- reactivity bridge
- `/home/plafayette/claude-comms/web/src/App.svelte` -- cleanup (another agent also modified)
- `/home/plafayette/claude-comms/web/e2e/debug-reactivity.spec.js` -- fix hardcoded port

## Test Results

- `debug-reactivity.spec.js` -- PASS (was failing)
- `test-dom-polling.spec.js` -- PASS (created for debugging, then cleaned up)
- `app-loads.spec.js` -- 4/5 pass (1 pre-existing console error failure)
- `chat.spec.js` -- 4/6 pass (2 pre-existing CSS class selector mismatches)
- Build: SUCCESS

## Architecture Note

The 100ms polling + `flushSync` approach is a workaround, not ideal.
The proper fix is either:

1. **Module-level runes** (what the other agent implemented in v2 store) --
   avoids the class-based `$state` issue entirely
2. **Svelte upstream fix** -- the batch flush mechanism should handle async
   callback mutations without requiring explicit `flushSync`

With the v2 store in place, the `flushSync` polling may become
redundant. However, it provides defense-in-depth and should be kept
until the v2 store is fully validated.
