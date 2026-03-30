# Connection Banner Dismiss/Auto-Hide Fix

**Date:** 2026-03-30
**Commit:** ad58db5
**File:** `web/src/components/ConnectionStatus.svelte`

## Problem
The "Establishing secure connection" banner persisted indefinitely with no way to dismiss it, wasting vertical space and flagged in the screenshot audit.

## Changes
1. **Dismiss button (X)** added to connecting and error banners -- uses lucide `X` icon, subtle styling that brightens on hover
2. **Auto-hide on connect** -- the "Connected" banner auto-fades after 3 seconds instead of persisting forever
3. **State reset on change** -- if the connection state changes (connected to disconnected or vice versa), the dismissed flag resets so users see new status info

## Implementation Details
- Added `dismissed`, `autoHide`, `autoHideTimer`, `prevConnected` state variables
- An `$effect` watches `connected` changes, resets `dismissed`/`autoHide`, and starts a 3s timeout for the connected banner
- `dismiss()` function sets `dismissed = true` and cleans up timers
- Dismiss button styled with `.dismiss-btn` class -- transparent background, inherits banner color, hover reveals

## Verification
- Build passes cleanly (no new warnings)
- Pushed to main
