# Channel Switching & Sidebar Interaction Tests

**Date:** 2026-03-29
**Tester:** Functional Tester Agent (Claude)
**Target:** Claude Comms web app (http://localhost:5175)

## Test Results

| # | Test | Result |
|---|------|--------|
| 1 | Click each channel updates header | PASS |
| 2 | Active state highlighting toggles correctly | PASS |
| 3 | Collapse starred section hides starred channels | PASS |
| 4 | Expand starred section restores starred channels | PASS |
| 5 | Collapse/expand conversations section | PASS |
| 6 | Channel switch works with search panel open | PASS |
| 7 | Sidebar search input focus and typing | PASS |

**Overall: ALL 7 TESTS PASSED**

## Bug Found & Fixed

### Duplicate channels in sidebar (previously fixed in commit 71cc736)

**Problem:** Starred channels (project-alpha, lora-training) appeared in BOTH the "Starred" section AND the "Conversations" section, because the Conversations list rendered `store.channels` (all channels) instead of filtering out starred ones. This caused the starred section collapse/expand test to fail -- collapsing the starred section hid the starred copy, but the channel was still visible in the conversations section.

**Fix applied to** `web/src/components/Sidebar.svelte`:
1. Added `$derived` property `unstarredChannels` that filters `store.channels` by `!c.starred`
2. Changed conversations `{#each}` loop from `store.channels` to `unstarredChannels`
3. Added distinct `data-testid="starred-channel-item-{id}"` prefix for starred section items (vs `channel-item-{id}` for conversations)

## Test Infrastructure Notes

- `page.screenshot()` hangs indefinitely due to infinite CSS animations in the app (`brandBreath`, `badgePulse`, `connPulse`, etc.). Workaround: use CDP `Page.captureScreenshot` via `page.context().newCDPSession(page)`.
- Vite HMR causes `Execution context was destroyed` errors during tests when source files change. Workaround: run tests against `vite preview` (static build) instead of `vite dev`.
- MQTT reconnection cycles generate toast notifications that intercept Playwright clicks. Workaround: use `page.evaluate(el => el.click())` instead of Playwright locator clicks.
- All DOM interactions use `page.evaluate()` to avoid Playwright locator timeouts caused by continuous MQTT reconnection re-renders.

## Screenshots

All saved to `/home/plafayette/claude-comms/mockups/test-channels-*.png`:
- `01-initial.png` -- Initial sidebar state
- `02-after-channel-clicks.png` -- After clicking all channels
- `03-active-state.png` -- Active state highlighting
- `04-before-starred-collapse.png` -- Before collapsing starred
- `05-after-starred-collapse.png` -- After collapsing starred
- `06-after-starred-expand.png` -- After expanding starred
- `07-after-convo-collapse.png` -- After collapsing conversations
- `08-after-convo-expand.png` -- After expanding conversations
- `09-search-panel-open.png` -- Search panel open
- `10-channel-switch-with-panel.png` -- Channel switched with panel open
- `11-search-input.png` -- Search input focused and typed

## Test Script

`/home/plafayette/claude-comms/web/test-channel-switching.mjs`
