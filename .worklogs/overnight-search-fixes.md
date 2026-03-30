# Overnight Search Fixes

**Date:** 2026-03-29
**Commit:** cb91bcf
**Audit items addressed:** #6 (search filter tabs decorative), #7 (sidebar search does nothing)

---

## Fix 1: Sidebar Search (Audit #7)

**File:** `web/src/components/Sidebar.svelte`

**Problem:** The sidebar search input had no event handlers -- typing did nothing.

**Fix (already in commit 591c1b0):**
- Added `searchQuery` state variable
- Bound search input to `searchQuery` with `bind:value`
- Created `filteredStarred` derived state that filters `store.starredChannels` by case-insensitive name match
- Updated `unstarredChannels` derived to also filter by `searchQuery`
- Updated template to use `filteredStarred` instead of `store.starredChannels` for the starred section
- When search query is empty, all channels show as normal

**Note:** This fix was already committed in 591c1b0 by a prior overnight session. Verified it is correct and complete.

---

## Fix 2: Search Panel Filter Tabs (Audit #6)

**File:** `web/src/components/SearchPanel.svelte`

**Problem:** The All/Messages/Files/Code/Links filter tabs set `activeFilter` state but the value was never used in search logic -- all tabs returned identical results.

**Fix:**
- Added `URL_REGEX` and `CODE_BLOCK_REGEX` constants for content type detection
- Added `applyTypeFilter(messages, filter)` function that filters search results by type:
  - `all` -- returns everything (existing behavior)
  - `messages` -- text-only messages (no code blocks, no URLs)
  - `files` -- messages with attachment markers (`msg.attachments` or `[file:`/`[attachment:` patterns)
  - `code` -- messages containing triple-backtick code blocks
  - `links` -- messages containing `http://` or `https://` URLs
- Updated `handleSearch()` to run `applyTypeFilter()` on results after `store.searchMessages()`
- Added `handleFilterClick()` that sets the filter AND re-runs the search (so clicking a tab immediately updates results)
- Wired filter tab buttons to `handleFilterClick()` instead of just setting state

---

## Additional Fix: ForwardPicker Build Error

**File:** `web/src/components/ForwardPicker.svelte`

**Problem:** Used Svelte 4 event modifier syntax (`onmousedown|stopPropagation`) which is invalid in Svelte 5, breaking the build.

**Fix:** Changed to `onmousedown={(e) => e.stopPropagation()}` (Svelte 5 pattern).

---

## Build Verification

Build passes cleanly after all changes.
