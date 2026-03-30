# Overnight: Forward Picker + Settings Name Persistence

**Date:** 2026-03-30
**Commit:** cb91bcf
**Audit items resolved:** #4 (forward action stub), #8 (settings name not persisted)

---

## Fix 1: Forward Action (Audit #4)

**Problem:** Context menu "Forward" action copied text to clipboard and showed a "Forwarding coming soon" toast, despite `store.forwardMessage()` already being fully implemented.

**Solution:**
- Created `ForwardPicker.svelte` -- a modal overlay listing all channels except the current one
- User clicks a channel to forward; calls `store.forwardMessage(message, targetChannelId)`
- Shows a confirmation toast with the target channel name after forwarding
- Picker closes on selection, clicking the backdrop, close button, or Escape key

**Files:**
- `web/src/components/ForwardPicker.svelte` (new)
- `web/src/App.svelte` -- import ForwardPicker, add state vars, replace toast stub with picker open, add template block

## Fix 2: Settings Name Persistence (Audit #8)

**Problem:** Changing display name in SettingsPanel updated `store.userProfile.name` in memory but never saved to localStorage. On page reload, the name reverted.

**Solution:** Added `localStorage.setItem('claude-comms-user-name', displayName)` in `handleNameChange()`. The store's `connect()` method already reads from this key on startup (line 130-133 of `mqtt-store.svelte.js`), so the round-trip is complete.

**Files:**
- `web/src/components/SettingsPanel.svelte` -- 3-line addition in `handleNameChange()`

## Notes

- Did NOT edit `mqtt-store.svelte.js` per instructions (another agent may be touching it)
- The store already had `forwardMessage()` fully implemented with MQTT publish + local echo + `forwarded_from` metadata
- Build verified clean (only pre-existing a11y warnings from ProfileCard and EmojiPicker)
