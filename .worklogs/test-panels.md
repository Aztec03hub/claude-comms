# Panel Open/Close Functional Testing

## Date: 2026-03-29

## Summary
Comprehensive Playwright testing of search, pinned, and thread panel open/close behavior. Found and fixed 3 bugs, wrote 11 passing tests.

## Bugs Found and Fixed

### Bug 1: Search panel close button unclickable (FIXED)
- **File:** `web/src/components/SearchPanel.svelte`
- **Problem:** Search panel used `position: absolute; top: 0; z-index: 50` which placed it behind the chat header (`z-index: 101`). The close button was visually visible but the header intercepted all pointer events.
- **Fix:** Changed `top` to `82px` to position the search panel below both the ConnectionStatus bar and the chat header, avoiding z-index stacking conflicts entirely.

### Bug 2: Search input not auto-focused (FIXED)
- **File:** `web/src/components/SearchPanel.svelte`
- **Problem:** Opening the search panel did not auto-focus the search input field.
- **Fix:** Added `onMount` handler with `bind:this` to focus the search input when the panel mounts.

### Bug 3: Header glow pseudo-element intercepting clicks (FIXED)
- **File:** `web/src/App.svelte`
- **Problem:** The `.chat-header::after` glow effect pseudo-element could intercept pointer events near the header border.
- **Fix:** Added `pointer-events: none` to the `::after` pseudo-element.

## Tests Written (11 total, all passing)
File: `web/e2e/panels.spec.js`

1. Search button opens search panel
2. Search panel close button works
3. Pin button opens pinned panel
4. Pinned panel close button works
5. Escape key closes search panel
6. Escape closes pinned first when both panels open (correct priority: pinned > search > thread)
7. Search panel input auto-focused on open
8. Search button toggle (click twice = open then close)
9. Pin button toggle (click twice = open then close)
10. Chat area remains visible with search panel open
11. Channel switch with search panel open

## Screenshots Generated
All saved to `/home/plafayette/claude-comms/mockups/test-panels-*.png`:
- `test-panels-search-open.png` - Search panel opened
- `test-panels-search-closed.png` - Search panel closed
- `test-panels-pinned-open.png` - Pinned panel opened
- `test-panels-pinned-closed.png` - Pinned panel closed
- `test-panels-escape-search.png` - After Escape closes search
- `test-panels-both-open.png` - Both panels open simultaneously
- `test-panels-escape-first.png` - After first Escape (pinned closes)
- `test-panels-escape-second.png` - After second Escape (search closes)
- `test-panels-search-focused.png` - Search input focused
- `test-panels-toggle.png` - After toggle close
- `test-panels-chat-visible.png` - Chat visible with panel open
- `test-panels-channel-switch.png` - After switching channels

## Full Suite Verification
All 97 e2e tests pass (including 11 new panel tests) -- no regressions.

## Files Modified
- `web/src/components/SearchPanel.svelte` - top offset, auto-focus, z-index
- `web/src/components/PinnedPanel.svelte` - z-index (105, was 50)
- `web/src/App.svelte` - pointer-events: none on header glow
- `web/e2e/panels.spec.js` - 11 new tests (replaced previous 7)
