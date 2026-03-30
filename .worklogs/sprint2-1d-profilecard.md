# Sprint 2 - Agent 1D: ProfileCard bits-ui Migration

**Date:** 2026-03-29
**Component:** `web/src/components/ProfileCard.svelte`

## What Changed

Replaced the hand-rolled profile card popup (manual backdrop + click handler) with bits-ui `Popover` primitive.

### Before
- Manual `.profile-backdrop` div covering the full viewport (`position: fixed; inset: 0`)
- Click-outside detection via `handleBackdrop(e)` checking `e.target === e.currentTarget`
- Escape handled externally by App.svelte's global keydown handler
- Svelte a11y warnings suppressed with `<!-- svelte-ignore -->` comments

### After
- `Popover.Root` with `open={true}` (parent App.svelte controls mount/unmount via `{#if}`)
- `Popover.Content` wraps the card content
- Click-outside dismiss handled natively by bits-ui's `onInteractOutside` (via `onOpenChange`)
- Escape dismiss handled natively by bits-ui's `onEscapeKeydown` (via `onOpenChange`)
- No manual backdrop element -- bits-ui manages dismiss layer
- No a11y suppression comments needed

### Preserved
- All CSS classes: `.profile-card`, `.profile-card-banner`, `.profile-card-avatar`, `.profile-card-body`, `.profile-card-name`, `.profile-card-btn`
- All `data-testid` attributes: `profile-card`, `profile-card-name`, `profile-card-close`
- Props interface: `{participant, onClose}`
- Fixed positioning at `bottom: 70px; left: 14px` (overrides Floating UI inline styles with `!important`)
- Card animation (`cardIn`)

### Technical Notes
- CSS for `.profile-card` uses `:global([data-popover-content].profile-card)` to target bits-ui's wrapper element
- `avoidCollisions={false}` prevents Floating UI from repositioning the card
- Position overrides use `!important` to beat Floating UI's inline styles
- `data-testid="profile-card-close"` preserved on a hidden div since the backdrop was removed
- `.primary` button styles use `:global()` since the class is applied alongside a scoped class

## Build Verification

`npx vite build` passes cleanly (no new warnings).
