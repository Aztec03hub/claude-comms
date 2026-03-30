# Chat Testing Bugfixes

**Date:** 2026-03-30
**Scope:** 5 bugs found during live chat testing

## Bug 1: Errant backslash in mention prefix
**Files:** `web/src/lib/utils.js`

The MCP `comms_send` tool prepends `[@name] ` to targeted messages via `build_mention_prefix()`. The web UI's `parseMentions()` didn't recognize the `[...]` bracket wrapper, causing it to render as literal text (with visible brackets/backslash artifacts).

**Fix:** Added a regex strip of the `[@name1, @name2]` prefix at the top of `parseMentions()` before processing `@mention` segments. The bracket prefix is redundant in the web UI since we now show a targeted message indicator (Bug 2).

## Bug 2: No visual indicator for targeted messages
**Files:** `web/src/components/MessageBubble.svelte`

Messages with `recipients` set had no visual distinction from broadcast messages.

**Fix:** Added `isTargeted` derived state. When true, renders a lock icon + "Targeted message" label above the bubble, and applies a dashed border + muted background style (`.bubble-targeted`). Imported `Lock` from lucide-svelte and `CodeBlock` component.

## Bug 3: Code blocks not rendering
**Files:** `web/src/components/MessageBubble.svelte`

Triple-backtick fenced code blocks rendered as plain text. The `CodeBlock.svelte` component existed but was never used.

**Fix:** Refactored `parseBody()` to first split on fenced code blocks (` ```lang\n...\n``` `) producing `codeblock` segments, then process remaining text segments for mentions and URLs. The template now renders `codeblock` segments with the `<CodeBlock>` component.

## Bug 4: Shift+Enter for newlines
**Files:** `web/src/components/MessageInput.svelte`, `src/claude_comms/tui/message_input.py`

**Web:** Changed `<input type="text">` to `<textarea rows="1">` with auto-resize. Enter sends, Shift+Enter inserts newline (native textarea behavior). Added `autoResize()` helper capped at 6 lines (144px). Updated CSS from `input` to `textarea` selectors with `resize: none`.

**TUI:** Switched from Textual's `Input` widget (single-line) to `TextArea` widget (multiline). Plain Enter submits, Shift+Enter inserts newline. Updated Tab completion to work with TextArea's `(row, col)` cursor API.

## Bug 5: Disconnected agents stay online
**Files:** `web/src/lib/mqtt-store.svelte.js`

MCP agents that disconnected remained in the participant list as "online" indefinitely.

**Fix:** Added TTL-based expiry in `#fetchParticipants()`. Each participant gets a `lastSeen` timestamp updated when the server reports them. On each poll (every 30s), participants not in the server response AND whose `lastSeen` exceeds 60 seconds are removed from the local map. The self web entry is never expired. Added static `PARTICIPANT_TTL_MS = 60000`.

## Verification
- `npm run build` passes cleanly (4.24s, no warnings)
