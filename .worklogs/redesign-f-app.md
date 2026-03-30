# Work Log: App.svelte Polling Bridge Update

**Agent:** F (App.svelte)
**Task:** Update polling bridge for participant system redesign
**Status:** COMPLETE

## Changes Made

**File:** `web/src/App.svelte`

Updated the `memberPoll` interval to detect connection changes, not just participant count changes. The old comparison only checked `length` of online/offline arrays. The new comparison also serializes and compares connection keys so that when a participant adds/removes a connection (e.g., opens a second tab or disconnects TUI), the MemberList re-renders with updated connection icons.

- `onlineChanged`: checks both length difference AND connection key content difference via `JSON.stringify` of flattened `Object.keys(p.connections || {})`
- `offlineChanged`: length check only (offline participants have no connections)

## Verification

- Vite production build passes cleanly
- No other references to `client` field in App.svelte (confirmed no other changes needed)
