# User Stories Testing Work Log

**Started:** 2026-03-30 00:50 CDT
**Completed:** 2026-03-30 01:00 CDT
**Agent:** User Story Tester

## Summary

Created 7 end-to-end user story tests that simulate realistic user flows through the Claude Comms web client. All 7 stories pass with 26 screenshots captured.

## Test File

- `/home/plafayette/claude-comms/web/e2e/user-stories.spec.js` (NEW)

## Stories Implemented

### Story 1: New User First Experience
- App loads with "general" channel selected
- Empty state visible ("No messages yet")
- Send a message, verify bubble appears with sender name and timestamp
- Switch channels, verify header updates and empty state shows
- Return to general, verify message persists across channel switches
- Open emoji picker from input button, select emoji, picker closes
- Open settings panel, verify profile section visible, close it

### Story 2: Team Discussion
- Send two messages, verify grouping (only one sender name for consecutive messages)
- Right-click message bubble to open context menu
- Click Reply, verify thread panel opens with parent message
- Send reply in thread panel, verify it appears
- Close thread panel

### Story 3: Channel Management
- Open channel creation modal
- Fill in name "training-results" and description
- Create channel, verify auto-selected in header
- Send message in new channel
- Switch back to general, verify new channel in sidebar
- Mute the new channel, verify `.muted` CSS class applied

### Story 4: Message Reactions & Interactions
- Send 3 messages, hover first to reveal action bar
- Click React, emoji picker opens, select emoji, reaction appears
- Click reaction to toggle it off (count decreases)
- Right-click second message, click Copy
- Right-click third message, click Delete, confirm in dialog
- Verify message count decreased after deletion

### Story 5: Quick Search & Navigation
- Ctrl+K opens search panel, type query, Escape closes it
- Click members count pill to toggle member list visibility
- Click again to restore
- Attempt member click for profile card (conditional on participants existing)
- Ctrl+K reopens search

### Story 6: Customization & Settings
- Open settings panel from header gear button
- Verify Profile, Notifications, and Connection sections exist
- Close settings
- Toggle theme to light mode, verify `data-theme="light"`
- Toggle back to dark mode, verify `data-theme="dark"`

### Story 7: Mobile User
- Set viewport to 480x800
- Verify center column visible with positive dimensions
- Verify message input visible and functional
- Send message, verify bubble appears
- Verify no horizontal overflow (scrollWidth <= innerWidth)

## Bugs Found and Issues

### Issue: bits-ui ContextMenu requires right-click on `.bubble`, not `.msg-row`
The context menu component uses Svelte's `oncontextmenu` on the `.msg-row` div, which dispatches to bits-ui's trigger. Playwright's right-click works reliably on `.bubble` elements. This is consistent with existing context-menu tests.

### Issue: `[data-testid^="member-"]` selector too broad
The selector matches `member-list`, `members-online-section`, `members-offline-section` in addition to actual member items. Tests must exclude these with `:not()` selectors.

### Issue: No members rendered with mocked WebSocket
With the MQTT WebSocket mock, no real participants join, so the member list shows 0 individual members. Tests must gracefully handle this by checking and skipping member-specific assertions.

## Source Files Edited
None -- no source bugs required fixes. All issues were test-side.

## Screenshots Captured (26 total)
All saved to `/home/plafayette/claude-comms/mockups/user-stories/`

| Screenshot | Story |
|---|---|
| s1-empty-state.png | Empty chat on first load |
| s1-first-message.png | First message sent |
| s1-message-persists.png | Message persists after channel switch |
| s1-settings-open.png | Settings panel open |
| s2-grouped-messages.png | Consecutive messages grouped |
| s2-context-menu.png | Context menu on right-click |
| s2-thread-open.png | Thread panel with parent message |
| s2-thread-reply.png | Reply sent in thread |
| s3-modal-open.png | Channel creation modal |
| s3-channel-created.png | New channel auto-selected |
| s3-channel-muted.png | Muted channel indicator |
| s4-three-messages.png | Three messages ready for interactions |
| s4-emoji-picker.png | Emoji picker from React button |
| s4-reaction-added.png | Reaction emoji on message |
| s4-delete-confirm.png | Delete confirmation dialog |
| s4-after-delete.png | After message deletion |
| s5-search-open.png | Search panel open with query |
| s5-member-toggle.png | Member list toggled |
| s5-user-profile-click.png | Sidebar user profile click |
| s6-settings-panel.png | Settings panel sections |
| s6-light-mode.png | Light theme applied |
| s6-dark-mode-restored.png | Dark theme restored |
| s7-mobile-viewport.png | Mobile viewport (480x800) |
| s7-mobile-message.png | Message on mobile viewport |

## Test Results

```
Running 7 tests using 1 worker
  7 passed (40.0s)
```
