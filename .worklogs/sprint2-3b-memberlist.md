# Sprint 2 Batch 3 - Agent 3B: Member List Toggle & Search

## Scope
- `App.svelte` - Add `showMemberList` state and wire header members count pill toggle
- `MemberList.svelte` - Add member search functionality

## Changes Made

### App.svelte
- Added `let showMemberList = $state(true)` state variable
- Wired `onclick={() => showMemberList = !showMemberList}` on the `header-members` button (`data-testid="header-members-count"`)
- Wrapped `<MemberList>` render in `{#if showMemberList}` conditional

### MemberList.svelte
- Added state: `let showSearch = $state(false)` and `let searchQuery = $state('')`
- Added `$derived` filtered arrays: `filteredOnline` and `filteredOffline` that filter by name when searchQuery is non-empty
- Wired search button with `onclick` toggle and `data-testid="members-search-btn"`
- Added search input bar (shown when `showSearch` is true) with `data-testid="members-search-input"`
- Replaced `online`/`offline` in template iteration with `filteredOnline`/`filteredOffline`
- Section counts reflect filtered results; header total count remains unfiltered
- Added CSS for `.members-search-bar` and `.members-search-input` with focus styling
- Clearing search query when search is toggled off

## Verification
- `npx vite build` passes successfully (no new warnings from our changes)
