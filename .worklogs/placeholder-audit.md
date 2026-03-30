# Placeholder and TODO Audit

**Date:** 2026-03-29
**Scope:** Full codebase (`src/`, `web/src/`, README)
**Auditor:** Claude (automated)

---

## Summary

Found **25 placeholders, stubs, and incomplete features** across the Python backend and Svelte web frontend. The most impactful gaps are: the web server is never actually started by the daemon, the `claude-comms mcp` CLI command referenced in the README doesn't exist, forwarding and file sharing show "coming soon" toasts, search filters are decorative, and several settings don't persist or take effect.

---

## Findings

| # | File | Line | Placeholder | Real Implementation Needed | Effort | Priority |
|---|------|------|-------------|---------------------------|--------|----------|
| 1 | `src/claude_comms/cli.py` | 215 | Comment says "MCP server placeholder -- will be wired once mcp_tools.py exists"; daemon only prints the MCP address but never starts the MCP server process | Daemon `start` should actually launch `mcp_server.start_server()` as an async task alongside the broker | Medium | **High** |
| 2 | `src/claude_comms/cli.py` | 221-226 | Web server section only prints "Web UI available at..." but never starts an HTTP server to serve the Svelte app | Add a static file server (e.g., `aiohttp` or `hypercorn`) that serves the built `web/dist/` on the configured port | Medium | **High** |
| 3 | `src/claude_comms/cli.py` | N/A | README references `claude-comms mcp` command (`"args": ["mcp"]`) but no `mcp` subcommand exists in the CLI | Add `@app.command() def mcp()` that runs `mcp_server.start_server()` in foreground (for Claude Code to launch as a subprocess) | Small | **High** |
| 4 | `web/src/App.svelte` | 161 | Forward action copies text to clipboard then shows toast "Forwarding coming soon" | Implement a channel-picker dialog, then call `store.forwardMessage(message, targetChannel)` (store method already exists) | Medium | **Medium** |
| 5 | `web/src/components/MessageInput.svelte` | 53 | File attach button shows "File sharing coming soon" notice instead of uploading | Implement file upload (either via MQTT binary messages or a companion HTTP endpoint), store as attachment metadata on messages | Large | **Medium** |
| 6 | `web/src/components/SearchPanel.svelte` | 9-13 | Search filter tabs (All, Messages, Files, Code, Links) are rendered and toggle `activeFilter` state, but the filter value is never used in `handleSearch()` -- all filters return the same results | Wire `activeFilter` into `store.searchMessages()` to filter by message type (requires message type detection for code blocks, links, files) | Medium | **Medium** |
| 7 | `web/src/components/Sidebar.svelte` | 30-31 | Sidebar search input with Cmd+K hint is a static `<input>` with no `oninput`, `bind:value`, or event handler -- typing does nothing | Wire to a filter function that narrows the channel list, or open the SearchPanel on focus/Cmd+K | Small | **Medium** |
| 8 | `web/src/components/SettingsPanel.svelte` | 10-14 | Display name change in settings updates local `$state` and `store.userProfile.name` but never persists to `localStorage` | Add `localStorage.setItem('claude-comms-user-name', displayName)` in `handleNameChange()` so the name survives page reload | Small | **High** |
| 9 | `web/src/components/SettingsPanel.svelte` | 8, 27-29 | `inAppToasts` toggle is local state only -- toggling it has no effect on whether toasts actually appear (App.svelte always shows them) | Expose `inAppToasts` via the store or a shared context; App.svelte should check before calling `addToast()` | Small | **Medium** |
| 10 | `web/src/components/SettingsPanel.svelte` | 104-106 | Theme/Appearance section shows current theme as read-only text; no way to change theme from settings | Add a toggle or dropdown that calls the theme toggle function (currently only accessible via the header icon) | Small | **Low** |
| 11 | `web/src/components/ProfileCard.svelte` | 36 | "View Profile" button opens the settings panel as a workaround (`showSettingsPanel = true`) instead of showing an actual profile page | Implement a dedicated profile view/modal showing participant details, activity, recent messages | Medium | **Low** |
| 12 | `web/src/components/ReadReceipt.svelte` | 1-12 | ReadReceipt component exists and is rendered on sent messages, but `message.read_by` is never populated -- no read receipt tracking in MQTT store | Implement read receipt publishing (MQTT topic per channel for read cursors), subscribe and update `read_by` on messages | Large | **Low** |
| 13 | `web/src/components/LinkPreview.svelte` | 1-11 | LinkPreview component accepts `domain`, `title`, `description` props but is never rendered anywhere -- no URL detection or metadata fetching | Add URL regex detection in MessageBubble; fetch Open Graph metadata (requires a proxy/backend endpoint since browser CORS blocks direct fetches) | Large | **Low** |
| 14 | `web/src/components/FileAttachment.svelte` | 1-25 | FileAttachment component renders a download card but `url` defaults to `'#'` -- no file upload/storage system exists | Ties to item #5: needs file upload backend, storage, and URL generation | Large | **Low** |
| 15 | `src/claude_comms/mcp_server.py` | 186-192 | `_noop_publish` placeholder raises `ConnectionError` when MCP server runs standalone (not wired to broker) | This is replaced at runtime when the MQTT subscriber connects (line 383); however, the standalone `start_server()` path should handle graceful degradation | Small | **Low** |
| 16 | `src/claude_comms/config.py` | 52 | `notifications.hook_enabled` config option is defined but never read by any code | Hook installer should check this flag and skip installation when `False` | Small | **Medium** |
| 17 | `src/claude_comms/config.py` | 53 | `notifications.sound_enabled` config option is defined but never read by any code | Implement sound notification support in TUI and/or web UI, gated by this config flag | Medium | **Low** |
| 18 | `web/src/lib/mqtt-store.svelte.js` | 337-339 | `deleteMessage()` only removes from local array -- deletion is not published to MQTT, so other clients still see the message | Publish a deletion event to a dedicated MQTT topic (e.g., `conv/{channel}/deletes`); other clients should subscribe and remove | Medium | **Medium** |
| 19 | `web/src/lib/mqtt-store.svelte.js` | 324-329 | `markUnread()` sets local state but doesn't persist across page reloads or sync to other devices | Persist unread markers in localStorage or publish to MQTT for cross-device sync | Small | **Low** |
| 20 | `web/src/lib/mqtt-store.svelte.js` | 345-348 | `muteChannel()` toggles local muted flag but the flag isn't checked anywhere -- muted channels still show notifications/toasts and increment unread count | Check `ch.muted` before incrementing unread (line 498) and before showing toasts in App.svelte | Small | **Medium** |
| 21 | `web/src/lib/mqtt-store.svelte.js` | 403-429 | `addReaction()` only updates local state -- reactions are not published to MQTT, so other clients don't see them | Publish reaction events to MQTT (e.g., `conv/{channel}/reactions`); subscribe and merge on receive | Medium | **Medium** |
| 22 | `web/src/lib/mqtt-store.svelte.js` | 436-443 | `togglePin()` only updates local state -- pins are not published to MQTT, so other clients don't see pinned messages | Publish pin/unpin events to MQTT with retain; subscribe and sync | Medium | **Low** |
| 23 | `web/src/App.svelte` | 343-347 | `onViewProfile` callback opens settings panel instead of a real profile view -- misleading UX | Same as #11: implement a real profile page/modal | Medium | **Low** |
| 24 | `web/src/components/Sidebar.svelte` | 26 | Version badge shows hardcoded "v0.9" while `__init__.py` says version is "0.1.0" | Read version from a shared constant or build-time injection | Small | **Low** |
| 25 | `src/claude_comms/__init__.py` | 3 | `__version__ = "0.1.0"` while sidebar shows "v0.9" -- version mismatch | Reconcile to a single source of truth (probably pyproject.toml) | Small | **Low** |

