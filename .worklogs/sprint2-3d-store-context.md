# Sprint 2 Batch 3 — Agent 3D: Store Methods & Context Actions

**Status:** COMPLETE
**Date:** 2026-03-29
**Build:** PASS (vite build clean)

## Changes Made

### 1. mqtt-store.svelte.js — 4 new methods
- `markUnread(message)` — sets `channel.unreadFrom` and ensures `unread >= 1`
- `deleteMessage(messageId)` — immutable filter for Svelte 5 reactivity
- `muteChannel(channelId)` — toggles `channel.muted` boolean
- `forwardMessage(message, targetChannelId)` — re-publishes message body to target channel with `forwarded_from` metadata

### 2. ConfirmDialog.svelte — NEW component
- Uses bits-ui `Dialog` (same pattern as ChannelModal)
- Props: `title`, `message`, `confirmLabel`, `confirmDanger`, `onConfirm`, `onCancel`
- Danger button styled red with gradient
- data-testid: `confirm-dialog`, `confirm-dialog-confirm`, `confirm-dialog-cancel`

### 3. MessageBubble.svelte — onMore prop
- Added `onMore` prop
- MessageActions More button now calls `onContextMenu` with the button's bounding rect position

### 4. MessageActions.svelte — onMore prop wired
- Added `onMore` prop, wired to More button's `onclick`

### 5. FileAttachment.svelte — download wiring
- Added `url` prop
- Download button triggers programmatic `<a>` download
- Whole attachment clickable with same download behavior
- Added `data-testid="file-download"`

### 6. Sidebar.svelte — mute button (both starred and unstarred)
- Added `onMuteChannel` prop
- Mute buttons wired with `e.stopPropagation()` + `onMuteChannel(channel.id)`
- Visual mute state: `.muted` class with reduced opacity (0.5, 0.75 on hover)
- VolumeX icon shown in channel meta when muted
- `data-testid="channel-mute-{channel.id}"` on both starred and unstarred items

### 7. App.svelte — context action handlers
- Imported `ConfirmDialog`
- Added state: `showDeleteConfirm`, `deleteTarget`
- `handleContextAction` handlers for:
  - `forward`: copies body to clipboard + toast "Forwarding coming soon"
  - `unread`: calls `store.markUnread(message)`
  - `delete`: sets deleteTarget, opens ConfirmDialog
- Added `<ConfirmDialog>` render block for delete confirmation
- Passed `onMuteChannel` to Sidebar

## Files Modified
- `/home/plafayette/claude-comms/web/src/lib/mqtt-store.svelte.js`
- `/home/plafayette/claude-comms/web/src/components/ConfirmDialog.svelte` (NEW)
- `/home/plafayette/claude-comms/web/src/components/MessageBubble.svelte`
- `/home/plafayette/claude-comms/web/src/components/MessageActions.svelte`
- `/home/plafayette/claude-comms/web/src/components/FileAttachment.svelte`
- `/home/plafayette/claude-comms/web/src/components/Sidebar.svelte`
- `/home/plafayette/claude-comms/web/src/App.svelte`
