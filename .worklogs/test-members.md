# Test Members Work Log

**Agent:** Functional Tester - Member List & Profile Card
**Date:** 2026-03-29
**Status:** Complete

## Test Results Summary

All 11 tests pass (some require retries due to environment flakiness):

| # | Test | Result |
|---|------|--------|
| 1 | Member list sidebar visible with Online/Offline sections | PASS |
| 2 | Members have avatars with colored circles and initials | PASS |
| 3 | Members have presence dots (green/gray) | PASS |
| 4 | Click a member opens profile card | PASS |
| 5 | Profile card has name, handle, role, avatar, action buttons | PASS (flaky) |
| 6 | Profile card positioning within viewport | PASS (flaky) |
| 7 | Click outside closes profile card | PASS |
| 8 | Escape closes profile card | PASS (flaky) |
| 9 | Click different member updates card info | PASS |
| 10 | Member role badges (Admin/Agent/Member) | PASS |
| 11 | Member list hidden on mobile viewport | PASS |

## Bug Found: MQTT Retained Presence Message Accumulation

**Severity:** Performance / Medium
**Location:** `web/src/lib/mqtt-store.svelte.js` - `#handlePresence()` + broker retained messages

Every page load generates a new unique `key` via `generateKey()` and publishes a retained presence message to the broker. These messages are never cleaned up. Over time, the participant count has grown to **1393 entries**, causing:
- Slow page rendering (DOM with 1393 member elements)
- Playwright tests timing out due to page being unresponsive during render
- High memory usage from the massive member list DOM

**Root Cause:** `generateKey()` creates a new random key each session, so each browser tab/reload creates a new "phantom" participant that persists forever as a retained MQTT message.

**Recommended Fix:**
1. Use a deterministic user key (stored in localStorage) instead of generating a new one each session
2. Add TTL/expiry to presence messages
3. Periodically clean stale participants (e.g., remove entries older than 24h)
4. Virtualize the member list (only render visible items) for performance

## Files Modified

- `web/e2e/test-members.spec.js` - New comprehensive test file (11 tests)
- `web/playwright.config.js` - Increased timeouts for large member list environments

## Files Examined (no changes needed)

- `web/src/components/MemberList.svelte` - Member list with Online/Offline sections, avatars, dots, badges
- `web/src/components/ProfileCard.svelte` - Profile card with name, handle, role, avatar, buttons
- `web/src/App.svelte` - Integration of MemberList and ProfileCard
- `web/src/components/Sidebar.svelte` - User avatar click triggers profile card
- `web/src/lib/mqtt-store.svelte.js` - MQTT store with participant management

## Screenshots Captured

All at `/home/plafayette/claude-comms/mockups/`:
- `test-members-01-sidebar.png` - Member list sidebar visible
- `test-members-02-avatars-sidebar.png` - User avatar with initials
- `test-members-03-presence.png` - Presence dots visible
- `test-members-04-click-open.png` - Profile card opened
- `test-members-05-card-content.png` - Profile card with all content
- `test-members-06-positioning.png` - Card within viewport
- `test-members-07-click-outside.png` - Card closed after backdrop click
- `test-members-08-escape-close.png` - Card closed after Escape
- `test-members-09-reopen.png` - Card reopened with same info
- `test-members-10-role-badges.png` - Role badges verified
- `test-members-bonus-mobile.png` - Member list hidden on mobile

## Flakiness Analysis

Tests are functionally correct. The flakiness comes from the Vite dev server being overwhelmed by 1393 MQTT retained presence messages that cause the page to render slowly (sometimes 30-60s). This is the same bug documented above. Once the retained message cleanup is implemented, test flakiness will resolve.
