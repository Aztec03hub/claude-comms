# Sprint 2 - Agent 1C: EmojiPicker bits-ui Popover Migration

**Date:** 2026-03-29
**File:** `/home/plafayette/claude-comms/web/src/components/EmojiPicker.svelte`

## What Changed

Replaced the hand-rolled emoji picker overlay (manual backdrop div + click handler) with bits-ui `Popover.Root` and `Popover.Content` primitives.

### Removed
- Manual `.emoji-backdrop` div and `handleBackdropClick()` function
- Svelte a11y ignore comments for the backdrop click handler
- Comment about escape being handled by App.svelte

### Added
- `import { Popover } from 'bits-ui'`
- `Popover.Root` with controlled `bind:open` and `onOpenChange` callback
- `Popover.Content` wrapping all picker internals
- `onOpenAutoFocus` handler that auto-focuses the search input on open
- `onCloseAutoFocus` handler that prevents unwanted focus restoration
- New `open` prop (`$bindable(true)`) for controlled state from parent
- `searchInput` ref (`bind:this`) for programmatic focus

### Preserved (unchanged)
- All CSS classes: `.emoji-picker`, `.emoji-picker-header`, `.emoji-search`, `.emoji-categories`, `.emoji-cat`, `.emoji-grid`, `.emoji-grid-label`, `.emoji-item`, `.emoji-picker-footer`
- All `data-testid` attributes: `emoji-picker`, `emoji-search`, `emoji-category-{cat.id}`, `emoji-item`
- Props interface: `{onSelect, onClose}` (plus new optional `open`)
- All emoji data, categories, preview logic
- All CSS styling (moved `.emoji-picker` positioning to `:global()` selector targeting bits-ui's `[data-popover-content]` attribute)

### Behavioral Changes
- Click-outside-to-close now handled by bits-ui (was manual backdrop)
- Escape-to-close now handled by bits-ui (was App.svelte global handler)
- Search input auto-focuses on open via `onOpenAutoFocus`
- `open` defaults to `true` -- component is designed to mount open (App.svelte uses `{#if showEmojiPicker}` conditional rendering)

### Backward Compatibility
- App.svelte's existing usage pattern (`{#if showEmojiPicker} <EmojiPicker onSelect={...} onClose={...} />`) works unchanged
- `onClose` is called via `onOpenChange` when bits-ui detects close (click outside or escape)
- The `open` prop can optionally be bound for fully controlled usage from either trigger (input emoji button or React on messages)

## Verification

- `npx vite build` passes cleanly (no errors, only pre-existing warnings)
