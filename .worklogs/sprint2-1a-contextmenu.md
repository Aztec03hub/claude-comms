# Sprint 2 - Agent 1A: ContextMenu bits-ui Migration

**Date:** 2026-03-29
**File:** `/home/plafayette/claude-comms/web/src/components/ContextMenu.svelte`
**Status:** Complete

## What Changed

Replaced the hand-rolled context menu with bits-ui's `ContextMenu` primitive components:

- `ContextMenu.Root` -- controlled via `bind:open` with `onOpenChange` callback
- `ContextMenu.Trigger` -- invisible 1px div; synthetic `contextmenu` event dispatched on mount to set virtual positioning anchor at (x, y) coordinates
- `ContextMenu.Content` -- replaces the manual `.context-menu` div; uses floating-ui for viewport-aware positioning and collision avoidance
- `ContextMenu.Item` -- replaces `<button class="ctx-item">`; adds `role="menuitem"`, arrow key navigation, Enter/Space activation, `data-highlighted` state
- `ContextMenu.Separator` -- replaces `<div class="ctx-divider">`

## Keyboard Accessibility Gains

- Arrow Up/Down navigates between menu items (via bits-ui's `loop` prop)
- Enter/Space activates the focused item
- Escape closes the menu (via bits-ui's EscapeLayer, listens on document)
- Click outside closes the menu (via bits-ui's DismissibleLayer)
- Focus is trapped within the menu while open

## Preserved

- All `data-testid` attributes: `ctx-reply`, `ctx-forward`, `ctx-pin`, `ctx-copy`, `ctx-react`, `ctx-unread`, `ctx-delete`, `context-menu`
- CSS classes: `.context-menu`, `.ctx-item`, `.ctx-divider`, `.ctx-kbd`, `.ctx-item.danger` (passed via `class` prop)
- `onAction` and `onClose` callback props with identical signatures
- All SVG icons and label text unchanged
- Visual appearance: same colors, spacing, borders, shadows, animations

## CSS Strategy

Styles use `:global([data-context-menu-*])` selectors targeting bits-ui's data attributes (`data-context-menu-content`, `data-context-menu-item`, `data-context-menu-separator`). Added `[data-highlighted]` selector for keyboard navigation highlight state matching the existing hover style.

## Architecture Notes

- The component is still conditionally rendered by App.svelte via `{#if contextMenu.show}`
- On mount, a synthetic `contextmenu` MouseEvent with the correct `clientX`/`clientY` is dispatched on the trigger element, which sets bits-ui's internal virtual positioning anchor
- bits-ui's Content uses floating-ui to position relative to this virtual anchor with collision avoidance (replaces the manual viewport clamping)
- Items changed from `<button>` to `<div>` (bits-ui default) with proper ARIA roles
- Escape handling: bits-ui's EscapeLayer fires first (document listener), then App.svelte's window handler; both are safe due to state guards

## Verification

- `npx vite build` passes cleanly (no errors, no new warnings)
- Only the ContextMenu.svelte file was modified
