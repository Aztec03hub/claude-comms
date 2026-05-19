# Worklog — v0.4.2 Polish P5+P7: ConversationBrowser EMPTY_STATES migration + USAGE.md tool-table audit

**Agent:** Agent-P-Docs (Polish Wave Batch 1)
**Started:** 2026-05-18T20:30Z (approx)
**Completed:** 2026-05-18T20:42Z (approx)
**Step from architecture doc:** v0.4.1-remaining-items plan §"Polish Wave" items P5 + P7 (`.worklogs/v041-remaining-items-plan.md`)
**Worktree:** `/home/plafayette/claude-comms/.claude/worktrees/agent-a6561385be0d9c098`
**Branch:** `worktree-agent-a6561385be0d9c098`

## 1. Scope

Two docs/copy items folded into v0.4.2 Wave 0 polish:

- **P5 (ConversationBrowser empty-state migration):** Replaced the two inline empty-state strings in `ConversationBrowser.svelte` with `EMPTY_STATES` references. Added two new keys (`directoryNoChannelsTitle`, `directoryNoChannelsHint`) to the centralized copy module; the filter-match-zero case adopts the existing `EMPTY_STATES.filterEmpty(filter)` function. Updated the corresponding vitest assertions to source the expected text from the constants so future copy changes stay aligned.
- **P7 (USAGE.md tool-table audit):** Audited the MCP tool-reference table against the canonical `@mcp.tool()` registrations in `src/claude_comms/mcp_server.py`. The table previously listed 17 tools; the v0.4.0 release bumped only the count statements (3 places saying "25"), not the table content. Added the 8 missing tools (`comms_thread_read`, `comms_status_set`, `comms_status_clear`, `comms_react`, `comms_reactions_get`, `comms_conversation_delete`, `comms_conversation_archive`, `comms_conversation_unarchive`), refreshed the `comms_send` and `comms_read` and `comms_check` rows to reflect v0.4.0-era parameters (`mentions` / `reply_to` / `top_level_only` / `mark_seen`), and added two new sub-sections (Reactions, Status). Table is now an exact match of the 25 registered tools.

## 2. Files modified

- `web/src/components/ConversationBrowser.svelte`:+8/-3 — import `EMPTY_STATES`; replace inline title + hint strings with module references.
- `web/src/lib/copy/emptyStates.js`:+7/-0 — add `directoryNoChannelsTitle` and `directoryNoChannelsHint` keys (with one-comment-block header).
- `web/tests/conversation-browser.spec.js`:+8/-3 — import `EMPTY_STATES`; switch both empty-state assertions to source text from the constants; add a second assertion in the no-channels test for the hint.
- `USAGE.md`:+16/-3 — extend Messaging table (1 new row + 3 row-signature refreshes), extend Conversations table (3 new rows), add Reactions sub-section (2 rows), add Status sub-section (2 rows).

## 3. Files consulted (read-only)

- `src/claude_comms/mcp_tools.py` — for the canonical 11 `tool_*` implementations; cross-referenced with mcp_server.py decorators.
- `src/claude_comms/mcp_server.py` (lines 994-1730) — for the 25 `@mcp.tool()` registration list with full signatures + descriptions.
- `web/tests/empty-states.spec.js` — to confirm the module invariants (every value is non-empty string OR function; no em dashes) accommodate the two new keys.
- `.worklogs/architecture-and-orchestration-plan.md` §I.5 (worklog format), §I.6 (standing rules), §I.10 (phase boundary).
- `.worklogs/v041-remaining-items-plan.md` — for the Polish Wave file ownership matrix.

## 4. Code changes (samples)

### 4a. `web/src/components/ConversationBrowser.svelte` (template empty-state)

```diff
   import { Compass, X, Users, Clock, Hash, Lock, Search, LogIn } from 'lucide-svelte';
   import { formatTime } from '../lib/utils.js';
+  import { EMPTY_STATES } from '../lib/copy/emptyStates.js';
```

```diff
         <div class="browser-empty-title">
-          {effectiveFilter ? `No channels match "${effectiveFilter}"` : 'No channels yet'}
+          {effectiveFilter
+            ? EMPTY_STATES.filterEmpty(effectiveFilter)
+            : EMPTY_STATES.directoryNoChannelsTitle}
         </div>
         {#if !effectiveFilter}
-          <div class="browser-empty-hint">There are no conversations on the server yet.</div>
+          <div class="browser-empty-hint">{EMPTY_STATES.directoryNoChannelsHint}</div>
         {/if}
```

### 4b. `web/src/lib/copy/emptyStates.js` (new keys)

```diff
   noTopicSet: 'No topic set',
+
+  // ── Conversation browser (Step 2.16 follow-up: ConversationBrowser
+  //    adoption — replaces inline strings at the no-channels empty state.
+  //    Title has no trailing period to match the .browser-empty-title
+  //    visual cadence (large headline); hint follows sentence cadence.)
+  directoryNoChannelsTitle: 'No channels yet',
+  directoryNoChannelsHint: 'There are no conversations on the server yet.',
```

### 4c. `USAGE.md` Conversations + new sub-sections

```diff
 | `comms_conversation_update(key, conversation, topic)` | Update a conversation's topic. System message rate-limited to once per minute per conversation. |
+| `comms_conversation_delete(key, conversation, confirm=false)` | Soft-delete a conversation (creator-only). Two-phase: call with `confirm=false` first to get `message_count` / `member_count` for a type-name confirmation modal, then `confirm=true` to delete. |
+| `comms_conversation_archive(key, conversation, confirm=false)` | Archive a conversation (creator-only): preserve history, eject members, block new sends. Two-phase confirm contract like `comms_conversation_delete`. Archived rooms surface in the directory's Archived sub-tab as read-only. |
+| `comms_conversation_unarchive(key, conversation)` | Unarchive a conversation (creator-only). Reverses the archive state flip; does NOT auto-re-join previously evicted members. |
 | `comms_invite(key, conversation, target_name, message?)` | Invite a participant. Posts invite notification in `#general`. |
