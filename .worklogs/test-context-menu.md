# Context Menu Functional Testing

**Date:** 2026-03-29
**Agent:** Functional Tester - Context Menu

## Summary

Comprehensive Playwright E2E testing of the right-click context menu on message bubbles. All 9 test scenarios verified. One bug found and fixed (viewport edge overflow).

## Tests Performed (All Passing)

| # | Test | Result |
|---|------|--------|
| 1 | Send 3 test messages, verify bubbles render | PASS |
| 2 | Right-click message shows context menu at cursor | PASS |
| 3 | Menu has all 7 items: Reply, Forward, Pin, Copy, React, Mark Unread, Delete | PASS |
| 4 | Click Reply closes menu and opens thread panel | PASS |
| 5 | Click outside (backdrop) closes menu | PASS |
| 6 | Press Escape closes menu | PASS |
| 7 | Click Copy copies message text to clipboard | PASS |
| 8 | Context menu near edge does not overflow viewport | PASS (after fix) |
| 9 | Delete item has danger class with red (#ef4444) color | PASS |

## Bug Found and Fixed

### Context Menu Viewport Overflow (Fixed)

**File:** `web/src/components/ContextMenu.svelte`

**Problem:** The context menu positioned at `top: y; left: x` without any viewport boundary clamping. When right-clicking near the bottom or right edge of the viewport, the menu would render partially off-screen.

**Fix:** Added `$derived` clamped coordinates that constrain the menu within the viewport:
```javascript
const MENU_WIDTH = 200;
const MENU_HEIGHT = 290;
let clampedX = $derived(Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH - 8)));
let clampedY = $derived(Math.max(8, Math.min(y, window.innerHeight - MENU_HEIGHT - 8)));
```

Menu now uses `clampedX`/`clampedY` instead of raw `x`/`y` for positioning.

## Testing Notes

### Selector Discovery

The `.msg-row` selector was unreliable because the `DateSeparator` component also uses `class="msg-row system"`, so `.msg-row:first()` selected the date separator instead of an actual message. The fix was to target `.bubble` elements directly, since the `contextmenu` event bubbles up from `.bubble` through the parent `.msg-row` to trigger the handler.

### System Load Impact

Tests were flaky due to 80+ concurrent Playwright processes from other agents on the same machine. The test was consolidated into a single sequential flow (one page load) to minimize resource contention. With retries, it passes reliably.

## Screenshots Generated

All at `/home/plafayette/claude-comms/mockups/`:

- `test-context-01-messages-sent.png` - 3 messages rendered
- `test-context-02-menu-visible.png` - Context menu open
- `test-context-03-all-items.png` - All 7 menu items visible
- `test-context-04-reply-thread.png` - Thread panel open after Reply
- `test-context-05-click-outside.png` - Menu dismissed by backdrop click
- `test-context-06-escape-close.png` - Menu dismissed by Escape
- `test-context-07-copy.png` - After Copy action
- `test-context-08-edge-position.png` - Menu clamped within viewport
- `test-context-09-danger-styling.png` - Delete item with red danger styling

## Files Modified

- `web/src/components/ContextMenu.svelte` - Added viewport edge clamping
- `web/e2e/context-menu.spec.js` - Comprehensive 9-scenario test suite
