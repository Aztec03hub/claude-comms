# Overnight Final Placeholders Fix

**Date:** 2026-03-30
**Scope:** Three MEDIUM priority items from placeholder audit

---

## Items Fixed

### 1. Toast toggle verification (audit #9) -- ALREADY WORKING
- **Status:** Verified, no changes needed
- App.svelte line 127 already checks `store.inAppToasts` before calling `addToast()`
- SettingsPanel `toggleInAppToasts()` properly sets `store.inAppToasts`
- Muted channel check (`ch.muted`) also already in place

### 2. Theme toggle in Settings Panel (audit #10)
- **Files:** `web/src/components/SettingsPanel.svelte`, `web/src/App.svelte`
- Replaced read-only "Current Theme" badge with a functional Dark Mode toggle switch
- Added `onToggleTheme` prop to SettingsPanel, wired to App.svelte's `toggleTheme()`
- Reuses existing toggle-switch CSS (consistent with notification toggles)
- Removed unused `.theme-badge` CSS class

### 3. markUnread persistence (audit #19)
- **File:** `web/src/lib/mqtt-store.svelte.js`
- Added `#saveUnreadMarkers()` -- serializes `unreadFrom` + `unread` count to localStorage via `safeStorage`
- Added `#restoreUnreadMarkers()` -- reads markers back on `connect()` startup
- `markUnread()` now calls `#saveUnreadMarkers()` after setting channel state
- `switchChannel()` now clears `unreadFrom` and persists the cleared state
- Uses existing `safeStorage` wrapper for graceful fallback in private browsing

## Build
- `npm run build` passes cleanly (no new warnings)