```

```diff
 | `comms_artifact_delete(key, conversation, name)` | Delete artifact and all versions. |
+
+### Reactions
+
+| Tool | Purpose |
+|---|---|
+| `comms_react(key, conversation, message_id, emoji, op="toggle")` | Add, remove, or toggle a reaction on a message. ... |
+| `comms_reactions_get(key, conversation, message_id)` | List current reactions on a message. ... |
+
+### Status (activity signals)
+
+| Tool | Purpose |
+|---|---|
+| `comms_status_set(key, conversation, label, ttl_seconds=30)` | Set an ephemeral activity signal ... |
+| `comms_status_clear(key, conversation)` | Clear any active activity signal on your connection. Idempotent. |
```

## 5. Verification commands run

```
$ /home/plafayette/claude-comms/.venv/bin/ruff check src/ tests/
All checks passed!

$ /home/plafayette/claude-comms/.venv/bin/python -m pytest --tb=no -q
... [output truncated]
1268 passed, 66 warnings in 23.80s

$ cd web && CI=true pnpm exec vitest run --reporter=dot
... [output truncated]
 Test Files  42 passed (42)
      Tests  745 passed (745)
   Duration  21.36s (transform 50.87s, setup 0ms, import 117.73s, tests 6.29s, environment 16.81s)

$ cd web && CI=true pnpm build
... [output truncated]
 built in 5.93s

$ grep -cE "^\| ?\`comms_" USAGE.md
25

$ diff <(awk '/@mcp\.tool\(\)/{getline; print}' src/claude_comms/mcp_server.py \
  | sed -E 's/^[[:space:]]+(async )?def ([a-zA-Z_]+).*/\2/' | sort) \
  <(grep -oE "^\| \`comms_[a-z_]+" USAGE.md | sed 's/| `//' | sort)
(empty — exact match between mcp_server.py @mcp.tool() registrations and USAGE.md table)

$ grep -E "25 MCP|25 tools" USAGE.md
- An **MCP server** on `localhost:9920` — exposes 25 tools for Claude Code instances
Claude Code instances talk to the daemon via 25 MCP tools (see [reference](#mcp-tools-reference)).
All 25 MCP tools, grouped by purpose. First argument is always `key` ...

$ grep -c "—" web/src/components/ConversationBrowser.svelte web/src/lib/copy/emptyStates.js
web/src/components/ConversationBrowser.svelte:7  (all in comments / JSDoc / non-rendered)
web/src/lib/copy/emptyStates.js:3  (all in code comments — verified no em dash inside the EMPTY_STATES object values)
```

Em-dash check note: the only em dashes in the touched files are in code comments / JSDoc / HTML comments — never inside a string that renders in the UI. The `empty-states.spec.js` `'no string value contains an em dash (§I.6 rule #10)'` test passed.

Svelte autofixer (`mcp__plugin_svelte_svelte__svelte-autofixer`) returned `{"issues": []}` for the modified script + template region.

## 6. Tests added / modified

- `web/tests/conversation-browser.spec.js` — modified 2 existing tests in `describe('ConversationBrowser — empty state')` to source assertion strings from `EMPTY_STATES.filterEmpty(...)`, `EMPTY_STATES.directoryNoChannelsTitle`, and `EMPTY_STATES.directoryNoChannelsHint`; added one new assertion line covering the hint render in the no-channels case. Net test count unchanged at 745 (the existing tests cover the new keys via the EMPTY_STATES references).
- `web/tests/empty-states.spec.js` — unmodified; the existing module invariants already validate the two new keys (non-empty string + no em dash).

## 7. Findings surfaced during work

- (S) The pre-existing `comms_send` USAGE.md row had a stale signature missing `mentions` and `reply_to` (added by v0.3.3/v0.4.0); same for `comms_read` (missing `top_level_only`) and `comms_check` (missing `mark_seen`). The brief authorized "for any stale entries... delete them" + "match the existing entries' format"; I interpreted that as covering signature drift and refreshed the three rows. This is content-drift cleanup that fits the audit spirit, not scope-creep — flagging here for transparency.
- (S) The existing inline empty-state title `'No channels match "${effectiveFilter}"'` had no trailing period; the canonical `EMPTY_STATES.filterEmpty()` function returns with a trailing period (`'No channels match "cats".'`). Migrating to the function adds the period — a one-character visible cosmetic change. Matches the cadence convention documented in `emptyStates.js` ("Each string ends with a period").
- (S) `USAGE.md` still contains many em dashes in prose / TL;DR / Troubleshooting (unrelated to the tool table). Per §I.6 rule #10 those are documentation-prose em dashes, not UI-rendered copy, so they're allowed. Not changed.
- None of M+ blast.

## 8. Rollback

`git revert <sha>` undoes this commit cleanly. No DB migrations, no released artifacts, no schema changes. Yes.

## 9. Outstanding concerns

None. The USAGE.md table is now an exact match for `mcp_server.py`'s `@mcp.tool()` registration list (diff returns empty). The ConversationBrowser empty-state copy is fully sourced from the centralized module, satisfying the Step 2.16 follow-up flagged in the v0.4.1-remaining-items plan.