---

## Priority Summary

### High Priority (block core functionality)
- **#1** -- Daemon doesn't start MCP server
- **#2** -- Daemon doesn't start web server
- **#3** -- Missing `claude-comms mcp` CLI command (README promises it)
- **#8** -- Settings name change doesn't persist

### Medium Priority (broken or fake features)
- **#4** -- Forward action is a stub (toast only)
- **#6** -- Search filters are decorative (non-functional)
- **#7** -- Sidebar search input does nothing
- **#9** -- Toast toggle doesn't affect behavior
- **#16** -- `hook_enabled` config never checked
- **#18** -- Message deletion is local-only
- **#20** -- Channel mute flag is never checked
- **#21** -- Reactions are local-only

### Low Priority (nice-to-have, incomplete features)
- **#5** -- File sharing not implemented
- **#10** -- Theme not changeable from settings
- **#11/#23** -- "View Profile" is a workaround
- **#12** -- Read receipts never populated
- **#13** -- LinkPreview never rendered
- **#14** -- FileAttachment has no backend
- **#15** -- Noop publish graceful degradation
- **#17** -- Sound notifications not implemented
- **#19** -- Mark unread doesn't persist
- **#22** -- Pins are local-only
- **#24/#25** -- Version mismatch

---

## Recommended Dispatch Order

1. **Batch 1 (High):** Items #1, #2, #3 -- Wire daemon to actually start MCP server and web server; add `mcp` CLI command
2. **Batch 2 (High + Quick Wins):** Items #8, #7, #20, #16 -- Small fixes that make existing features work correctly
3. **Batch 3 (Medium UX):** Items #4, #6, #9 -- Forward dialog, search filters, toast settings
4. **Batch 4 (MQTT Sync):** Items #18, #21, #22 -- Make delete/reactions/pins broadcast over MQTT
5. **Batch 5 (Large Features):** Items #5, #12, #13 -- File sharing, read receipts, link previews
