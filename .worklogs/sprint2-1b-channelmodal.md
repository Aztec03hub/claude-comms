# Sprint 2 - Agent 1B: ChannelModal bits-ui Dialog Migration

**Date:** 2026-03-29
**File:** `web/src/components/ChannelModal.svelte`
**Status:** COMPLETE

## What Changed

Replaced hand-rolled modal implementation with bits-ui `Dialog` primitive components.

### Components Used
- `Dialog.Root` — manages open state, wired `onOpenChange` to call `onClose` when closed
- `Dialog.Portal` — renders modal into document body (portal rendering)
- `Dialog.Overlay` — backdrop with `modal-overlay` class and `data-testid="channel-modal"`
- `Dialog.Content` — modal container with `modal` class, positioned fixed center
- `Dialog.Title` — accessible dialog title with `modal-title` class
- `Dialog.Close` — X button with `data-testid="channel-modal-close"`

### Accessibility Gains
- **Focus trap**: bits-ui Dialog traps Tab focus within the modal automatically
- **Portal rendering**: modal renders in `document.body` via `Dialog.Portal`
- **`role="dialog"`**: automatically applied by `Dialog.Content`
- **`aria-labelledby`**: automatically wired between `Dialog.Content` and `Dialog.Title`
- **Escape closes**: handled by bits-ui internally
- **Backdrop click closes**: handled via `onOpenChange` callback on `Dialog.Root`

### Preserved
- All CSS classes: `.modal-overlay`, `.modal`, `.modal-header`, `.modal-body`, `.modal-footer`, `.modal-btn`, `.toggle-switch`
- All `data-testid` attributes: `channel-modal`, `channel-modal-name-input`, `channel-modal-description`, `channel-modal-private-toggle`, `channel-modal-cancel`, `channel-modal-create`, `channel-modal-close`
- Props interface: `{onClose, onCreate}` unchanged
- All form logic (sanitization, Enter key handling, private toggle)

### CSS Approach
- Used `:global()` selectors for bits-ui component elements that receive `data-dialog-*` attributes (overlay, content, close, title)
- Internal elements (body, footer, fields, toggle) keep scoped styles unchanged
- Modal positioning changed from flex-centering on overlay to `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%)` on content since bits-ui renders overlay and content as siblings

## Verification
- `npx vite build` passes successfully
- Only pre-existing a11y warning on toggle-switch div (was previously suppressed with svelte-ignore comments in original)
