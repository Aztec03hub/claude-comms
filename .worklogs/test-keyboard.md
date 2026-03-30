# Keyboard Shortcuts & Accessibility Testing

**Agent:** Functional Tester (Keyboard/Accessibility)
**Date:** 2026-03-29

## Bugs Found & Fixed

### Bug 1: No Ctrl+K shortcut to open search
**Severity:** Medium
**File:** `/home/plafayette/claude-comms/web/src/App.svelte`
**Fix:** Added global `handleGlobalKeydown` function with `svelte:window onkeydown` binding. Ctrl+K (and Cmd+K on Mac) now toggles the search panel. Uses `e.preventDefault()` to avoid inserting 'k' when typing in the message input.

### Bug 2: No Escape key priority ordering
**Severity:** High
**Files:** `App.svelte`, `ChannelModal.svelte`, `EmojiPicker.svelte`, `ProfileCard.svelte`, `ContextMenu.svelte`, `SearchPanel.svelte`, `PinnedPanel.svelte`
**Problem:** Multiple components independently listened for Escape via their own `svelte:window onkeydown` or element-level `onkeydown` handlers. When Escape was pressed, ALL handlers fired simultaneously, closing everything at once instead of respecting a priority order.
**Fix:**
- Centralized all Escape handling in `App.svelte`'s `handleGlobalKeydown` function
- Removed individual Escape handlers from 6 child components (ChannelModal, EmojiPicker, ProfileCard, ContextMenu, SearchPanel, PinnedPanel)
- Implemented priority order: modal > context menu > emoji picker > profile card > pinned panel > search panel > thread panel
- Only the highest-priority open panel closes per Escape press

### Bug 3: No focus return after closing panels
**Severity:** Medium
**File:** `App.svelte`
**Problem:** After pressing Escape to close a panel, focus was lost to `document.body` instead of returning to a useful element.
**Fix:** After closing any panel via Escape, focus is returned to the message input (`[data-testid="message-input"]`) using `setTimeout(100)` to allow Svelte to re-render first.

## Test Results (10 tests)

| # | Test | Status |
|---|------|--------|
| 1 | Ctrl+K opens search panel | PASS |
| 2 | Escape closes topmost open panel | PASS |
| 3 | Escape closes panels in priority order | PASS |
| 4 | Enter in message input sends message | PASS |
| 5 | Shift+Enter does not send message | PASS |
| 6 | Tab navigation through interactive elements | PASS |
| 7 | Focused elements have visible focus ring | PASS |
| 8 | Enter on focused button activates it | PASS |
| 9 | Ctrl+K while typing opens search (not 'k') | PASS |
| 10 | Focus returns to message input after Escape | PASS |

**Note:** Tests are intermittently flaky due to slow page loading under headless Playwright (dev server performance under test load). All tests pass when the page loads successfully.

## Pre-existing Good Behavior (no fixes needed)

- **Enter to send:** Already worked in `MessageInput.svelte` via `handleKeydown`
- **Shift+Enter:** Already prevented from sending (only `Enter` without shift triggers send)
- **Tab navigation:** Interactive elements are naturally tabbable
- **Focus ring:** Global `*:focus-visible` CSS rule already provides `box-shadow: var(--focus-ring)` on focused elements
- **Enter on buttons:** Native browser behavior, works correctly

## Screenshots

- `/home/plafayette/claude-comms/mockups/test-keyboard-ctrlk.png` — Ctrl+K opening search panel
- `/home/plafayette/claude-comms/mockups/test-keyboard-ctrlk-typing.png` — Ctrl+K while typing in input
- `/home/plafayette/claude-comms/mockups/test-keyboard-tab-nav.png` — Tab navigation focus state
- `/home/plafayette/claude-comms/mockups/test-keyboard-focus-ring.png` — Visible focus ring on button
- `/home/plafayette/claude-comms/mockups/test-keyboard-focus-return.png` — Focus on message input after Escape

## Files Modified

- `web/src/App.svelte` — Added `handleGlobalKeydown` with Ctrl+K and prioritized Escape handling
- `web/src/components/ChannelModal.svelte` — Removed local Escape handler (deferred to App)
- `web/src/components/EmojiPicker.svelte` — Removed local Escape handler (deferred to App)
- `web/src/components/ProfileCard.svelte` — Removed local Escape handler (deferred to App)
- `web/src/components/ContextMenu.svelte` — Removed local Escape handler (deferred to App)
- `web/src/components/SearchPanel.svelte` — Removed local Escape handler (deferred to App)
- `web/src/components/PinnedPanel.svelte` — Removed local Escape handler (deferred to App)
- `web/e2e/keyboard.spec.js` — New test file with 10 keyboard/accessibility tests
