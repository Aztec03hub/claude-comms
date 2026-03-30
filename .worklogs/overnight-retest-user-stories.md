# Overnight Retest: User Story Tests

**Date:** 2026-03-30
**Status:** COMPLETE - 12/12 passing

## Summary

Re-ran all 12 user story tests after message rendering bug fix. Found 2 failures (Story 1, Story 8) caused by tests expecting exact bubble counts in a clean environment, but the live API (`localhost:9920`) returning 50 real messages from `#general` channel history.

## Root Cause

- Tests mocked MQTT WebSocket but did NOT mock the HTTP API endpoints (`/api/messages/`, `/api/participants/`, `/api/identity`)
- The app's `fetchHistory()` in `mqtt-store-v2.svelte.js` loads up to 50 messages from `http://localhost:9920/api/messages/{channel}?count=50`
- Story 1 expected exactly 1 bubble after sending 1 message, got 51 (50 history + 1 new)
- Story 8 expected exactly 2 bubbles after sending 2 messages, got 52

## Fix Applied

Added API route mocking to `beforeEach` in both test files:
- `e2e/user-stories.spec.js` — lines 25-35
- `e2e/user-stories-r2.spec.js` — lines 25-35

Mocked endpoints:
- `**/api/messages/**` -> empty messages array
- `**/api/participants/**` -> empty participants array
- `**/api/identity` -> test user identity

This matches the existing pattern of mocking MQTT WebSocket, giving tests a clean isolated environment.

## Test Results

```
Running 12 tests using 2 workers

  ✓ Story 1: New User First Experience (5.5s)
  ✓ Story 2: Team Discussion (5.2s)
  ✓ Story 3: Channel Management (5.1s)
  ✓ Story 4: Message Reactions & Interactions (8.6s)
  ✓ Story 5: Quick Search & Navigation (4.9s)
  ✓ Story 6: Customization & Settings (3.6s)
  ✓ Story 7: Mobile User (1.6s)
  ✓ Story 8: Multi-Channel Workflow (4.7s)
  ✓ Story 9: Power User Keyboard Flow (4.8s)
  ✓ Story 10: Reaction Conversation (6.1s)
  ✓ Story 11: Settings Workflow (3.8s)
  ✓ Story 12: Pin and Find Important Messages (8.4s)

12 passed (35.8s)
```

## Screenshots Verified

Message rendering confirmed working in screenshots:
- `s1-first-message.png` — single message bubble with sender name + timestamp
- `s4-three-messages.png` — multiple grouped messages rendering correctly

## Files Changed

- `web/e2e/user-stories.spec.js` — added API route mocking in beforeEach
- `web/e2e/user-stories-r2.spec.js` — added API route mocking in beforeEach
