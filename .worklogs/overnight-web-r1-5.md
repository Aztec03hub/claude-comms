# Overnight Web UI Test - Rounds 1-5

**Date:** 2026-03-29
**Agent:** Comprehensive Web UI Tester
**Status:** PASS - All rounds completed, 0 bugs found

---

## Round 1: Sidebar

| Test | Result | Notes |
|------|--------|-------|
| Click each channel, verify active state | PASS | All 4 channels (general, project-alpha, lora-training, random) get active class |
| Header updates on channel switch | PASS | `header-channel-name` text matches clicked channel |
| Collapse/expand starred section | PASS | Toggle hides/shows starred channels |
| Collapse/expand conversations section | PASS | Toggle hides/shows conversation channels |
| Search input exists | PASS | `sidebar-search` present |
| New Conversation button opens modal | PASS | `channel-modal` appears |
| User profile click opens profile card | PASS | `profile-card` appears |
| Settings gear opens settings panel | PASS | `settings-panel` appears via `.user-settings` button |
| Mute button toggles muted state | PASS | Channel gets `.muted` class, unmutes on second click |

**Screenshots:** `overnight-r1-channels.png`, `overnight-r1-collapse.png`, `overnight-r1-sidebar-final.png`

---

## Round 2: Chat Header

| Test | Result | Notes |
|------|--------|-------|
| Search button toggles search panel | PASS | Opens on first click, closes on second |
| Pin button toggles pinned panel | PASS | Opens on first click, closes on second |
| Settings button toggles settings panel | PASS | Opens on first click, closes on second |
| Members count toggles member list | PASS | Hides member list on click, shows on re-click |

**Screenshots:** `overnight-r2-search.png`, `overnight-r2-header.png`

---

## Round 3: Message Input

| Test | Result | Notes |
|------|--------|-------|
| Type + Enter sends message | PASS | Bubble appears in chat view |
| Click send button sends message | PASS | Second bubble appears |
| Empty/whitespace input rejected | PASS | Bubble count unchanged |
| Emoji button opens picker | PASS | `emoji-picker` appears |
| Attach button exists with hidden file input | PASS | Both `input-attach` and `input-file-hidden` present |
| Format button shows help | PASS | `format-help` tooltip appears |
| Snippet button inserts code template | PASS | Input value contains triple backtick template |

**Screenshots:** `overnight-r3-send-enter.png`, `overnight-r3-input.png`

---

## Round 4: Messages

| Test | Result | Notes |
|------|--------|-------|
| Multiple messages grouped (consecutive class) | PASS | 4 consecutive messages detected |
| Right-click context menu opens | PASS | All 7 items present (reply, forward, pin, copy, react, unread, delete) |
| Reply action opens thread panel | PASS | `thread-panel` appears |
| Pin action adds to pinned panel | PASS | 1 pinned item found in panel |
| Copy action executes | PASS | Clipboard API called |
| Delete action shows confirm, then removes | PASS | Confirm dialog shown, bubble count decreased by 1 |
| Hover action bar has Reply/React/More | PASS | All 3 buttons present |
| React button opens emoji picker | PASS | Picker opens, selecting emoji adds reaction |
| Toggle existing reaction | PASS | Count goes from 1 to 0 (toggle off) |
| Reaction (+) button | SKIPPED | Button not present because toggling removed all reactions/bar |

**Screenshots:** `overnight-r4-grouping.png`, `overnight-r4-messages.png`

---

## Round 5: Panels

| Test | Result | Notes |
|------|--------|-------|
| Search panel open + close button | PASS | Opens and closes cleanly |
| Pinned panel open + close button | PASS | Opens and closes cleanly |
| Thread panel open + close button | PASS | Opens via Reply, closes via X |
| Settings panel open + close button | PASS | Opens and closes cleanly |
| Escape priority (pinned before search) | PASS | First Escape closes pinned, second closes search |

**Screenshots:** `overnight-r5-panels.png`

---

## Bugs Found

**None.** All tested interactions work correctly.

## Notes

- The reaction (+) add button test was skipped because toggling the only reaction (from Round 4i) removed the reaction bar entirely. This is correct behavior -- the (+) button only renders inside `ReactionBar`, which only renders when `message.reactions?.length > 0`.
- The WebSocket mock prevented MQTT reconnection loops from blocking Playwright.
- CDP screenshots used instead of Playwright screenshots to avoid CSS animation hangs.
- Build verification passed before and after testing (no code changes needed).

## Test Infrastructure

- **Server:** Vite dev server on port 6001
- **Browser:** Chromium headless via Playwright 1.58.2
- **Method:** CDP Runtime.evaluate for DOM interaction + Playwright native for right-click
- **MQTT:** WebSocket mock (no broker connection)
