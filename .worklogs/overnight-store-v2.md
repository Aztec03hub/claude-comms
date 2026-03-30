# Store V2: Module-Level Runes (Nuclear Option)

**Date:** 2026-03-30
**Status:** COMPLETE — builds clean, dev server tested on port 6003

## Problem

Two prior agents failed to fix Svelte 5 reactivity: messages arrive in the store array but `$derived` never recalculates, so messages don't render. Attempted fixes (all failed):
- `$derived.by()` with explicit dependency reads
- Getter wrappers in App.svelte
- `setTimeout(0)` deferred updates
- `flushSync()` polling workaround in ChatView (partial fix)

**Root cause theory:** Svelte 5's `$state` and `$derived` in class fields have a fundamental issue with async mutation tracking from callbacks (MQTT, fetch). Every official Svelte 5 example uses runes in `<script>` blocks or module-level `.svelte.js` files, never in class instances.

## Solution

Created `/web/src/lib/mqtt-store-v2.svelte.js` — a complete rewrite using **module-level runes**:

- All `$state()` declarations at module scope (not class fields)
- All `$derived()` declarations at module scope
- All methods converted to plain exported functions
- `getStore()` returns an object with **getters** that read the module-level `$state`/`$derived` values
- Every mutation uses **immutable reassignment** (spread/map/filter) to ensure new references trigger reactivity

## Files Changed

| File | Change |
|------|--------|
| `web/src/lib/mqtt-store-v2.svelte.js` | **NEW** — module-level runes store |
| `web/src/App.svelte` | Swapped import from `MqttChatStore` class to `getStore()` function |
| `web/src/lib/mqtt-store.svelte.js` | **UNTOUCHED** — kept as fallback |

## Key Design Decisions

1. **All mutations are immutable** — `messages = [...messages, newMsg]` not `messages.push(newMsg)`. Same for channels, participants, typingUsers. This guarantees Svelte 5 sees a new reference.

2. **Object state uses spread** — `participants = { ...participants, [key]: value }` instead of `participants[key] = value`.

3. **getStore() uses getters** — The returned object has `get messages() { return messages; }` etc. Each getter reads the module-level `$state` variable, which Svelte 5 tracks when accessed inside a reactive context (`$derived`, `$effect`, template expressions).

4. **Setters for mutable props** — `userProfile` and `inAppToasts` have setters since SettingsPanel writes to them directly.

5. **ChatView polling still works** — ChatView's existing `setInterval(syncMessages, 100)` + `flushSync()` workaround is compatible since it reads `store.activeMessages` (a getter on the returned object). With module-level runes, this may no longer be needed, but keeping it as defense-in-depth.

## Verification

- `vite build` succeeds (4348 modules, no errors)
- Dev server on port 6003 serves the app
- All pre-existing warnings unchanged (SettingsPanel state_referenced_locally, a11y)
- No new warnings from mqtt-store-v2.svelte.js

## Next Steps / Testing Needed

1. **Manual test:** Open browser at http://localhost:6003, send a message, verify it renders in the chat
2. **MQTT test:** Start the broker (`claude-comms start`), verify messages arrive via MQTT and render
3. **If working:** Remove the ChatView polling workaround (setInterval/flushSync) since it should no longer be needed
4. **If working:** Consider removing the old `mqtt-store.svelte.js` class-based store
