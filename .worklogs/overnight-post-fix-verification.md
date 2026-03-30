# Post-Fix Verification — Svelte 5 Reactivity Bug

**Date:** 2026-03-30
**Status:** VERIFIED and CLEAN

---

## The Bug

Svelte 5 `$derived` in class-based stores (`MqttChatStore`) did not recalculate when `$state` arrays were mutated from async MQTT callbacks. Messages were added to `this.messages` but `activeMessages` (the filtered view) never updated, so nothing rendered in the UI.

## The Fix

In `mqtt-store.svelte.js`:
- `$derived.by()` with explicit dependency reads (e.g., `const _len = this.messages.length`) ensures Svelte 5's proxy tracking catches mutations
- Synchronous immutable reassignment (`this.messages = [...this.messages, message]`) in `#handleChatMessage()` — no `setTimeout` wrapper, which breaks `$derived` tracking
- A module-level alternative (`mqtt-store-v2.svelte.js`) was also created during debugging but the class-based store is the one in use

## Verification Pass

### Step 1: Playwright E2E Test
Ran `victory-verification.spec.js` at 1440x900:
1. Sent 3 messages in `#general` — all 3 rendered as `.bubble` elements
2. Switched to `#random` — zero messages from `#general` visible; sent new message, rendered correctly
3. Switched back to `#general` — all 3 original messages still present
4. Sent `@Phil` mention — `.mention` span rendered with highlight styling
5. Victory screenshot captured: `web/e2e/victory-reactivity-fixed.png`

**Result:** 1 passed (5.9s)

### Step 2: Debug Artifact Cleanup
Removed from `web/`:
- 11 debug screenshots: `channel-switch-test.png`, `committed-test.png`, `dev-test-long.png`, `fixed-test.png`, `fresh-cache-test.png`, `fresh-long-test.png`, `getter-test.png`, `mqtt-msg-test.png`, `prod-test.png`, `reactivity-test.png`, `send-btn-test.png`, `send-test-final.png`
- 5 diagnostic scripts: `crosstest-diag.mjs`, `crosstest-final.mjs`, `crosstest.mjs`, `morning-screenshots.mjs`, `test-channel-switching.mjs`, `test-rounds-1-5.mjs`

Removed from `web/e2e/`:
- `debug-reactivity.spec.js`

Removed from source:
- 1 debug `console.log` in `mqtt-store-v2.svelte.js` line 228

### Step 3: Full Test Suite
- **Python:** `746 passed, 36 warnings` in 15.39s — all green
- **Vite build:** success (795 kB total JS, 94 kB CSS, 5 a11y warnings)

### Step 4: Overnight Status Updated
- Updated `.worklogs/overnight-status.md` with post-fix section
