# Performance Audit — 2026-03-30

## Bundle Sizes (production build)

| Chunk | Raw | Gzip |
|---|---|---|
| `vendor-mqtt` | 372.37 KB | 112.19 KB |
| `vendor-ui` | 326.61 KB | 65.05 KB |
| `index` (app code) | 98.07 KB | 28.99 KB |
| `index.css` | 93.85 KB | 16.07 KB |
| `vendor-ui.css` | 0.63 KB | 0.22 KB |
| **Total JS** | **797.05 KB** | **206.23 KB** |
| **Total CSS** | **94.48 KB** | **16.29 KB** |

**Assessment:** The MQTT library dominates the bundle at 372 KB raw / 112 KB gzip. The UI vendor chunk (bits-ui + lucide-svelte icons) is 327 KB raw / 65 KB gzip. App code itself is modest at 98 KB. Total gzip transfer is ~222 KB which is acceptable for a chat app, but the MQTT library is worth watching.

Build completed in 4.86s with 4348 modules transformed. No build errors (only a11y warnings on ProfileCard and EmojiPicker, plus a Svelte state capture warning on SettingsPanel).

## Component Count and Complexity

- **30 Svelte components** total
- Largest: `Sidebar.svelte` (584 lines), `MessageInput.svelte` (428), `SettingsPanel.svelte` (407), `MessageBubble.svelte` (370)
- Lib files: `mqtt-store.svelte.js` (991 lines), `mqtt-store-v2.svelte.js` (806 lines), `utils.js` (278), `notifications.svelte.js` (140)

**Assessment:** Component sizes are reasonable. Sidebar at 584 lines is the largest but not alarming for a chat sidebar with channel management. Two MQTT store implementations exist (v1 and v2) — only v1 is imported by App.svelte, so v2 is dead code adding to the module count.

## Anti-Pattern Findings

### 1. ChatView 100ms Polling (MEDIUM severity)

**File:** `web/src/components/ChatView.svelte`, line 51

```js
const id = setInterval(syncMessages, 100);
```

ChatView polls the store's `activeMessages` array every 100ms to work around a Svelte 5 class-based `$state/$derived` reactivity limitation (class instance fields don't propagate reactive updates across component boundaries). The sync function compares array lengths and calls `flushSync()` on change.

**Impact:** 10 timer fires/second per ChatView instance. Each fire reads `store.activeMessages` (a `$derived` getter that calls `.filter()`), compares lengths, and usually no-ops. Low CPU cost per tick but wasteful — this is the most impactful anti-pattern found.

**Root cause:** Documented in comments — Svelte 5's reactive system doesn't track class instance field mutations across component boundaries. The v2 store (module-level runes) was built to fix this but is not currently wired up.

### 2. Typing Timers Not Cleared on Disconnect (LOW severity)

**File:** `web/src/lib/mqtt-store.svelte.js`, `disconnect()` at line 387

The `disconnect()` method stops participant polling and closes the MQTT client, but does **not** clear:
- `#myTypingTimer` (own typing debounce, 3s timeout)
- `#typingTimers` object (remote user typing expiry timers, 5s each)

These are short-lived timeouts that will self-expire, so memory leak risk is minimal. But if `disconnect()` is called while timers are pending, they'll fire after the client is gone and attempt state mutations on a disconnected store.

Same issue exists in v2 store (`myTypingTimer`, `typingTimers`).

### 3. Backoff Reconnect setTimeout Not Cleared on Disconnect (LOW severity)

**File:** `web/src/lib/mqtt-store.svelte.js`, line 958; `mqtt-store-v2.svelte.js`, line 396

The exponential backoff reconnect uses `setTimeout()` with delays up to 128 seconds. If `disconnect()` is called during a backoff wait, that timer is not cancelled. It will fire and attempt to reconfigure a null client (guarded by `if (this.#client)` / `if (client)` checks, so it won't crash, but it's wasteful).

### 4. ConnectionStatus Timers Missing Component Teardown (LOW severity)

**File:** `web/src/components/ConnectionStatus.svelte`

Two `$effect` blocks create `setTimeout` (autoHide, line 39) and `setInterval` (retryCountdown, line 54). The effects clear previous timers before creating new ones, but neither `$effect` returns a cleanup function. If the component is destroyed while timers are running, they'll fire on unmounted state. Since this component is always mounted in the app layout, practical risk is near zero.

### 5. IntersectionObserver Re-observes All Elements on Every Message (LOW severity)

**File:** `web/src/components/ChatView.svelte`, lines 136-147

The second `$effect` re-observes every `[data-message-id]` element whenever `messages.length` changes, using `querySelectorAll`. IntersectionObserver handles duplicate `observe()` calls gracefully (no-ops for already-observed elements), so it's not a bug, but it's O(n) DOM queries on each new message.

### 6. Unbounded Message Array (INFO)

Neither store implementation caps the `messages` array. In a long-running session with high message volume, the array will grow without bound. Each new message triggers an immutable array copy (`this.messages = [...this.messages, message]`). With thousands of messages, these spread copies become O(n) per message.

### 7. Dead Code: mqtt-store-v2.svelte.js (INFO)

The v2 store (806 lines) is not imported anywhere. It was built to solve the reactivity issue that ChatView's 100ms polling works around. It adds to the module count (though tree-shaking should exclude it from the production bundle — confirmed: it's not in the build output).

### 8. Array Spread Pattern on Reactions (INFO)

**File:** `web/src/lib/mqtt-store.svelte.js`, lines 660, 910

After modifying a message's `reactions` sub-array in-place, the entire `messages` array is re-spread (`this.messages = [...this.messages]`) to trigger reactivity. This is O(n) on the full message list just to signal a single message's reaction change.

## Summary

| Finding | Severity | Fix Effort |
|---|---|---|
| 100ms polling in ChatView | MEDIUM | Medium (switch to v2 store or event-based bridge) |
| Typing timers not cleared on disconnect | LOW | Trivial |
| Backoff timer not cleared on disconnect | LOW | Trivial |
| ConnectionStatus missing $effect cleanup | LOW | Trivial |
| IntersectionObserver re-observe all | LOW | Low |
| Unbounded message array | INFO | Low (add cap/window) |
| Dead v2 store code | INFO | Trivial (delete or wire up) |
| O(n) array spreads for reactions | INFO | Low |

No critical performance issues found. The app should perform well for typical chat usage (dozens of participants, hundreds of messages per session). The 100ms polling is the most actionable item — switching to the v2 module-level store or an event emitter pattern would eliminate it.
