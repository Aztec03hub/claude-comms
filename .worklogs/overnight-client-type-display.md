# Overnight: Client Type Display in Member List

**Date:** 2026-03-30
**Status:** Complete

## Summary

Instead of merging all clients from the same identity into one entry, each client connection now shows separately with its client type displayed as a subtle badge next to the participant name (e.g., "Phil (web)", "Phil (tui)", "claude-orchestrator (mcp)").

## Changes

### Web UI (`web/src/lib/mqtt-store.svelte.js`)
- Presence payloads now include `client: "web"` field
- LWT (Last Will and Testament) topic uses `key-web` suffix for per-client cleanup
- Self-participant added to map under `key-web` composite key
- `#handlePresence` uses `msg.key + '-' + msg.client` as participant map key
- `#handleParticipantRegistry` uses same composite key pattern
- Only skips own presence when `client === 'web'` (allows seeing own TUI/MCP connections)

### Web UI (`web/src/components/MemberList.svelte`)
- Added `<span class="member-client">` badge next to member name in both online/offline sections
- Styled as 9px muted lowercase text
- Svelte `{#each}` keyed lists use composite `key-client` to avoid collisions
- Member name uses flex layout to accommodate the client badge inline

### TUI (`src/claude_comms/tui/app.py`)
- `_publish_presence` includes `"client": "tui"` in payload
- System topic uses `key-tui` suffix
- Self-participant registered with `key-tui` composite key
- `_handle_presence` extracts `client` field and passes `client_type` to participant list
- Participant map keys use `key-client` pattern

### TUI (`src/claude_comms/tui/participant_list.py`)
- `ParticipantItem` accepts `client_type` parameter
- Display label shows client type in dim text: `name (tui)`, `name (web)`, etc.
- `set_participant` passes `client_type` through to items

### MCP Server (`src/claude_comms/mcp_server.py`)
- `comms_join` presence payload includes `"client": "mcp"`
- System topic uses `key-mcp` suffix

## Verification
- Web build: passes
- Python tests: 714 passed
- Coordinated with unified identity agent (ababe3ca4ae3a3031) changes
