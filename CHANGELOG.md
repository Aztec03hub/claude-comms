# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.3] -- 2026-05-20

**Hotfix + comprehensive Playwright E2E suite + ThreadPanel drag-resize + new orchestration framework rule.** Phil's v0.4.2 Layer B real-browser smoke surfaced 5 user-visible regressions: a `state_unsafe_mutation` cascade originating from a lazy-cache write in `getChannelRole` (which aborted App.svelte's render tree mid-flight + cascaded to 4 visible symptoms), plus 2 production bugs discovered DURING the v0.4.3 E2E build (ChannelModal Create button swallowed under bits-ui focus-trap; ChannelAdminPanel topic-Enter double-fire wiping the topic), plus 1 unread-cursor persistence bug found by Phase 2 Agent C's spec-vs-code freshness audit (`#restoreUnreadMarkers` ran before `channelsById` was populated → dead code → unread cursor didn't survive tab close+reopen). All 5 fixed with regression-pin tests. ThreadPanel gained drag-resize (Phil's mid-Layer-B feature request, mirroring ArtifactPanel pattern). Comprehensive Playwright E2E suite covers all 12 of Phil's Layer B exercise scenarios (183 tests, screenshot baselines).

Also includes a NEW orchestration framework rule (§I.19 refine-as-you-go) that emerged directly from this hotfix's discipline: orchestrator must be hands-on with every subagent output, maintain a permanent per-phase iteration log, mutation-test test-writing agents' work, and refine each subsequent brief based on prior findings. Iteration log compounds patterns across the dispatch chain instead of rediscovering them each agent.

### Fixed (5 user-visible regressions)

- **`state_unsafe_mutation` cascade in `getChannelRole`** (`mqtt-store.svelte.js`). The accessor did a lazy-cache write (`this.channelRoles[channelId] = role`) that fired from a `$derived` evaluation context. Svelte 5 forbids `$state` mutations inside `$derived`; the throw aborted App.svelte's render tree mid-flight. Visible symptoms cascaded: (a) console error storm, (b) ChannelModal create + cancel buttons appeared broken (App didn't reach the modal mount cleanly), (c) ChatHeader 6 buttons appeared invisible (markup never reached DOM), (d) right-click on own username in MemberList threw + no menu appeared. **Fix**: make `getChannelRole` a pure read; move cache population to bootstrap (mirror of Wave G's `#prewarmNotificationPolicies` pattern). One root cause, four symptoms resolved.
- **ChannelModal Create button intermittently swallowed under bits-ui Dialog focus-trap** (`ChannelModal.svelte`). The focus-trap intercepts synthetic `click` events whose target element flips `disabled` in the same microtask. Every Playwright synthetic-click path was affected, and Phil's real-browser sessions saw it intermittently. **Fix**: wire `onpointerdown` alongside `onclick`; pointerdown fires before the focus-trap's interception. `submitting = $state(false)` latch dedupes the double-path; `e.button !== 0` rejects right-click.
- **ChannelAdminPanel topic-input fires `commitEditTopic` twice on Enter, wiping the topic** (`ChannelAdminPanel.svelte`). `onkeydown=Enter` set `editingTopic=false` (unmounting the input) and the unmount's `onblur` re-entered `commitEditTopic` with already-reset `topicDraft=''` → called `store.setTopic(id, '')`. **Fix**: `if (!editingTopic) return;` at the top of `commitEditTopic`. Same guard preventively applied to `commitRename` (sibling function with identical wire shape) per the §I.19 sibling-function bug shape scan.
- **Unread cursor doesn't survive tab close + reopen** (`mqtt-store.svelte.js`). `#restoreUnreadMarkers` USED to be called from `connect()` BEFORE `#bootstrapChannels` populated `channelsById`. The rehydration loop walked an empty map; localStorage cursor was effectively dead on cold load. **Fix**: move the call into the tail of `#bootstrapChannels`, after `channelsById` is populated. Surfaced by Phase 2 E2E Agent C's source-vs-code freshness audit.
- **App.svelte toast handler suppressed in-app toasts on muted channels regardless of mention** (v0.4.2 follow-through). Now policy-aware decision tree mirrors the browser-Notification gate (this fix actually shipped in v0.4.2 commit `942761d`; re-listed here for emphasis since Layer B confirmed the v0.4.2 behavior is correct).

### Added (UX features)

- **ThreadPanel drag-resize handle** (`ThreadPanel.svelte`). Mirrors ArtifactPanel's existing pattern: PointerEvents API + ARIA window-splitter (`role="separator"`, `tabindex`, `aria-valuenow/min/max`) + `setPointerCapture` + viewport-aware clamp + safeStorage wrapper + window-resize `$effect`. Three panel-tuned constants: `MIN_PANEL_WIDTH=280`, `MAX_PANEL_WIDTH=720`, `DEFAULT_PANEL_WIDTH=360`. Storage key `claude-comms:thread-panel-width` mirrors ArtifactPanel's naming convention. Keyboard a11y: ArrowLeft/Right nudges (`KEY_STEP=16`), Home/End jump to clamp extremes. Phil's mid-Layer-B feature request.

### Added (E2E test infrastructure)

- **Playwright E2E suite from scratch** at `web/e2e/`. Comprehensive coverage of all 12 of Phil's Layer B exercise items. 10 scenario specs:
  - `01-join-and-history.spec.ts` — Phil's #1 (`#general` history visible without explicit join; confirmed intentional lobby feature)
  - `02-create-channel.spec.ts` — Phil's #4 (ChannelModal create + cancel + sanitize-name)
  - `03-admin-actions.spec.ts` — Phil's #3 (cascade prevent) + admin actions (rename + visibility + mode + archive + delete + transferOwnership)
  - `04-member-context-menu.spec.ts` — Phil's #5 (right-click own username no error) + kick + mute-globally + DM
  - `05-invite-participant.spec.ts` — Phil's #6 (InviteParticipantDialog + 4xx error paths via `page.route()` intercept)
  - `06-status-editor.spec.ts` — Phil's #7 (StatusEditor popover + 4 expiry presets + clear)
  - `07-chat-header-buttons.spec.ts` — Phil's #8 (6 buttons visible + each toggles its panel)
  - `08-notification-policy.spec.ts` — Phil's #9 + #10 (kebab quickview cycle + highlight-words + browser-Notification gate)
  - `09-unread-divider.spec.ts` — Phil's #11 (UnreadDivider + IntersectionObserver 1s-dwell unread-clear)
  - `10-thread-panel.spec.ts` — Phil's #12 (close button + scrollbar overflow + drag-resize)
- **183 Playwright tests** (182 passing + 1 intentional skip due to sub-pixel screenshot flake documented as W-7 anti-pattern in iteration log; behavior fully covered by surrounding STATE assertions).
- **~25 screenshot baselines** committed to `web/e2e/__screenshots__/`. Visual regression detection via `expect(page).toHaveScreenshot()` with masked timestamps.
- **Per-test daemon fixture** with isolated `HOME=/tmp/cc-e2e-<random>` + port slots (MCP 9930+N*10, web 9931+N*10) + `node:sqlite` direct `registry.db` seeding + Playwright `consoleErrors` spy assertion (no `state_unsafe_mutation` across the full suite).
- **`web/e2e/README.md`** with run/regen/troubleshoot protocol.

### Added (orchestration framework)

- **§I.19 refine-as-you-go** (Phil-locked 2026-05-20, codified at `.worklogs/architecture-and-orchestration-plan.md` §I.19 + memory `feedback_refine_as_you_go.md`). For every multi-agent dispatch sequence, orchestrator must: (a) be hands-on with every subagent output (read worklog + skim diff + run gates), (b) maintain a permanent `.worklogs/<phase>-iteration-log.md`, (c) refine each subsequent brief based on prior agent findings, (d) mutation-test test-writing agents' work to confirm tests would actually catch the bug they were written to prevent. Composes with §I.16/§I.16.5/§I.17/§I.18 standing rules.
- **Pattern catalog** in `.worklogs/v043-iteration-log.md`: 11 ENFORCE patterns (P-1..P-9 + P-2a + P-3a covering source-level regex pins, cross-component invariant pins, dual-coverage, localStorage round-trip, console.error spy, cold-start verification, daemon filesystem reads, pre-click state assertions, sibling-function bug shape scan, triple-side prop-drill pins, `page.route()` capture-then-fulfill) and 7 AVOID patterns (W-1..W-7 covering unrestored window mutations, DOM-presence vs computed-visibility, tautological tests, `git add .` family, self-report without cold-start, workaround tests, cumulative test-file state without between-test reset). Available for future projects beyond claude-comms.

### Changed

- `web/playwright.config.js`: `testDir` changed from `./e2e` to `./e2e/scenarios`; removed Vite `webServer` (E2E daemons serve their own static bundle). `--workers=1` MANDATORY per [VERIFY-PHASE2B-1] (UI hardcodes MQTT WS port `9001` → all test daemons share the broker → can't run concurrently). Bake into config in v0.4.4.

### Known issues (deferred to v0.4.4)

- `--workers=1` mandate for E2E. Resolution: lift UI's hardcoded MQTT WS port + make it configurable so each test daemon binds distinct broker ports.
- `transfer-picker-open` screenshot intentionally skipped due to sub-pixel font rendering flake under cumulative test-file state (W-7). Behavior fully covered by surrounding state assertions.
- `apiPost` throws `Error('HTTP <status>')`; bleeds through to user-facing toasts via App.svelte's `msg = msg || 'fallback'` truthy-keep. UX cleanup.
- ArtifactPanel overlay intercepts pointer events on chat-header-artifacts-btn at 1280px+ viewports. Click-again-to-toggle fragile; close-via-own-X is canonical.
- `data-testid="artifact-panel-close"` duplicated in `ArtifactDetailHeader.svelte` and `ArtifactPanel.svelte`. Rename one.
- IntersectionObserver viewed-set state persists across channel switches. Production fix: reset `#viewedMessageIdsByChannel[id]` on channel-switch-out.

### Verified

- Pytest **1347 unchanged** (no Python regressions; v0.4.3 is frontend + test-infra only).
- vitest **1103 → 1107** (+4 from the unread-marker bugfix's regression-pin tests; +16 from bug-fix-mini's modal+topic Enter regression-pin tests = 1123 cumulative; the snapshot above is post-final-integration).
- Playwright e2e: 182 passing + 1 intentional skip out of 183 cold-start.
- ruff clean, build green, svelte-autofixer clean on every component touched.
- Manual two-layer smoke (per §I.10): Layer A install smoke runs after PyPI propagation; Layer B real-browser pass by Phil.

### Notes for upgraders

- No schema migrations; no data migration required.
- No MCP tool count change (stays at 30; v0.4.3 is bug fixes + UX feature + test infra).
- ThreadPanel will appear with a drag-resize affordance on the leading edge — drag to resize, or use ArrowLeft/Right when the handle is focused, or Home/End to clamp.
- If you were on v0.4.2 and hit any of the 5 fixed regressions, just upgrade + hard-refresh the browser (`Ctrl+Shift+R`) to load the new bundle.

## [0.4.2] -- 2026-05-19

**Admin actions + notifications + status presence + IntersectionObserver unread.** The originally-planned v0.4.1 admin-actions phase that the hotfix bumped here, expanded by Phil's Q6/Q7/Q8 + Archive UX lock-ins at decision gate G1. Largest functional release since v0.4.0: 28 commits, 5 new MCP tools, 2 new schema versions on participants, a new REST endpoint, end-to-end persistence for every admin button surfaced in v0.4.0's UI, and a Slack/Discord-style IntersectionObserver-based unread model that replaces the v0.4.0 "switch-clears-unread" semantics. Also includes a real bug fix for a live-MQTT mention-derivation gap that affected mention-dot rendering in v0.4.0/v0.4.1.

### Q-decisions locked at G1 (2026-05-13)

- **Q6 admin role model**: explicit `role` field per channel (`owner|admin|member`); creators of pre-existing channels grandfathered as `owner` via idempotent backfill. Replaces v0.4.0's implicit "is this the createdBy" heuristic.
- **Q7 notification policy granularity**: ship `All`/`Mentions`/`Off` PLUS per-channel `highlight-words` array. Substring match on incoming message body raises `unreadHasMention=true` even without formal @-mention.
- **Q8 mute UI placement**: keep inline mute icon + add kebab quickview row that shows current policy + 1-click cycles to next.
- **Archive UX**: extend `TypeNameConfirmDialog` with `severity: 'danger' | 'warning'` prop; warning short-circuits the typed-name gate. Archive uses warning (reversible); Delete keeps danger (typed name required).

### Added (admin actions, fully persisting end-to-end)

- **`ChannelAdminPanel.svelte`** mounted in `ChannelDirectoryModal`'s Admin tab. Role-gated visibility: `owner` sees Rename / Transfer Ownership / Set Visibility / Set Mode / Archive / Delete; `admin` sees Rename / Visibility / Mode / Archive (no Transfer, no Delete); `member` sees an empty-state. All destructive actions route through the shared `confirmDestructive` helper with appropriate severity.
- **`MemberContextMenu.svelte`** opens on right-click of any member row in `MemberList`. Actions: **Kick** (gated owner/admin via `store.getChannelRole`); **Mute globally** / **Unmute globally** (localStorage per the v0.4.0 Q4 pattern); **Start DM** (excluded for self). Destructive paths route through `confirmDestructive(severity='danger')`.
- **`InviteParticipantDialog.svelte`** opened via the new "Invite participant..." item in `ChannelContextMenu`. Search-as-you-type participant picker, optional note (200-char limit), wires to existing `comms_invite` MCP tool via the new POST `/api/invite` REST endpoint.
- **`StatusEditor.svelte`** opened from a new inline status row in `Sidebar` under the identity row. Emoji strip + free-text emoji input + 60-char text input with live counter + 4 expiry presets (Never / 1h / 4h / Until tomorrow). Status persists via new `comms_profile_status_set`/`_clear` MCP tools; broadcasts on the existing `claude-comms/presence/{key}/{connKey}` retained topic augmented with `profile_status_emoji/text/expires_at` keys. Auto-expire coroutine sweeps periodically.
- **`ChatHeader.svelte`** new component mounted at the top of `ChatView`, replacing the legacy inline header in `App.svelte`. Inline role-gated topic edit (click topic to enter input mode; Enter saves via `store.setTopic`; Esc cancels). Six button affordances restored from the legacy header: Search, Pinned, Artifacts, Settings, Theme toggle, Mobile menu.
- **`SystemMessageGroup.svelte`** collapses runs of 3+ consecutive system messages into a single expandable summary ("Alice joined, Bob left, Carol archived #general"). 1-2 consecutive system messages render inline as before.
- **`UnreadDivider.svelte`** inserts a "{N} new" separator between the last-read message and the first-unread message in `ChatView`. Position computed via the channel's `unreadFrom` cursor; self-hides when count is 0 or cursor not in viewport.
- **`ThreadPanel.svelte` refactored to use `MessageInput`** via a thread-scoped store proxy. Composer parity with the main channel: slash commands work in thread, emoji picker available, draft state preserved. Plus visible close button + proper scrollbar overflow on the reply list (UX requested mid-session).
- **`NotificationPolicyMenu.svelte`** opened from the kebab "Configure notifications..." item. All/Mentions/Off radio + comma-separated highlight-words text input. Q8 kebab quickview row above shows current policy + 1-click cycle. SidebarChannelRow renders bell variants (Bell for All, BellDot for Mentions, BellOff for Off) once bootstrap pre-warms the policy cache.

### Added (backend + protocol)

- **`tool_comms_kick(registry, *, key, conversation, target_key, ...)`** kicks a member from a channel. Caller must be `owner` or `admin` per `RegistryStore.get_channel_role`. Removes target's membership row; publishes a `[system]` message on the channel's MQTT topic.
- **`tool_comms_dm_open(registry, *, key, target_key, ...)`** synthesizes a deterministic DM slug `dm-{min(key,target_key)}-{max(key,target_key)}`. Idempotent: returns `{status: "existed"}` if the slug already exists, otherwise creates the channel with `visibility="private"` + `mode="invite"`, auto-joins both parties, and sets symmetric `owner` role for both.
- **`tool_comms_get_channel_role(registry, *, key, conversation, target_participant_key=None)`** thin MCP wrapper exposing the per-channel role API to the frontend. Returns `{role, participant_key, conversation}`. Caller must be a member of the conversation.
- **`tool_comms_profile_status_set(emoji, text, expires_at=None)`** + **`tool_comms_profile_status_clear()`** persist user-visible status on the participants table (`profile_status_emoji` / `_text` / `_expires_at`); broadcast augmented presence payload; auto-expire coroutine clears expired statuses. Renamed from the original `comms_status_set` after a pre-dispatch audit caught a collision with v0.4.0's existing ephemeral activity API at `mcp_tools.py:1198`.
- **POST `/api/invite`** REST endpoint bridges existing `comms_invite` MCP tool. Body `{conversation_id, invitee_key, note?}`; response `{invited, invitee_key, conversation_id}`. Returns 403 (caller not member), 404 (conv not found), 400 (malformed body / unknown invitee), 409 (invitee already member). CORS-coverage confirmed via the v0.4.1 `CORSMiddleware` wrap.
- **Extended `tool_comms_conversation_update`** now accepts optional `display_name` / `visibility` / `mode` / `created_by` kwargs alongside the existing `topic`. Multi-field updates apply atomically + send one combined system message. `name` (storage slug) is REJECTED with `_error` — rename is via `display_name`; slug stays immutable for MQTT topic stability. Validates `visibility in {"public","private"}` + `mode in {"open","invite"}`.
- **`ConversationMeta` schema extensions**: nullable `display_name` + `visibility` (default `"public"`) + `mode` (default `"open"`) fields. Backwards-compatible: existing meta JSON files load cleanly via Pydantic defaults.
- **`participants` table schema bumps**: v1 -> v2 adds `conversation_roles` association table (Q6 lock-in, with idempotent backfill that grandfathers creators as `owner`); v2 -> v3 adds nullable `profile_status_emoji` / `_text` / `_expires_at` columns (idempotent ALTER TABLE via `PRAGMA table_info` introspection).
- **`comms_check` on connect + visibility-regain** in the store. Batched per-channel unread fetch hydrates `channels[id].unread` / `unreadHasMention` / `lastActivity`. 30-second throttle on rapid `visibilitychange` events.

### Changed (UX semantics)

- **Unread is now viewport-confirmed, not channel-switch-cleared** (UX G-18). Switching to a channel no longer auto-zeros its unread count. Each message bubble is observed by a shared `IntersectionObserver`; after 1 second of dwell in the viewport, the message is marked seen. When all unread messages have been seen, the channel's unread zeros out. "Mark all as read" still forces immediate zero. Matches Slack/Discord behavior most users expect.
- **App-level browser Notification gate honors per-channel policy**. Browser `Notification` API no longer over-notifies on muted channels. Decision tree: `policy='Off'` never notifies; `policy='Mentions'` notifies only when `unreadHasMention` is true (formal mentions OR highlight-word matches); `policy='All'` notifies always except when channel is muted AND message is not a mention (mentions bypass mute for cross-channel awareness).
- **`unreadHasMention` derivation now fires on live MQTT messages, not just bootstrap**. v0.4.0 set this flag during `checkChannels` (bootstrap) but missed the live `#handleChatMessage` path; muted-channel mention dots were silent until the next bootstrap. Surgical fix in the live-MQTT handler.
- **Admin-action store accessors land with disconnected-state queuing**. `store.renameChannel` / `setVisibility` / `setMode` / `transferOwnership` mirror v0.3.3's `pendingSends` pattern from Polish P6's `forwardMessage`. On reconnect, queued operations flush in order.

### Fixed

- **App.svelte toast handler suppressed in-app toasts on muted channels regardless of mention**. Pre-fix: any message on a muted channel suppressed the toast, even @-mentions of the current user. Post-fix: policy-aware decision tree mirrors the browser-Notification gate above.
- **Mention dot on muted channels via live MQTT** (Design Spec §8.2 invariant). Same root cause as the toast handler — derivation only fired in bootstrap. Fixed in `#handleChatMessage`.

### Framework codifications (orchestration discipline)

Mid-flight process improvements codified into `.worklogs/architecture-and-orchestration-plan.md` §I.18 and the orchestrator memory `feedback_pre_dispatch_edge_map.md`:

- **§I.18 cross-codefile edge map** (Phil-requested 2026-05-13). For any wave of N>=2 parallel coding subagents, orchestrator produces a pre-dispatch artifact pinning the EXACT name + signature of every cross-file symbol (REST shapes, JSON-RPC method names, MQTT topics, DB columns, event-name strings, localStorage keys, CSS classes, function signatures). The pinned block is copy-pasted verbatim into every brief. Agents instructed to STOP and surface to orchestrator rather than improvise pinned names. Generalization of §I.17 stub-agent pattern (which only covered Svelte import-time edges) to ALL runtime-coupled edges.
- **§I.18 step 1.5: spec-vs-code freshness audit**. Before drafting any brief, run `git grep <each pinned name>` AND read the actual function/class/schema definition for every spec claim about existing code. Caught and resolved 3 stale-spec gotchas in v0.4.2: (a) `comms_status_set` name collision with v0.4.0's ephemeral activity API, renamed to `comms_profile_status_*`; (b) `comms_conversation_update` only accepted `topic` not the 5 fields the spec assumed, leading to a new Step 3.6b backend extension; (c) `ConversationMeta` lacked `visibility`/`mode` fields, also resolved in 3.6b.
- **§I.18 step 2b: old-value-set grep**. When extending a model field's value-set (e.g. visibility `'listed'/'unlisted'` placeholder to pinned `'public'/'private'`), also grep for existing hardcoded values from the OLD value-set across all consumer trees. Caught by a follow-up agent when the original audit missed the `_serialize_conversation_full` placeholder values.

### Verified

- Pytest **1268 -> 1347** (+79, zero regressions).
- vitest **745 -> 1061** (+316, +42% growth).
- ruff clean across `src/` + `tests/`.
- pnpm build green; svelte-autofixer clean on every component touched.
- Manual two-layer smoke (per §I.10): Layer A install + Layer B real-browser exercise of admin actions / member kebab / StatusEditor / ChatHeader buttons / Notification policy quickview.

### Notes for upgraders

- Schema migrations are idempotent: legacy v0.4.0/v0.4.1 SQLite registries auto-upgrade on first daemon start (v1 -> v2 -> v3). No data loss; missing columns default to nulls / safe values.
- The renamed `comms_status_*` to `comms_profile_status_*` distinction: the v0.4.0 ephemeral activity API ("looking at #channel" TTL ~30s) is UNCHANGED — same function names, same MQTT topic, same semantics. v0.4.2's NEW persistent profile-status tools live alongside under `comms_profile_status_*` names. Both APIs coexist; clients of the legacy activity API need no changes.
- Channel "rename" via the new Admin panel sets a `display_name` field; the underlying slug (used in MQTT topics + on-disk paths) stays immutable. Existing clients see the new display name in UI; topic subscriptions unchanged.
- Browser notifications now respect per-channel policy; if you previously relied on Notification spam, configure per-channel `Off` policy via the kebab.

## [0.4.1] -- 2026-05-13

**Hotfix.** v0.4.0 shipped with two showstopper bugs that surfaced as soon as Phil exercised channel operations from a fresh install: the web UI banner blinked between "Establishing secure connection" and brief connected flashes at ~10 Hz, generating 1500+ requests per minute, with no console output to suggest a fault. Two independent root causes, both in v0.4.1.

### Fixed

- **Infinite-loop init: App.svelte's `connect()` `$effect` re-fires on every store mutation** (`web/src/App.svelte`). The `$effect` block that called `store.connect()` on mount synchronously read `store.nameUnset` and `store.userProfile.*` (inside `connect()`, before the first await), and those reads were TRACKED by the surrounding effect. As soon as `connect()` later mutated those same fields during the identity fetch + name resolution, the effect's tracked deps changed and the effect re-ran, calling `connect()` again. The cleanup function tore down the half-formed WebSocket each cycle, so MQTT.js produced no console output (each connection died before its `on('connect')` handler could settle the UI state). v0.3.3 had the same `$effect` pattern but v0.4.0 expanded the `$state` surface in `connect()`'s sync portion (Steps 2.5 + 2.6 added `serverUnreachable`, `channelsById` map writes, more `userProfile` mutations) which is what tripped the loop. **Fix**: replace `$effect(() => { store.connect(); ... })` with Svelte's `onMount(() => { store.connect(); ... })`. `onMount` doesn't track anything; the init call runs once.
- **CORS gap on `/mcp` endpoint** (`src/claude_comms/cli.py`). The Starlette app returned by `FastMCP.streamable_http_app()` did not include CORS middleware. The REST `/api/*` routes had CORS handling via `_cors_headers()` from v0.3.0 onward; `/mcp` was a v0.3.3 addition (Step 1.9 SettingsPanel display-name) that bypassed that path. v0.4.0 then expanded browser-side MCP usage through the new `api.mcpCall` helper (`joinChannel`, `leaveChannel`, `setTopic`, `archiveChannel`, `deleteChannel`, `comms_conversation_update`), making the gap user-facing. **Fix**: wrap `starlette_app` with Starlette's `CORSMiddleware` after all `.routes.insert(...)` calls, reusing the same `cors_origins` list the REST routes already consume (loopback ports 9921 + Vite dev ports + optional `web.api_base`). Adds standard MCP headers (`Mcp-Session-Id`, `Mcp-Protocol-Version`) to the allowed-headers list.

### Verified

- Pytest 1268 (unchanged from v0.4.0; no Python regressions).
- vitest 745 (unchanged from v0.4.0; no JS test changes — fix is structural).
- Manual smoke required (browser-side timing bugs don't reproduce in jsdom). Verification post-install:
  1. `claude-comms stop && claude-comms start --background --web` after the upgrade
  2. Open the web UI; the "Establishing secure connection" banner should appear briefly (under a second) and then transition to "Connected — N participants online" without blinking
  3. DevTools Network tab should show ~5 initial requests followed by quiet idle (no per-second `conversations`/`identity` repetition)
  4. Try changing display name in Settings; should succeed (was blocked by CORS in v0.4.0)
  5. Try right-click a channel → Star, Mute, Leave — should all succeed
- ruff clean, build green.

### Notes for upgraders

If you were on v0.4.0 and saw the connection banner blinking + the web UI unresponsive: upgrade to 0.4.1 and **restart the daemon** (`claude-comms stop && claude-comms start --background --web`). Hard-refresh the browser (`Ctrl+Shift+R`) to load the new bundle. No data migration; no config changes.

The originally-planned "admin actions" phase moves from v0.4.1 to v0.4.2 in the architecture doc — the v0.4.1 slot now holds this hotfix only.

## [0.4.0] -- 2026-05-12

Three-section sidebar + full channel management + keyboard shortcuts + slash commands. Largest release since v0.3.0. **18 implementation steps shipped** (out of 21 planned; 3 deferred per Phil's Q-decisions before phase kickoff: server-side mute, channel preview, omnibar). **22 commits** since v0.3.3 ship; **+311 vitest tests** (+72% test growth); zero pytest regressions; zero shipped behavior regressions. Also includes 4 new orchestration-framework process improvements codified across the phase: pre-wave contract stub agents (§I.17), integration-agent pattern (§I.16.5), wave isolation (§I.16), and explicit-`git add` rules; all validated by real waves in this release. See `.worklogs/architecture-and-orchestration-plan.md` for the framework + every step's worklog.

### Added (sidebar + channel management)

- **Three-section sidebar** (Phil's headline feature). The single channel list is gone. Replaced with three always-visible sections (Starred / Active / Available), each with its own header, chevron, count badge, and inline empty-state copy. Sections never disappear even when empty (Phil's M-FIX invariant extended from MemberList to channels). Per-section collapse state persists in `localStorage`. (`SidebarChannelSection.svelte`, Step 2.9.)
- **Atomic `SidebarChannelRow.svelte`** rendering each channel with: mode glyph (Hash / Lock), name (bold when unread), member-count chip (hover or always-visible per section), topic preview (Available only), unread badge (mention-dot variant in `--ember-400` when `unreadHasMention` per Spec §8.2), mute icon, star icon (filled in Starred section, hover-visible elsewhere). Right-click opens context menu. (Step 2.8.)
- **Channel right-click context menu** (`ChannelContextMenu.svelte`, Step 2.10, Phil's CTX-MENU-NEW). 9 actions with visibility per `isMember` x `isCreator`: Star/Unstar, Mute (submenu: All / Mentions / Off), Mark all read, Copy link, **Leave** (members non-creators), **Close** (creators, archives per Q1 lock), Delete (creators), Channel info. Keyboard navigation, Escape closes, outside-click closes.
- **`LeaveChannelDialog.svelte`** (Step 2.11). Confirmation modal triggered only on heavy-investment leaves (over 50 messages sent, or pinned messages authored, or starred channel with auto-unstar warning). Light-investment leaves fall through silently. Focus trap, default-focus on Cancel button (destructive action; user actively picks Leave).
- **`ChannelDirectoryModal.svelte`** (Step 2.13, Phil's Ctrl+L). Full-screen modal with Browse and Admin tabs. Browse tab mounts the refactored `ConversationBrowser` with locked alphabetical sort (per Phil's SORT-LOCK), 4 sub-sections (Public listed / Public unlisted-accessible / Archived / My private channels), and live filter. Admin tab visible only when user owns 1+ channel; per-channel actions for v0.4.0 MVP: Edit topic, Archive, Delete. Modal a11y: focus trap, Escape closes, return focus to invoker.
- **`ConversationBrowser.svelte` dual mode** (Step 2.14). When used standalone (back-compat), renders with its own modal chrome + internal filter. When used embedded inside ChannelDirectoryModal, strips outer chrome + accepts `filterValue` / `sortKey` from parent.
- **15-second undo machinery** on `archiveChannel` + `leaveChannel` store methods. Each returns `{ done, cancel }`. The sidebar's leave/close handlers wire the envelope so users have 15 seconds to undo before the MCP call commits. Per Design Spec §4.1.

### Added (backend + store)

- **`comms_conversation_delete` MCP tool** (Step 2.2). Two-phase: `confirm=False` returns `{"error":"confirm_required", "message_count":N, "member_count":M}` for the type-name modal; `confirm=True` publishes a final retained `{"type":"deleted",...}` system message + retained-clears each member's presence + soft-deletes the registry row (preserves history on disk; future purge job hard-deletes).
- **`comms_conversation_archive` + `comms_conversation_unarchive` MCP tools** (Step 2.3, Phil's Q1=Archive+kick locked). Archive preserves history, sets `archived=True` + `archived_at`/`archived_by`, rejects new sends at the MCP layer (via `conv_data_dir` guard in `tool_comms_send`), retained-clears member presence. Unarchive flips state back; does NOT auto-re-join members per Spec §4.4.
- **`ConversationMeta` schema additions**: `deleted_at`, `deleted_by`, `archived_at`, `archived_by` fields + `mark_deleted`, `is_deleted`, `mark_archived`, `mark_unarchived` transition methods.
- **`/api/conversations` extended to full ChannelRow payload** (Step 2.1, Phil's S-FIX backend). Returns the daemon's full known conversation set (not just caller's memberships), with new fields per row: `member`, `memberCount`, `lastActivity`, `mode`, `visibility`, `createdAt`, `createdBy`, `myUnread`, `myStarred`, `myMuted`, `archived`, `archived_at`, `archived_by`.
- **`tool_comms_conversations(all=True)` surfaces archive fields** for the directory's Archived sub-tab routing.
- **Store bootstraps channels from `/api/conversations`** (Step 2.5, Phil's S-FIX web). Hardcoded seed channels removed. Edge cases handled: 0-rows takes channels to empty, 404/500 sets `serverUnreachable` reactive flag and a "Server unreachable" banner in App.svelte.
- **`channelsById` map + 4 `$derived` projections** in the store (Step 2.6): `starredChannels`, `activeChannels`, `availableChannels`, `archivedChannels`; all alpha-sorted per SORT-LOCK. 8 lifecycle methods: `joinChannel`, `leaveChannel`, `archiveChannel`, `deleteChannel`, `closeChannel` (delegates to archive per Q1), `setTopic`, `setMute` (localStorage per Q4 lock), `setStar` (localStorage).
- **Full system-event taxonomy handler** (Step 2.7) on `claude-comms/system/conversations`: `created`, `topic_changed`, `renamed`, `deleted`, `archived`, `unarchived`, `member_joined`, `member_left`. Defensive default branch logs structured + skips on unknown types. User-currently-viewing-this-channel switch logic for deletes + archives. New `latestChannelLifecycleToast` reactive field for the sidebar to consume.

### Added (power-user surface)

- **Keyboard shortcuts registry** (Step 2.17): `Ctrl+L` opens directory, `Ctrl+W` / `Ctrl+Shift+W` leaves current channel, `Ctrl+N` creates channel, `Ctrl+J` quick-join prompt, `Alt+1`-`Alt+9` jumps to Nth channel in Active section (alpha-sorted per SORT-LOCK), `?` opens keyboard-shortcuts help overlay. Focus-context rule: bindings only fire when no input/textarea is focused (Escape always fires).
- **12 slash commands** (Step 2.18): `/join`, `/leave`, `/list`, `/topic`, `/close`, `/star`, `/mute [all|mentions|off]`, `/me <action>`, `/clear`, `/help [command]`, `/who`, `/nick <new name>`. Inline error/ok toast feedback. Unknown command shows usage hint.

### Added (visual + polish)

- **4-phase reactive transitions** (Step 2.15, Design Spec §10). When a channel moves between sections (join, leave, star, close), the row fades out of the old section, gap collapses, gap grows in the new section, row fades in. ~900ms total. `prefers-reduced-motion: reduce` snaps instantly. Star toggle uses a shorter crossfade (~300ms).
- **Centralized empty-state copy module** (`web/src/lib/copy/emptyStates.js`, Step 2.16, Design Spec §11). 15 keys + 1 function (`filterEmpty(filter)`). Imported by MemberList, ChatView, ChannelDirectoryModal. Friendly, brief, actionable. Zero em dashes enforced by an automated test that scans the module.

### Changed

- **`Sidebar.svelte` rewritten as thin shell** (Step 2.12). 716 to 295 lines (-58.8%). Composes the new sidebar components (Section + Row + ContextMenu + LeaveChannelDialog). Logic that used to live in this file is now in the focused subcomponents.
- **MessageInput intercepts `/`-prefixed input** for slash-command routing (Step 2.18). Non-slash sends fall through to the regular publish path.
- **App.svelte wires three callback props** through the new Sidebar component chain (`onStarToggle`, contextual leave/close flows, slash-command `slashCommand` event listener).
- **USAGE.md MCP tool count** corrected from 17 to 25 (catch-up for v0.3.3 doc-drift plus the 3 new v0.4.0 tools). Full tool-table audit deferred to a follow-up docs pass.

### Verified

- Full pytest suite: **1268 passed** (unchanged from v0.3.3; no Python regressions despite extensive backend additions in Steps 2.1/2.2/2.3).
- vitest: **745 passed** (was 434 at v0.3.3 baseline). +311 net new tests across the 18 implementation steps.
- ruff check + format both clean.
- `pnpm build` produces `src/claude_comms/web/dist/` without warnings.
- Svelte autofixer: zero issues attributable to any v0.4.0 step across all edited files.

### Notes for upgraders

- The previous single-list sidebar is gone. After upgrading, you'll see three sections immediately. Channels you're a member of land in Active; channels you've starred land in Starred; channels you can join (but haven't) land in Available.
- Pressing `Ctrl+L` is the fastest way to find a channel by name (opens the directory modal). `Ctrl+N` creates one.
- Right-click any channel for the new context menu (Star, Mute, Mark read, Leave/Close, Channel info).
- Try `/help` in the composer for a list of slash commands.
- "Close" semantics: closing a channel ARCHIVES it (preserves history, kicks members, blocks new sends). The Archived sub-tab in the directory modal lets you find archived channels. Unarchive via `comms_conversation_unarchive` (MCP tool); UI surface for unarchive lands in v0.4.1.
- Mute is per-device (localStorage, per Phil's Q4 decision). Cross-device mute sync lands in a future release if usage warrants.

## [0.3.3] -- 2026-05-12

Polish-and-safety release. Closes 4 UX showstoppers (no member-list section ever disappears; name changes propagate; over-limit sends are no longer silent; reconnect failures are actionable), the engineering critical from the v0.3.2 advisory (phantom-reactivity workarounds removed), and 8 long-tail UX gaps. Net 10 commits, 9 implementation steps + 1 prop-wiring follow-up. **vitest grew from 375 → 434 (+59 tests, +16%)** without a single pytest regression. Includes the Wave D race-condition incident that taught the orchestration framework about worktree isolation — surfaced as a process improvement, not a code bug.

### Fixed

- **Phantom-reactivity workarounds removed** (`web/src/components/ChatView.svelte`, `web/src/lib/mqtt-store.svelte.js`). A 100 ms `setInterval` pump in `ChatView` and two `this.messages = this.messages` self-assignment kicks in `mqtt-store` were cargo-cult workarounds for a Svelte 5 reactivity bug that doesn't exist. The principal-engineer Svelte advisory validated this via the official MCP autofixer; Svelte 5's class-based `$state` proxy tracks every read in a consuming `$derived`. ChatView now uses a single `$derived(store.activeMessages)`; the self-assignments are gone. (Eng C-1)
- **`web/src/lib/mqtt-store.svelte.js` `_len` cargo-cult reads** removed from inside `$derived.by` blocks. Same misunderstanding of Svelte 5 dependency tracking. Comments now reference the actual `$derived` semantics. (Eng R-1)
- **Default display name no longer "Phil"** for every new web client. Now `(unset)` until either `/api/identity` returns a non-empty name or the user sets one. App.svelte surfaces a one-line "Set a display name so others can recognize you" banner with a dismissible × (persisted under `claude-comms.nameBanner.dismissed`). (UX G-43)
- **Sending while disconnected no longer silently drops messages.** New `#pendingSends` FIFO queue (cap 100; drop-oldest with `failed` marker on overflow). On reconnect, drain in order. Each local message carries a `status: 'sending' | 'sent' | 'failed'` field; `MessageBubble.svelte` visualizes spinner / nothing / error icon + Retry button. Retry wires through App → ChatView → MessageGroup → MessageBubble to `store.retryMessage(id)`. (UX G-62)
- **Member list always shows three sections** (Active / Online elsewhere / Offline), even when empty. Phil's "M-FIX" constraint — sections are stable UI surfaces, not data-conditional. Each empty section renders friendly inline copy in `--text-muted`. Per-section collapse state persists in `localStorage` under three namespaced keys; the legacy `claude-comms.offlineExpanded` key migrates on first read.
- **Sidebar star toggle** now actually toggles. `handleStarToggle` was defined but never invoked from the channel-row template; hover-visible star icon now calls it with `event.stopPropagation()` to prevent the channel-switch from firing. `onStarToggle` prop drilling from App.svelte added; store-fallback ensures the button works even if a parent forgets to pass the prop. (UX G-4)
- **Sidebar version label** now derives from `web/package.json` via Vite's native JSON import, no more stale literal. Bumped `web/package.json` to 0.3.3 in lockstep. (UX G-5)
- **Sidebar `ustatus` binding** now reflects `store.connected` / `store.connectionError` via the same three-state palette as `ConnectionStatus.svelte` (online green, connecting amber, offline red). Was a hardcoded "Online" string. (UX G-25)
- **Notification toasts are clickable.** The card surface is now a `<button>`; click → `store.switchChannel(toast.channel)` + (if applicable) `store.goToMessage(toast.messageId)`. Close-X handler uses `stopPropagation` to keep its semantics. (UX G-13)
- **Toast cap and coalesce.** Maximum 3 visible toasts at any time. A 4th from the same channel coalesces in place to `"<sender> and N others sent messages"`; 5+ collapse to a compact `+N new in #channel` pill. Cross-channel 4th evicts the oldest visible toast (FIFO). 5-second self-destruct resets on each coalesce. (UX G-14)
- **MessageInput over-limit no longer silently no-ops.** When `inputValue.length > MAX_MESSAGE_LENGTH`, the send button is disabled, the textarea border turns `--ember-400`, and an inline error message above the composer surfaces `"Message too long ({over} over limit) - split or convert to artifact"` with a "Convert to artifact" CTA that copies the textarea contents to clipboard (the full artifact-create flow lands in v0.4.x). (UX G-28)
- **ConnectionStatus retry button** appears after 5 failed reconnects. Banner content shifts from indeterminate "Reconnecting to broker..." to actionable "Cannot reach broker - [Retry now] [Reload page]". Retry calls `store.connect()`; Reload calls `location.reload()`. Counter resets on successful connect. ARIA: `role="status" aria-live="polite"`. Wired from App.svelte. (UX G-27)
- **Display-name changes now propagate to the daemon** via the `comms_update_name` MCP tool. SettingsPanel's `handleNameChange` debounces (500 ms), guards on `store.connected`, calls the new `api.updateName(key, newName)` helper which POSTs JSON-RPC to the FastMCP `/mcp` endpoint, and reflects inline `Saving... -> Saved` / `Error: <reason>` status. Success path clears `nameUnset` + updates `store.userProfile.name`; failure reverts the input. Closes the silent identity-divergence showstopper. (UX G-9)

### Added

- **`#pendingSends` queue + per-message status** in `mqtt-store.svelte.js`, with public `retryMessage(messageId)` method and three test-only seam methods (`_installTestClient`, `_drainPendingSendsForTest`, `_pendingSendsLengthForTest`).
- **`Sidebar` `onStarToggle` prop**, **`ConnectionStatus` `onRetry` prop**, **`ChatView` `onRetryMessage` prop**, **`MessageGroup` `onRetryMessage` prop** — explicit callback props through the App → child chain, replacing implicit store-method calls.
- **`api.updateName(key, newName)` helper** (`web/src/lib/api.js`). POSTs JSON-RPC `tools/call` to `/mcp`. 5-second `AbortController` timeout. Handles both `result.structuredContent` and `result.content[0].text` response shapes. Returns `{success, name?, key?, error?}` envelope.
- **`store.nameUnset` reactive flag** — initialized `true`, cleared on successful identity fetch or successful `updateName`. Drives the App.svelte "Set a display name" banner.
- **Test coverage**: +59 vitest specs across 8 new spec files (`mqtt-store-pending-sends`, `sidebar-fixes`, `toast-improvements`, `member-list`, `message-input`, `connection-status`, `prop-drilling`, `settings-panel`). Each step's verification gate included Svelte MCP autofixer at zero issues.

### Changed

- **`MessageBubble.svelte`** — new visual states for `sending` / `sent` / `failed`. Failed state shows an icon + "Failed to send" + Retry link that fires `onRetry(message.id)`.
- **Removed `web/src/lib/_alt/` directory** — abandoned `mqtt-store-v2.svelte.js` exploration. Reader-confusion liability flagged in the principal-engineer advisory; gone now. (Eng O-2)

### Verified

- Full pytest suite: **1207 passed** (unchanged from v0.3.2; no backend changes in v0.3.3).
- vitest: **434 passed** (was 375; +59 net new across 8 new spec files).
- ruff check + format both clean.
- `pnpm build` produces `src/claude_comms/web/dist/` without warnings.
- Svelte autofixer: zero issues attributable to any v0.3.3 change across all edited files.

### Notes for upgraders

- The "Set a display name" banner appears on first load when `userProfile.name === '(unset)'`. Dismiss is persisted; once you set a name, the flag clears.
- If you see the banner after upgrading from v0.3.2 with a previously-set name in localStorage, your daemon-side identity didn't return a name. Set one via Settings → it'll propagate via the new `comms_update_name` wiring.
- v0.3.3 ships with a Wave D race-condition recovery in the commit log: `952f427` carries Step 1.4's commit message but contains Step 1.5's files (toast improvements). Code state is correct; the misattribution is a permanent artifact per the "no amend" rule. Mitigation for future releases codified in the orchestration plan as worktree isolation for parallel agent waves.

## [0.3.2] -- 2026-05-12

Patch release. Closes Issues A and B from the v0.3.1 follow-up brief + extends the member list to a three-section model (active / online elsewhere / offline) with inline "in #X +N more" location chips for cross-channel visibility. Issue C (structured MQTT parse logger + empty-payload guard) already shipped in v0.3.1 — downstream users who still see the old `Failed to parse MQTT message:` floods are running the cached pre-v0.3.1 bundle and need a daemon restart plus a hard browser refresh.

### Fixed

- **Issue A — multi-channel members no longer get pruned when viewing a single channel** (`web/src/lib/mqtt-store.svelte.js:#fetchParticipants`). Prior behavior: the 30-second REST poll for the active channel ran a global prune that deleted every local participant not in the active channel's response. A worker who was a member of both `#general` and `#svelte-work` would vanish from a phil-viewing-`#general` session the moment the REST poll for `#general` landed — because the prune treated the active-channel snapshot as the source of truth for the **global** participant map. New behavior: the prune now skips any local participant who has at least one live connection (`Object.keys(p.connections).length > 0`). Ghosts from stale retained presence (the original reason the prune existed) still have empty connections and remain pruned correctly. Members of other channels stay visible because they have live MQTT connection records.
- **Issue B — new conversations created by another participant now appear in connected sidebars within ~1 second instead of requiring a full page refresh** (`src/claude_comms/mcp_server.py:publish_conversation_event` + `web/src/lib/mqtt-store.svelte.js:#handleSystemConversation`). Daemon now broadcasts conversation lifecycle events on a single non-retained MQTT topic `claude-comms/system/conversations` with payload `{type, name, topic?, creator_key?, ts}` where `type` is one of `conversation_created` / `conversation_topic_changed` / `conversation_deleted`. The web UI subscribes on connect and applies each event to the in-store `channels` array (immutable reassignment for Svelte 5 reactivity).
  - **Not retained** by design — these are point-in-time deltas. Retaining them would cause every reconnecting browser to re-process every historical event, including ones whose effects have since been undone. The REST `/api/conversations` snapshot remains authoritative for cold start.
  - Wired in: `comms_conversation_create` and `comms_conversation_update`. The `conversation_deleted` event is defined in the wire-format but not yet wired in — there's no `tool_comms_conversation_delete` endpoint to hook from. Will surface when delete is added.

### Added

- **Three-section MemberList** (`web/src/components/MemberList.svelte`). Replaces the prior binary online/offline split with:
  - **In #{channel}** — members of the currently-viewed channel who are online. The primary "who can I address right now" view.
  - **Online** (elsewhere) — participants connected globally but NOT joined to the active channel. Each row carries an inline `in #X` location chip showing the first (alphabetical) other channel they're a member of, plus a `+N more` cursor:`help` chip when N > 0. Hovering the row surfaces a multi-line `title` tooltip listing every channel they're in. Resolves the confusion Issue A's fix would otherwise introduce: now the user explicitly knows *why* a member is shown.
  - **Offline** — known participants with no live connections. Collapsed-by-default disclosure widget (`▶ Offline (N)`) — state persisted in `localStorage` under `claude-comms.offlineExpanded` so users who care about offline context stay expanded. Each offline row carries a `last seen Nm ago` relative-time stamp computed from `member.lastOffline`.
  - Within each section: alphabetical sort by name. Stable under churn; no visual jitter when many agents join / leave.
- **`channelMembers` reactive store state** (`mqtt-store.svelte.js`). Per-channel `{convId: {key: lastSeenTs}}` map, populated by two sources:
  1. REST poll of `/api/participants/{channel}` now returns a per-member `conversations` field (server-side change below). On each poll, every conv in each member's list gets the key recorded.
  2. Live MQTT presence — the conversation is extracted from the topic (`claude-comms/conv/{conv}/presence/{key}`) and passed to `#handlePresence(msg, conversation)` which records membership incrementally.
- **`/api/participants/{channel}` includes `conversations: string[]` per member** (`mcp_server.py:get_channel_participants`). Sorted list of every conversation each participant is a member of, from `ParticipantRegistry.conversations_for`. Drives the inline "in #X" chips without requiring a separate global endpoint.
- **`MqttChatStore.activeMembers` / `onlineElsewhere` `$derived.by()` derivations** + **`getMemberConversations(key)` helper method** — the data feeds for the three-section MemberList. The existing `onlineParticipants` / `offlineParticipants` derivations are kept; they back `onlineCount` and a few other consumers.
- **`publish_conversation_event` module-level helper** (`src/claude_comms/mcp_server.py`). Sibling to `publish_mcp_presence_on_join`. Accepts `event_type`, `name`, optional `topic`, optional `creator_key`. Constructs the canonical wire-format payload, publishes to `claude-comms/system/conversations` non-retained, swallows publish-side exceptions. Public surface; importable for tests.
- **`tests/test_conversation_events.py`** -- 6 tests pinning the wire format (topic, type field discrimination, optional-field handling for each of the 3 event types) and the non-retained + exception-swallowing contracts.

### Changed

- **MemberList props signature** — was `{online, offline, typingUsers, onShowProfile}`; now `{active, onlineElsewhere, offline, activeChannelName, getMemberConversations, typingUsers, onShowProfile}`. App.svelte's invocation updated to feed the three new arrays from the store's derivations.
- **App.svelte 500ms snapshot pump** — copies `store.activeMembers` + `store.onlineElsewhere` + `store.offlineParticipants` into local `$state` arrays (length + connection-key fingerprint diff to avoid noisy reassignments). Replaces the prior single-array online + single-array offline pump.
- **Member-row rendering shared via Svelte 5 snippet** — `{#snippet onlineRow(member, showLocation)}` at the top of MemberList renders both the "In #channel" and "Online (elsewhere)" sections from one template. The `showLocation` flag toggles the inline location chip on for the elsewhere section.

### Notes for upgraders

The structured MQTT parse logger and empty-payload guard from v0.3.1 are already live in the wheel. If your DevTools console is still spamming `Failed to parse MQTT message: SyntaxError: Unexpected end of JSON input`, the stack trace will show an asset hash other than `index-BWeN2qtA.js` (v0.3.1) or the v0.3.2 hash. That means either:

1. The daemon process is still pre-v0.3.1 in memory — run `claude-comms stop && claude-comms start --background --web` after the pip / pipx upgrade.
2. The browser cached the old `index.html` and is loading stale asset hashes — hard-refresh (`Ctrl+Shift+R`) or use an incognito window. After the daemon serves the new `index.html`, the new asset hashes will load fresh.

The v0.3.1 fix correctly silences empty-payload "parse failures" (retained-clear cleanups) and logs structured `[claude-comms] MQTT message parse failed` objects on real failures. Confirmed by inspecting the published wheel.

## [0.3.1] -- 2026-05-12

Patch release. Two correctness fixes surfaced during smoke testing of MCP-driven worker agents on v0.3.0, plus a structured-logging upgrade for future bug-report quality.

### Fixed

- **Bug 2 — MCP-joined participants (e.g. `svelte-worker`) now appear in the web UI participant list reliably.** Root cause: `comms_join` over MCP published presence to `claude-comms/conv/{conv}/presence/{key}` with `retain=False`. A web UI that connected AFTER the worker joined saw no retained presence and ghosted the worker until the 30s REST poll caught up. Web UIs that crashed or were reloaded mid-session lost workers entirely. Fixed by passing `retain=True` to both the conv-scoped and system-scoped presence publishes in `mcp_server.py:publish_mcp_presence_on_join`. The retained message survives until the worker disconnects (or the next daemon restart wipes broker-side retain state).
- **Latent `PublishFn` protocol mismatch** (`src/claude_comms/mcp_tools.py`, `src/claude_comms/presence.py`). The protocol declared `(topic: str, payload: bytes) -> None` but the real `_do_publish` implementation has `(topic, payload, retain=False)`. Pyright flagged this since 0.2.x but Python's duck typing accepted it at runtime. Became load-bearing once `retain=True` was actually being passed at MCP-side presence call sites. Protocol updated to match the real signature; `PublishSpy` test fixture in `tests/conftest.py` updated to record `(topic, payload, retain)` 3-tuples (and the six test sites that unpack from spy calls were migrated to 3-element unpacks).

### Added

- **Structured MQTT parse-failure logger** (`web/src/lib/mqtt-store.svelte.js`). Prior to this release every bad MQTT frame logged the same context-free `"Failed to parse MQTT message: <error>"` — undiagnosable. New `#receiveMqttFrame` method:
  - Silently skips **empty payloads** (retained-clear publishes / presence cleanup — these are routine broker-state ops, not parse failures, but were polluting the previous log with `Unexpected end of JSON input`).
  - On real JSON-parse failure, logs a structured object with `topic`, `payloadLength`, `payloadPreview` (first 500 chars + `[truncated, total=N]` if longer), `errorName`, `errorMessage`, and an ISO timestamp.
  - Continues rather than letting the exception bubble — one bad frame never freezes the message stream.
- **In-UI parse-failure banner** (`App.svelte`). Surfaces a soft-amber warning row when the parse-failure rate crosses ≥ 5 in any 30-second window. Pure observability; doesn't block the chat. Helps users notice connection issues / sender-side bugs without needing DevTools open.
- **`MqttChatStore.parseFailureRate` reactive state** + `#parseFailureTimestamps` private rolling window. Pruned on every update so stale entries age out without a separate timer.
- **`tests/test_mcp_presence.py`** (5 tests) — pins the retained-presence-on-join contract: publishes to both conv and system topics, every publish carries `retain=True`, payload contains all fields the web UI's `#handlePresence` destructures, helper swallows publish-side exceptions (best-effort).
- **`publish_mcp_presence_on_join` helper** (module-level in `mcp_server.py`). Extracted from the closure body of `create_server`'s `comms_join` tool so it can be unit-tested independently of the FastMCP wiring. Public surface; callers pass `publish_fn` and the join's `key`/`name`/`type_`/`conversation`.

### Changed

- **`PublishSpy` test fixture** (`tests/conftest.py`) — `__call__` now accepts `retain: bool = False`; `calls` list records 3-tuples `(topic, payload, retain)`. Six test sites across `test_artifact.py`, `test_mcp_tools.py`, `test_message_visibility.py`, `test_gaps_mcp_tools.py`, `test_conversation.py` migrated to 3-element unpacks.

### Verified

- Full pytest suite: **1201 passed** (1196 from v0.3.0 + 5 new presence tests), 0 failed.
- ruff check + ruff format both clean.
- End-to-end probe (fresh isolated daemon + MQTT subscriber + simulated MCP join) confirms presence is published to `claude-comms/conv/svelte-work/presence/{key}` AND `claude-comms/system/participants/{key}-mcp`, both with `retain=True`, both carrying the correct wire-format payload (`key`, `name`, `type`, `status: "online"`, `client: "mcp"`, `ts`).
- REST `/api/participants/{conv}` returns the MCP-joined participant with the synthesized MCP connection (`is_online: true`), so the web UI's 30-second REST poll path also resolves the worker correctly even if the live MQTT path missed.

### Notes for upgraders

- After upgrade, restart the daemon (`claude-comms stop && claude-comms start --background --web`). The fix lives in the daemon process; a stale pre-upgrade daemon will keep publishing non-retained presence.
- Existing connected web clients may need a hard-reload (`Ctrl+Shift+R`) or browser site-data clear to pick up the new bundled `mqtt-store.svelte.js` (the parse-failure logger + banner ship in the dist JS).

## [0.3.0] -- 2026-05-12

Minor release. Two distinct correctness fixes plus a polish piece. The headline change is **participant registry persistence** — the standing-agent use case (Claude Code agents that hold a key across daemon restarts) was structurally broken in 0.2.x and is now correct. Also lands the worker-src CSP fix (which the v0.2.3 web-UI brief flagged as the actual functional half of Bug 1) and the project's first favicon.

### Fixed

- **Bug 3 — Participant registry no longer evaporates on daemon restart** (closes the standing-agent use case). Prior to this change `ParticipantRegistry` was an in-memory dict — every `claude-comms stop && start` cycle silently invalidated every MCP-side participant key, so a Claude Code agent that joined and received key `96052c22` discovered after restart that its key was now "unknown" and had to call `comms_join` with `name` again. Fixed by adding a SQLite-backed `RegistryStore` at `~/.claude-comms/registry.db`. Schema covers participants, conversation memberships, per-conversation read cursors, and per-thread read cursors. WAL mode + `synchronous=NORMAL` + foreign keys ON; foreign key cascades clean up memberships and cursors when a participant is purged. **What is NOT persisted:** `Participant.connections` — that's ephemeral presence state. Rehydrated participants come back offline (`is_online == False`) and re-online via MQTT presence + `_ensure_mcp_connection` on next interaction.
- **Bug 1 — MQTT Web Worker no longer blocked by CSP**. The daemon's CSP set `script-src 'self'` correctly strict but never set `worker-src` — per CSP spec, `worker-src` falls back to `script-src` when unset, and `script-src 'self'` does NOT permit `blob:` URIs. MQTT.js spawns its frame-parsing worker from a blob URL, so the worker was blocked. Symptom downstream: "Failed to parse MQTT message: SyntaxError: Unexpected end of JSON input" in DevTools console as the main-thread fallback choked on partial frames. Fixed by adding `worker-src 'self' blob:` to `build_csp()`. blob: URIs are same-origin by spec; this does not meaningfully widen the attack surface. New regression test `test_csp_worker_src_allows_blob` pins the directive.
- **Bug 1 — `/favicon.ico` 404 closed**. Wheel previously shipped no favicon, so every browser load 404'd on `/favicon.ico`. Added `web/public/favicon.svg` (the Wave Stack design: ember-on-transparent 5-bar voice-wave silhouette, designed to read at 16×16). Vite copies `web/public/*` to the bundled `dist/` root automatically; `index.html` gains a `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`.

### Added

- **`src/claude_comms/registry_store.py`** -- new module. `RegistryStore` class with `open(data_dir)`, `load_all() -> RegistrySnapshot`, `upsert_participant`, `update_participant_name`, `add_membership`, `remove_membership`, `upsert_read_cursor`, `upsert_thread_read_cursor`, `purge_stale(before_iso)`, `close`. Thread-safe via internal `threading.Lock`; supports use as a context manager.
- **`ParticipantRegistry(store=...)` kwarg** -- optional `RegistryStore` parameter on `__init__`. When provided, in-memory state is rehydrated from the store on construction and every mutating method (`join`, `leave`, `update_name`, `update_cursor`, `update_thread_cursor`, `advance_thread_cursors_to`) writes through atomically. Backward-compatible: `ParticipantRegistry()` with no kwarg keeps the legacy pure-in-memory behaviour the existing test suite relies on.
- **`tests/test_registry_store.py`** -- 19 unit tests covering schema creation, WAL/FK PRAGMAs, round-trip persistence for participants/memberships/cursors, FK cascade on `purge_stale`, concurrent writes, idempotent close, and explicit assertion that `connections` has no schema column.
- **`tests/test_registry_persistence.py`** -- 10 end-to-end tests covering the integrated `ParticipantRegistry(store=...)` path: participants survive restart, memberships survive restart, leave persists, name change persists, both cursor types persist, connections are NOT persisted (offline on rehydration), `tool_comms_join` with an existing key works after restart (the marquee bug-fix verification), `tool_comms_conversations` reflects pre-restart memberships, and `ParticipantRegistry()` without a store keeps pure-in-memory behaviour.
- **`mockups/favicons/`** -- the 25-design picker page (`index.html` + individual SVGs under `svg/`) used to select the v0.3.0 favicon. Kept in-tree for future favicon iterations; the picked design lives at `mockups/favicons/svg/04-wave-stack.svg` and is copied to `web/public/favicon.svg` for the actual build.
- **`web/scripts/screenshot-favicon-page.mjs`** -- Playwright helper that renders the picker page headlessly and dumps full-page + per-card screenshots for visual verification.

### Changed

- **`src/claude_comms/mcp_server.py:create_server`** -- now constructs a `RegistryStore` (at `~/.claude-comms/registry.db` by default, overridable via `registry.data_dir` in `config.yaml`) and passes it to `ParticipantRegistry`. The store is closed in the daemon's `finally` block so WAL checkpoints back into the main DB before process exit.
- **`README.md`** -- new "Where state lives" section above the CLI reference describes which paths under `~/.claude-comms/` survive restart, why `connections` is intentionally not persisted, and how to back up or reset `registry.db`.

### Verified

- `build_csp(default_config)` now emits 9 directives including `worker-src 'self' blob:` -- existing 17 CSP tests still pass, +1 for the worker-src assertion.
- Wheel rebuild (`python -m build`) packages `claude_comms/web/dist/favicon.svg` (1304 bytes) alongside index.html and the asset bundle.
- Fresh-clone full pytest suite: **1197 passed, 0 failed** (1167 baseline + 29 registry tests + 1 worker-src CSP test).
- ruff check + ruff format --check both clean across `src/` and `tests/`.
- A separate verification-run agent confirmed all CI gates green on the v0.3.0 working tree before tagging.

### Notes for upgraders

- **No migration needed.** The daemon creates `~/.claude-comms/registry.db` on first startup of v0.3.0; if you have agents still holding 0.2.x in-memory keys, they'll need to call `comms_join` with `name` once more after upgrade to seed the new registry. After that, restarts are transparent.
- **Web UI must hard-refresh.** The CSP header is read once at page load; a soft refresh may use the cached old policy. Use Ctrl+Shift+R / Cmd+Shift+R to force.
- **Standing-agent pattern** (worker that holds a key across many tasks) is now usable but not yet documented. A `comms_wait_for_message` MCP tool to make idle-worker polling cheap is on the roadmap for v0.4 — see the v0.3.0 PR thread for the design discussion.

## [0.2.3] -- 2026-05-12

Patch release fixing two production bugs that made the web UI unusable for any user who typed `http://localhost:9921` (the natural URL) instead of `http://127.0.0.1:9921`, plus a PyPI gallery rendering fix.

### Fixed

- **Web UI MQTT/REST connections blocked by CSP when loaded via `localhost`** (`src/claude_comms/cli.py:build_csp`). The web client builds its broker URL from `window.location.hostname`, so loading the page via `http://localhost:9921` produces `ws://localhost:9001/mqtt`. The daemon's CSP only listed `ws://127.0.0.1:9001`, so the browser blocked the connection — the top banner stayed on "Reconnecting to broker..." forever and no realtime messages arrived. Fixed by expanding loopback bind addresses (`127.0.0.1`, `localhost`, `0.0.0.0`, `::1`) to both `127.0.0.1` AND `localhost` variants in `connect-src`. Also now includes `https://` and `wss://` variants for future TLS deployment.
- **External Google Fonts dependency** (`web/index.html`, `web/src/app.css`). Inter font was loaded from `fonts.googleapis.com` / `fonts.gstatic.com`, which required relaxing `style-src` and adding `font-src` for those CDN origins. Replaced with `@fontsource-variable/inter` bundled into the wheel — `font-src 'self' data:` is now strict and the UI renders offline. Adds ~50 KB to the wheel but eliminates an external CDN dependency.
- **Gallery images broken on PyPI** (`README.md`). The 10 gallery image references used relative paths (`mockups/gallery-XX.png`), which GitHub auto-resolves but PyPI does not — PyPI's project description showed broken-image placeholders for the whole gallery. Switched to absolute `https://raw.githubusercontent.com/Aztec03hub/claude-comms/main/mockups/gallery-XX.png` URLs. Renders on both GitHub and PyPI.

### Added

- **`font-src` CSP directive** (`'self' data:`). Was previously absent; fell back to the `default-src 'self'` value, which blocked the external Google Fonts. Now explicit + tight.
- **`tests/test_csp.py`** -- 17 unit tests pinning the CSP contract. Covers loopback alias expansion (parametrized over `127.0.0.1` / `localhost` / `0.0.0.0` / `::1`), default-config emission, LAN-IP bind, `0.0.0.0` bind, `api_base` reverse-proxy mode, and the `csp_extra_connect_src` escape hatch for Tailscale / public-DNS deployments. Hardening assertions: no `unsafe-eval`, no `*` wildcards in source lists, strict `script-src`.
- **`web/e2e/csp-violations.spec.js`** -- Playwright regression guard. Asserts (1) `Content-Security-Policy` is delivered as a response header, not a `<meta>` tag, (2) the header contains both `localhost` and `127.0.0.1` variants for broker + REST, (3) no CSP violations fire on the console during page load. Runs against the live daemon at `127.0.0.1:9921`.

### Changed

- **`web/index.html`** -- removed the `preconnect` hints + `<link>` stylesheet load for Google Fonts. Inter is now self-hosted; comment in source explains why.

### Verified

- `build_csp(default_config)` emits a connect-src containing all 8 expected origins: `http://127.0.0.1:9920`, `https://127.0.0.1:9920`, `http://localhost:9920`, `https://localhost:9920`, `ws://127.0.0.1:9001`, `wss://127.0.0.1:9001`, `ws://localhost:9001`, `wss://localhost:9001`. Plus `'self'`.
- `grep -E 'googleapis|gstatic'` on `src/claude_comms/web/dist/index.html` returns nothing -- the bundle is fully self-hosted.
- Full pytest suite: `0 failed, 1166 passed` (1149 pre-existing + 17 new CSP tests).
- ruff check + ruff format: clean across `src/` and `tests/`.

### Followup (not blocking, not yet shipped)

- **`Reconnecting to broker...` banner timeout.** After N failed reconnect attempts (5? 10?), the banner should switch to a definitive "Cannot connect to broker -- check the daemon logs" with a manual retry button. Indefinite "reconnecting" is user-hostile. Tracked as a separate web-UX task; not part of v0.2.3 because the CSP fix already resolves the headline symptom.

## [0.2.2] -- 2026-05-12

Docs-only patch release. Re-publishes the rendered README so PyPI's project page picks up README fixes that wouldn't otherwise reach the cached upload from 0.2.1. No code changes.

### Fixed

- **CI badge in README** -- switched from GitHub's native `actions/workflows/ci.yml/badge.svg` (which has a 5-minute cache and showed `failing` on PyPI for ~5 min after the v0.2.1 push while the lint job was being fixed) to a `shields.io` badge with an explicit `branch=main` filter and a click-through link to the workflow page. Independent cache layer + visible link target.
- **README rich-text rendering** -- two occurrences of an over-escaped backtick pattern (`` `\`code\`` ``) rendered on PyPI as the literal text `\code\` instead of the intended inline-code chip. Fixed by wrapping with double-backticks per CommonMark (`` `` `code` `` ``), which is the proper way to embed literal backticks inside an inline code span. Touched `README.md` lines describing the Web UI's rich-text rendering and the `RichText.svelte` parser.
- **CHANGELOG retroactive backtick fixes** -- same over-escape pattern in the `web/src/lib/rich-text-parser.js` entry (under v0.2.0) and the "Format help button" entry (older release) updated for consistency. CHANGELOG.md is repo-only / not rendered on PyPI but the fix preserves the audit trail.
- **Name capitalization in README** -- the project credit at the bottom of the README read "Phil Lafayette" but Phil's canonical capitalization is mid-cap: "Phil LaFayette" (matches the `authors` field in `pyproject.toml` and git author on every commit). Fixed.

### Verified

- README audited for any remaining `\\\`` / over-escape patterns. The `\*` markers in the MCP-tools table (`` `name`\* `` for "required parameter") are correct markdown idiom and render as `name`* with a literal asterisk -- intentional, left as-is.
- `grep -rn 'Lafayette'` across `*.md` / `*.toml` / `*.json` / `*.py` / `*.yml` / `*.yaml` returns nothing.

## [0.2.1] -- 2026-05-12

Patch release. v0.2.0 shipped to PyPI cleanly (web/dist bundled, daemon binds, install round-trip works) but had a cosmetic bug: `claude-comms --version` reported `0.1.0` because the in-code constant lagged `pyproject.toml`. Also lands CI hygiene work that had been queued behind the v0.2.0 publish dance.

### Fixed

- **`__version__` now reads from package metadata via `importlib.metadata.version("claude-comms")`** (`src/claude_comms/__init__.py`). The hardcoded `__version__ = "0.1.0"` constant is gone; `pyproject.toml` is the single source of truth and the CLI's `--version` flag always reflects the wheel's version. Falls back to `"0+unknown"` when the package isn't installed (e.g. running tests from a fresh clone before `pip install -e .`).
- **31 pre-existing ruff errors + 22 files needing `ruff format`** -- CI lint job had been red for 5+ runs. Real bug fixed in `tui/app.py:666` (backslash in f-string expression -- valid syntax only on Python 3.12+, broken on the project's 3.10/3.11 minimum). Bulk auto-fixes for 28 unused imports + 1 duplicate `MessageBubble` import in `tests/test_tui.py`. Vestigial `key_bob` in `tests/test_conversation.py` replaced with a side-effect-only registration + comment.
- **93 async-await test failures** -- 11 `tool_comms_*` functions in `src/claude_comms/mcp_tools.py` were converted from sync to async without the test suite being updated. Subagent mechanical pass: add `await`, mark functions `async def`, decorate with `@pytest.mark.asyncio`. Touches 7 test files / 29 test classes. One sync-helper conversion in `TestAllCommsToolsWithMockPublish._setup`. One `asyncio.run()` inside a worker thread in `test_concurrent_joins` to preserve threaded-contention semantics.
- **5 stale assertions surfaced after the await pass** -- 3 tests asserted `client=="unknown"` / `status=="offline"` from the pre-`_ensure_mcp_connection` era (commit `04a0501`). 1 test asserted the 7-key Message schema (now 13 keys with mentions + thread_*). 1 test (`test_targeted_to_self`) was the only behavior assertion: it expected self-targeted sends to succeed, but the recipient resolver drops the sender. Renamed to `test_targeted_to_self_is_rejected` and updated to assert the resolver's contract.

### Changed

- **CI workflows opt into Node 24 ahead of GitHub's deprecation deadlines.** `env: FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"` added at the workflow level to both `ci.yml` and `release.yml`. Node 20 becomes a removed runtime on 2026-09-16; Node 24 becomes the default on 2026-06-02. Opt-in is harmless once Node 24 is default (the variable becomes a no-op).

### Verified

- `pip install --no-cache-dir claude-comms[all]` (no `--pre`) from PyPI resolves the 0.2.0 wheel, and after this patch ships will resolve 0.2.1.
- `claude-comms --version` in a fresh `pip install -e .` of this branch reports `0.2.0` (the current pyproject value); the next install of 0.2.1 will report `0.2.1` without any code edit.
- Full pytest suite: `0 failed, 1149 passed`. The 93 pre-existing async-tool-call failures + the 5 surfaced stale assertions are all resolved. No new test was deleted, skipped, or xfail'd.
- CI lint job passes for the first time in 5+ runs (verified locally; cloud run will confirm).

## [0.2.0] -- 2026-05-12

### Packaging: pip / pipx Install Ships Working Web UI (2026-05-12)

End-user impact: `pipx install "claude-comms[all]"` (and `pip install` from PyPI) now drops a daemon that serves the Svelte web UI out-of-the-box -- no Node toolchain, no manual `pnpm build`, no `Web UI dist not found... -- skipping` log line on the consumer machine. Closes the gap where a downstream user installed the package and discovered the daemon had no web UI to serve because the wheel never bundled the built Svelte assets.

#### Fixed

- **Daemon's web-asset path resolution** (`src/claude_comms/cli.py:1140-1148`) -- was `Path(__file__).resolve().parent / "../../web/dist"`, which walks UP two directories from the installed package and only ever resolved correctly from an in-tree source checkout. From a pipx install this expanded to `<venv>/lib/python3.12/web/dist`, which no install layer ever produced. Replaced with `importlib.resources.files("claude_comms").joinpath("web", "dist")` -- zip-safe and stable across pip / pipx / editable / frozen installs.

#### Added

- **`hatch_build.py`** (new file at repo root) -- Hatch custom build hook. On every wheel/sdist build it ensures `src/claude_comms/web/dist/index.html` exists; if missing, it shells out to `pnpm install --frozen-lockfile && pnpm build` inside `web/` and fails loudly with a toolchain-install message if `pnpm` is absent. Already-built dist short-circuits the hook so CI prebuilds and dev incremental builds don't re-pay the install cost.
- **`.github/workflows/release.yml`** -- tag-driven PyPI publish workflow. Triggered by `push.tags: ['v*']`. Builds wheel + sdist via `python -m build` (which transparently fires `hatch_build.py`), verifies `claude_comms/web/dist/index.html` is in the wheel with a `python -m zipfile -l | grep` gate, then publishes via `pypa/gh-action-pypi-publish@release/v1` using OIDC trusted publishing -- no long-lived API tokens in repo secrets. Includes a security note that the workflow does not consume any `github.event.*` untrusted inputs.
- **`web/.npmrc`** -- pnpm config: `onlyBuiltDependencies=[esbuild, @tailwindcss/oxide]` allowlist (pnpm 10+ blocks postinstall scripts by default for supply-chain safety) and `confirmModulesPurge=false` for CI / no-TTY contexts.
- **`web/pnpm-lock.yaml`** -- the npm-to-pnpm migration deterministic lockfile.

#### Changed

- **`pyproject.toml`** -- version bumped `0.1.0 -> 0.2.0`. Build-system `requires = ["hatchling>=1.21"]` (was unpinned). Added `[tool.hatch.build.hooks.custom] path = "hatch_build.py"`. Wheel target gains `artifacts = ["src/claude_comms/web/dist/**"]` so the gitignored build output is opted into the wheel. New `[tool.hatch.build.targets.sdist]` declaring explicit include/exclude (sdists include `web/` source so a source install can rebuild the UI; they exclude `web/node_modules`, `web/.svelte-kit`, `web/dist`, and `src/claude_comms/web/dist`).
- **`web/vite.config.js`** -- `build.outDir` changed from `'dist'` to `'../src/claude_comms/web/dist'`. Vite now emits straight into the Python package so wheel + editable installs both find assets at the same `importlib.resources` path. Added `emptyOutDir: true` because the outDir lives outside Vite's project root.
- **`web/package.json`** -- migrated from npm to pnpm: removed `package-lock.json` references, added `"packageManager": "pnpm@11.1.1"`, `engines.pnpm: ">=11"`, and a top-level `pnpm.onlyBuiltDependencies` mirror of the .npmrc allowlist. Added `@shikijs/langs@3.0.0` as a **direct** dependency (was relying on npm flat-hoisting; pnpm's strict isolation requires it explicitly because `src/lib/markdown.js` does deep imports like `@shikijs/langs/typescript`). `build:check` script switched `npm run` to `pnpm run`.
- **`.github/workflows/ci.yml`** -- collapsed the legacy `build-web` job into the `test` job (Node + pnpm setup + `pnpm build` before `pip install -e`, so the editable install short-circuits the hook). Added a new `build-wheel` job that runs `python -m build` and verifies `claude_comms/web/dist/index.html` is in the wheel via a `zipfile -l | grep` gate, then uploads `dist/` as an artifact. Old `web-dist` artifact (uploading the raw `web/dist/` from npm) is gone.
- **`.gitignore`** -- added `src/claude_comms/web/dist/` (Vite's new outDir, intentionally tracked only via `artifacts` in pyproject.toml).
- **README Quick Start step 1** -- rewritten with three explicit install paths: stable PyPI (`pipx install "claude-comms[all]"` -- no Node required), latest from git (compiles UI at install, requires Node 20+/pnpm 11+), and local-dev (`pip install -e` + `pnpm dev` for Vite HMR). Replaces the prior single-line snippet that didn't mention the toolchain requirement of a source install.

#### Verified

- Fresh-venv install (`pip install dist/claude_comms-0.2.0-py3-none-any.whl` into a clean `python3 -m venv`) resolves `importlib.resources.files("claude_comms").joinpath("web", "dist", "index.html")` to a real file (1021 bytes, content-matched to the source `index.html`).
- Wheel contents inspection: `python -m zipfile -l dist/claude_comms-0.2.0-py3-none-any.whl | grep web/dist` shows `index.html` + 13 `assets/*.js`/`.css`/`.map` entries baked in. Total wheel size 1.5MB.
- Editable install (`pip install -e .`) resolves the same path to `<repo>/src/claude_comms/web/dist/`, so dev flow ("HMR via `pnpm dev`" or "production rebuild via `pnpm build`") works without manual copy steps.
- Test suite delta: zero new failures attributable to this change (verified by sampling failing tests -- all are the pre-existing async-`tool_comms_join` tech-debt cluster tracked separately).



Documentation only -- no code or behavior change. Surfaces the MCP-registration instructions from `USAGE.md` into the README's Quick Start so external readers (other Claude Code users wanting to use claude-comms as an MCP) discover them without digging into `USAGE.md`.

#### Changed

- **README Quick Start step 6** rewritten as "Register the MCP server with Claude Code". Replaces the prior outdated snippet (which mixed `command`/`args` stdio fields with an HTTP `url` and dropped the `/mcp` path) with three explicit install paths (project-scoped `.mcp.json`, user-wide `claude mcp add ... -t http`, manual `.mcp.json` in another project), the `:9920/mcp` URL gotcha, the 22-tool subagent permission allowlist for `~/.claude/settings.json`, a verify step (`/mcp` slash command, tab-completion probe, `comms_join` round-trip), and a network-considerations note (loopback is the security boundary; LAN/Tailscale only on trusted networks). Mirrors the existing long-form section in `USAGE.md` -- USAGE.md remains the canonical home, the README now carries a discoverable short version.

### Threaded Replies + Mention-Color Polish (2026-05-07)

Headline change: end-to-end threaded replies across the server, MCP read + MQTT fanout, and web UI lanes, capped at depth-2 (a reply may target a top-level message but not another reply). Plus a small surgical mention-color polish that pulls `mention-other` out of grey and back into the ember family in both web themes and the TUI. Threading work shipped via three coordinated subagents (ember/phoenix/sage) against the `threaded-replies-plan` artifact (v1 -> v5 with adversarial review baked in).

#### Added

- **`Message` thread metadata** -- five optional Pydantic fields at `message.py:97-134`: `thread_root_id`, `thread_reply_count`, `thread_last_ts`, `thread_last_author`, `thread_participants`. Derived/read-side state (not user-supplied); populated by the broker dispatcher on reply ingest and rebuilt at JSONL replay time.
- **`comms_send` `reply_to` kwarg** -- depth-2 thread send. Server validates parent existence, same-conversation, depth-2 (parent's own `reply_to` must be null), and non-system-parent. On reply ingest the dispatcher mutates the root dict to maintain the five `thread_*` fields and additionally publishes to `claude-comms/conv/{conv}/threads/{root_id}` (non-fatal on failure).
- **`comms_thread_read` MCP tool (#22)** -- `comms_thread_read(key, conversation, root_id, count?, since?)` returns `{conversation, root, replies, count, has_more}`. `root` is always populated regardless of `since` so incremental fetches never lose context. `replies` is the flat depth-2 list of messages whose `reply_to == root_id`, visibility-filtered for `key`. Side-effect: advances a per-thread read cursor.
- **`comms_read` `top_level_only` kwarg** -- when True, filters to thread roots + untyped top-level messages and decorates each retained root with at least one reply with a `thread_summary: {reply_count, last_ts, last_author}` field synthesized from the flat thread metadata. UI passes True for the channel feed.
- **`comms_check` `thread_unread` map** -- each per-conv summary entry now also carries a `thread_unread: {root_id: count}` map for any threads with unread replies, computed against the per-thread read cursors. `mark_seen=True` advances both the channel-level read cursor AND every relevant per-thread cursor in lockstep to the latest visible reply.
- **`MessageStore.find_by_id(conv_id, msg_id)` and `MessageStore.update_thread_metadata(...)`** -- lock-safe accessors on the in-memory store. `find_by_id` returns the live dict reference (the same object decorated with `thread_summary` at read time).
- **`broker.py:_rebuild_thread_metadata(store)`** -- second-pass JSONL replay function wired into `replay_jsonl_logs` so daemon restart reconstructs every root's `thread_*` fields from the flat reply records.
- **`ParticipantRegistry._thread_read_cursors`** keyspace plus `update_thread_cursor` / `get_thread_cursor` / `thread_cursors_for` / `advance_thread_cursors_to` methods. Cursors are keyed `(participant_key, conversation, root_id) -> ts`.
- **Per-thread MQTT topic** -- replies fan out to `claude-comms/conv/{conv}/threads/{root_id}` in addition to the main `messages` topic, letting a thread-focused viewer subscribe just to the thread it cares about. Publish failure is logged but non-fatal.
- **`web/src/lib/reply-parser.js`** -- pure `/reply <message_id> <body>` parser. Surface-shape UUID v4 validation (`8-4-4-4-12` lowercase hex with hyphens); the server is the authority on existence/depth-2/non-system-parent. Returns `{replyTo, body, error}`. Mirrors the `dm-parser.js` shape so the threading grammar stays orthogonal to the whisper grammar.
- **`web/tests/reply-parser.spec.js`** -- 20 Vitest tests covering missing trigger, missing id, malformed id, empty body, leading-whitespace tolerance, tab-as-separator, body-with-internal-spaces.
- **Web `mqtt-store.svelte.js` thread state** -- `threadSeenCursors` (`$state` map of `root_id -> latest acknowledged reply ts`), `markThreadSeen(rootId)` method, `activeChannelReplies` `$derived` (filters `activeMessages` to depth-2 replies in the active channel), persistence to `localStorage` under `claude-comms-thread-seen-cursors`. The existing `activeMessages` `$derived` is now top-level-only and splices `thread_unread_count` onto each root from the seen-cursor map.
- **Web `MessageBubble` thread chip** -- driven by `thread_reply_count` (singular/plural-aware), optional "last by @author" line, `class:has-unread` accent when `thread_unread_count > 0`. Click/Enter/Space opens the ThreadPanel.
- **Web `MessageInput` `/reply` dispatch** -- `parseReply` import + branch alongside the existing `/dm` dispatch, identical composer-error UX.
- **Web `App.svelte` thread wiring** -- `handleOpenThread` calls `store.markThreadSeen(message.id)`; ThreadPanel `messages` prop reads `store.activeChannelReplies`.
- **`tests/test_threaded_replies.py`** (16 tests) -- server-side: `Message.thread_*` round-trip, `find_by_id` + `update_thread_metadata`, `_rebuild_thread_metadata` replay, `tool_comms_send` `reply_to` validation matrix.
- **`tests/test_threaded_replies_read.py`** (23 tests) -- read-side: `tool_comms_thread_read`, `top_level_only` + `thread_summary`, `thread_unread` map, lockstep `mark_seen` per-thread cursor advance, per-thread MQTT fanout (incl. non-fatal failure path).
- **`tests/test_message.py::test_json_keys`** updated to expect the five new `thread_*` keys in the `model_dump_json()` output.

#### Changed

- **`MessageBubble.svelte` thread chip** -- upgraded from the dead `thread_count` placeholder to the live `thread_reply_count` (singular/plural), with an optional "last by @author" line and a `.has-unread` accent. Driven by the broker-dispatcher / replay-rebuilt `thread_*` fields rather than client-side counting.
- **`mqtt-store.svelte.js: activeMessages`** -- now `$derived.by` filtering to top-level messages (`reply_to === null`) and splicing `thread_unread_count` onto each root from the per-thread seen-cursor map. The depth-2 reply feed lives in the new `activeChannelReplies` `$derived`. Non-breaking for top-level rendering; ThreadPanel switches to the new derivation.
- **Mention-other color tokens** -- both dark and light theme `--mention-other-bg` / `--mention-other-fg` moved out of grey and into the ember family. Dark: `rgba(245,158,11,0.12)` + `var(--ember-400)` (was `rgba(168,160,152,0.14)` + `var(--text-secondary)`). Light: `rgba(217,119,6,0.10)` + `var(--ember-500)`. The TUI `MENTION_OTHER_STYLE` in `chat_view.py` flipped from `"#8a8a8a"` to `"#f59e0b"` for parity. All three mention tiers (`self` loud, `other` softer, legacy chip) now share the ember palette and differentiate via weight + alpha rather than hue.

#### Behavioral notes

- **Threading is intentionally flat (depth-2).** A reply may target a top-level message; a reply may not target another reply. The server enforces this on every send, returning a validation error.
- **Thread metadata is derived state, not user-supplied.** Wire-format messages still ship with `thread_*` fields as `null` from the client; the server populates them on the root dict during dispatch / replay.
- **Per-thread MQTT publish failure is non-fatal.** The primary publish to the conversation `messages` topic is the source of truth; the per-thread topic is a fanout convenience.
- **TUI threading is not yet exposed.** The MCP + web lanes shipped this batch. Replies arrive on the TUI's channel feed as ordinary messages; a TUI `/reply` parser + ThreadPanel is a follow-up.

#### Workflow

- **Three coordinated implementation subagents** -- ember (server lane), phoenix (MCP read + MQTT lane), sage (web UI lane) -- shipped against a single `threaded-replies-plan` artifact (v1 -> v5 with adversarial review baked in). The plan structure (per-lane scope + locked grammar in §6 + Pydantic schemas in §4.1) let the three lanes integrate cleanly without follow-up correction passes.

### Mentions vs Whispers, Reactions, Status Indicators, Rich Text (2026-05-06)

Headline change: a clean break separating broadcast highlights (`mentions`) from private whispers (`recipients`) on every message. Plus reactions, working/status indicators, backtick rendering with markdown emphasis, presence resurrection for swept MCP connections, and a server-authoritative stale-offline-participant prune. Spec lives at `plans/mentions-vs-whisper-separation.md` v6 (4 adversarial review rounds, converged at 0 critical / 0 major).

#### Added

- **`Message.mentions: list[str] | None`** wire field with hex-key validator mirroring `_validate_recipients` at `message.py:95-105`. Pydantic v2 default `model_dump_json()` symmetrically emits `"mentions":null` alongside `"recipients":null`.
- **`comms_send` `mentions` kwarg** -- broadcast highlight intent. Visible to all conversation members; named users get a notification cue; does NOT restrict visibility. Independent of `recipients`; the two may be combined (whisper-with-named-highlights).
- **`comms_check` `mark_seen` kwarg** -- opt-in cursor advance after the response is built. Returned `total_unread` reflects the PRE-advance count, so callers see what they acknowledged. Defaults to `False` to preserve peek-only semantics.
- **`resolve_for_mentions` registry method** -- new variant of `resolve_recipients` that hex8-validates against the global participant registry. `resolve_recipients` is unchanged; lenient hex8 pass-through preserved.
- **`comms_react` MCP tool** -- add, remove, or toggle (default) emoji reactions on a message. Persists to a per-conversation reactions log, broadcasts on a dedicated reactions topic. Rate limits: 30 events per actor per minute per conversation, max 10 distinct emojis per actor per message. No-op operations return `{"status": "no_op"}`.
- **`comms_reactions_get` MCP tool** -- list current reactions on a message as `{"reactions": {emoji: [actor_key, ...]}}`.
- **`comms_status_set` MCP tool** -- ephemeral activity signal (e.g., `thinking`, `reading`, `drafting`). TTL default 30s, hard cap 300s. Throttled to one update per 2s; bursts dropped (last-write-wins). Auto-expires on disconnect or sweep.
- **`comms_status_clear` MCP tool** -- idempotent clear of the active activity signal.
- **`src/claude_comms/reactions.py`** -- `Reaction` and `ReactionEvent` Pydantic models, `ReactionsStore` class with add/remove/toggle, dedup, and rate-limit enforcement.
- **`src/claude_comms/working_indicator.py`** -- activity-signal decorator + sweep machinery for `comms_status_*`.
- **`PresenceManager.ensure_connection()`** -- resurrects MCP connections that were swept while still active, fixing the case where an idle MCP session was reaped server-side but the client had a live token.
- **`_ts_after()` helper** in `mcp_tools.py` -- timezone-aware cursor comparison fixing a mixed-timezone string-compare bug that was filtering out otherwise-visible messages.
- **`/dm @user[, @user2] body` slash command** -- composer parses recipient tokens against the §6.2-A grammar (whitespace OR comma OR comma+whitespace separates tokens; tokens end at first non-`@<name>`), resolves names to keys via `store.participants`, and sends a whisper. Wire `recipients` always carries keys.
- **Profile-card "Send DM" button** -- pre-fills the composer with `/dm @<name> ` via store-mediated `composerPrefill`, watched by `MessageInput.svelte` through `$effect`. Replaces the previous fragile `document.querySelector` + `input.value =` pattern.
- **`web/src/lib/rich-text-parser.js`** -- pure parser splitting message bodies into segments: plain text, inline `` `code` `` chips, triple-backtick fenced blocks, bold `**text**`, italic `*text*`, strikethrough `~~text~~`. Drives `RichText.svelte`.
- **`web/src/lib/compose-overlay-segments.js`** -- composer overlay segmenter so backticked text colors live as you type without disrupting the textarea/mirror alignment.
- **`web/src/components/RichText.svelte`** -- segment renderer used by `MessageBubble.svelte`.
- **`web/src/lib/dm-parser.js`** -- `parseDM` slash-command parser (single-responsibility; intentionally separate from `mentions.js` autocomplete).
- **Mention render branches in `MessageBubble.svelte:parseBody`** -- `mention-self` (bold + amber + `.has-self-mention` border accent on the bubble) for messages calling out the viewer; `mention-other` (quiet grey) for everyone else's mentions; legacy `.mention` chip preserved for whispers, sender-self, and unkeyed mentions. CSS tokens `--mention-self-bg/-fg/-border`, `--mention-other-bg/-fg` defined in `app.css`.
- **TUI render parity** -- self-mentions render bold + amber with a `▎` glyph in the left margin and a `box.HEAVY` Panel border on the bubble; other-mentions render dim. Whisper bubble gates on `recipients` only, independent of `mentions`. Sender-self special case suppresses the loud chip on your own bubble.
- **Working / status indicator UI** -- amber dot with the active label next to a participant's name in the member list (web + TUI), fading on clear/expiry.
- **Member-list emoji-picker integration** for adding reactions from the web UI.
- **`tokensToMentions`** helper in `mqtt-store.svelte.js` companion to the now-deprecated `tokensToRecipients` (retained as deprecated alias for one release).
- **`tests/test_message_visibility.py`** (20 tests) -- send/visibility matrix per §10 of the plan: broadcast, mentions-only, whisper, whisper-with-mentions, sender-key dedup, hex8 validation, legacy fixture coercion, `mark_seen` cursor-advance.
- **`tests/test_reactions.py`** (26 tests) -- model validators, store CRUD, rate limits, dedup, `comms_react` / `comms_reactions_get` integration.
- **`tests/test_status.py`** (27 tests) -- working-indicator decorator, `comms_status_set` / `comms_status_clear`, TTL expiry, throttle, sweep, broadcast scope.
- **TUI test expansion** in `tests/test_tui.py` -- self-vs-other mention parity, `box.HEAVY` whisper bubble, working-indicator badge.
- **Web tests** -- `web/tests/rich-text-parser.spec.js`, `compose-overlay-segments.spec.js`, `composer-backtick.spec.js`, `dm-parser.spec.js`, `message-bubble-mentions.spec.js`, `message-input-mentions.spec.js` (Vitest); plus `web/e2e` updates.

#### Changed

- **`comms_send` resolves recipients via `resolve_recipients` and mentions via `resolve_for_mentions`** -- separate paths preserve the lenient hex8 pass-through on `recipients` while strictly validating mention keys against the global registry (drops stale keys, prevents future-collision agent-trigger bugs).
- **Sender-key dedup discipline** -- `recipients`: dedup at composer + server (defense in depth). `mentions`: dedup at composer only (UX); NOT deduplicated server-side.
- **`[@name]` body prefix policy** -- the server prepends a `[@name1, @name2] ` prefix ONLY when `recipients` is non-empty. Mentions-only sends never get a server-injected prefix.
- **`comms_check` `total_unread` count** -- now applies `_is_visible` filtering (whispers addressed to others are excluded). Co-shipped with the `mark_seen` opt-in. Cross-deploy effect: already-running agents will see lower counts than before for conversations containing whispers addressed elsewhere; this is the intended state.
- **`mqtt-store.svelte.js: sendMessage` signature** migrated to options-object: `sendMessage(message, channel, { mentions, recipients })`. JavaScript silently destructures arrays into option-objects, demoting whispers to broadcasts on partial deploys, so the store signature change AND `MessageInput` call-site update land in the same commit per the plan's atomicity constraint.
- **MCP tool docstring at `mcp_server.py:656`** updated to document the broadcast-vs-whisper distinction.
- **Member list (web + TUI)** -- now renders the working-indicator badge and prunes stale offline participants (server-authoritative + retained-MQTT-presence cleanup in `mqtt-store.svelte.js`).
- **Markdown inline emphasis** -- `RichText.svelte` and `MessageBubble.svelte` render `**bold**`, `*italic*`, `~~strike~~`.

#### Fixed

- **Mixed-timezone cursor comparison** -- `mcp_tools.py` was string-comparing ISO timestamps with mismatched offsets, intermittently filtering out otherwise-visible messages from `comms_read` / `comms_check`. New `_ts_after()` helper normalizes both sides before comparing.
- **`comms_check` invisible-message overcount** -- previously counted whispers addressed to others in `total_unread`; now applies the same `_is_visible` filter as `comms_read` (R2-M1 defect-fix).
- **Phantom offline participants after daemon restart** -- web member list lingered on stale offline entries from retained MQTT presence after a daemon swap. Now pruned server-authoritatively with retained-presence cleanup in `mqtt-store.svelte.js`.
- **Swept MCP connection invisibility** -- when an idle MCP session was reaped server-side, subsequent tool calls from a still-live client token surfaced as a participant disappearance. `PresenceManager.ensure_connection()` now resurrects the session.
- **Sender-self visibility invariant test added** -- `recipients=[other]` (sender NOT in list) is visible to sender via `_is_visible`'s sender-key check. Locks the assumption so future `_is_visible` changes (e.g., mute lists) don't silently break the sender-key dedup invariant.

#### Behavioral notes

- **External MCP `comms_send` callers passing `recipients` containing ONLY the sender's own key now receive a `"None of the specified recipients could be resolved"` error** (was silently a no-op self-DM). Multi-recipient calls including the sender's key continue to succeed with the sender dropped.
- **Pre-cutover messages** predating the mentions/whisper split keep their `recipients` field as whisper-only -- no migration was applied; this is by design (clean break per §9 of the plan). Pre-cutover `[@name]` body prefixes that look like mentions are still whispers.
- **TUI write-side asymmetry (v1)** -- the `mentions` field is empty for TUI-originated messages. TUI free-typed `@name` produces broadcasts with `mentions=null`. The existing `[@name]` body-prefix path continues producing whispers (recipients-set). v2 may add a TUI `/dm` parser.

#### Plan

- **`plans/mentions-vs-whisper-separation.md`** v6 (826 lines, 4 adversarial review rounds, convergence trend 25 -> 11 -> 6 -> 6 with 0 critical / 0 major at convergence).

### Mention Autocomplete Revamp (2026-04-28)

Production-grade overhaul of the `@mention` UX in `MessageInput.svelte`. Replaces the blocking, ungroomed dropdown with an overlay-based, non-blocking, ghost-suggesting, implicit-commit autocomplete that matches what users expect from Slack, Discord, and Linear.

#### Web UI

- **Overlay pattern** -- transparent `<textarea>` (caret + input events) layered over a colored mirror `<div>` (confirmed mentions in ember, ghost-suggestion in faint italic). Pixel-perfect alignment via shared font/padding/line-height + scroll sync.
- **Mention-token data model** -- confirmed mentions are `{start, end, name, key}` records, decoupled from text. Editing punctuation around a token never breaks identity.
- **Three-pass edit reconciliation** on every keystroke: offset-shift on insert/delete outside tokens, invalidate on overlap, sanity-check via text equality. Robust against paste, drag-drop, and programmatic mutation.
- **Implicit commit (Tab is optional)** -- exact-match queries auto-commit via three triggers: word-terminator (space, comma, period, etc.) for instant commit, 200ms idle debounce for silent commit, cursor-move-away. Tab still works for decisive users. Send synchronously commits any pending implicit match before building recipients.
- **Visual ember coloring leads the formal commit by ~200ms** -- as soon as exact match is detected the matched range turns ember in the overlay, giving instant feedback. If the user types more and breaks the match, color reverts. What you see is what you send.
- **Online-first sort, prefix-match filter, cap of 7 candidates** -- replaces the previous "show every participant" behavior.
- **Ghost text** -- the unentered remainder of the highlighted candidate appears as faint italic after the cursor (`@claude-testi[ng]`), so users always see what Tab will commit.
- **Self-mention prevention** -- the current user is excluded from candidates.
- **Backspace-to-edit re-targeting** -- editing a committed mention's name invalidates the token and re-spins the suggestion in the same parsing pass; user can keep typing or Tab to re-commit. No dialogs, no blocking.
- **Send-time recipient resolution** -- `mqtt-store.svelte.js`'s `sendMessage()` now accepts an optional `recipients` array (third arg). `MessageInput` walks `mentionTokens` and passes their keys; backwards compatible (null/empty preserves old behavior).
- **Accessibility** -- dropdown uses `role="listbox"` with `role="option"` rows and `aria-selected`. Textarea exposes `aria-activedescendant` so screen readers announce the highlighted candidate without focus moving. Confirmed mention spans get `aria-label="mentioning {name}"`. Ghost is `aria-hidden`.
- **IME composition** -- mention parsing skipped during `compositionstart`-`compositionend` so CJK input doesn't thrash candidates mid-character.

#### Files

- New `web/src/lib/mentions.js` (pure helpers + segment walker, 36 unit tests)
- New `web/tests/mentions.spec.js` (logic) + `web/tests/mention-input.spec.js` (component, 13 tests)
- New `plans/mention-autocomplete-revamp.md` (design doc with worked examples)
- Modified `web/src/components/MentionDropdown.svelte` (presentational, no kbd ownership)
- Modified `web/src/components/MessageInput.svelte` (overlay + state + commit logic)
- Modified `web/src/lib/mqtt-store.svelte.js` (`sendMessage` recipients arg)

#### Tests

171 / 171 Vitest passing (49 new). Build clean. svelte-autofixer clean on all modified files.

### Artifact Panel Fixes (2026-04-24)

Three post-ship fixes after first-run verification.

- **`[object Object]` author bug fixed** -- version dropdown and artifact list rows now render `author.name` (with `author.key` for participant color) instead of stringifying the `{key, name, type}` object. 4 sites in `ArtifactDetailHeader.svelte` + 2 sites in `ArtifactList.svelte`. Added `web/tests/artifact-author-rendering.spec.js` (5 defensive tests).
- **Resizable panel** -- drag the left edge to resize between 320 px and min(900 px, viewport - 200 px). Uses Pointer Events API (touch + pen friendly), ember-amber hover tint, `role="separator"` + `aria-orientation="vertical"` + `aria-valuenow/min/max` per WAI-ARIA "Window Splitter". Keyboard-accessible (Tab to handle, Left/Right nudges 16 px, Home/End jump to bounds). Width persists in `localStorage` key `claude-comms:artifact-panel-width`. Slide-in animation suppressed during drag for zero-latency tracking.
- **Body scroll fixed** -- long artifacts now scroll within the body area while the header stays pinned. Root cause: the flex-child `min-height: auto` default was resolving to intrinsic content height, preventing `overflow-y: auto` from taking effect. Adding `min-height: 0` on `.artifact-content-area` + `flex-shrink: 0` on the header resolved it.

Tests: 122 / 122 Vitest passing. Build clean.

### Artifact Improvements (2026-04-23)

Ten-improvement upgrade to the artifact subsystem: real-time sync, diffing, in-browser editing, markdown rendering, starring, and a full security/accessibility/test overhaul. Implemented across 15 tasks in 4 batches.

#### Web UI (`web/src/components/artifacts/`)

- **Real-time panel refresh** -- `artifactsDirty` store counter with debounced fetch; panel auto-updates when create/update/delete events flow through chat, concurrency-safe against active editing
- **VSCode-style diff view** -- side-by-side or unified diff between any two versions with line numbers, colored `+`/`-` gutters, and inline char-level highlighting via jsdiff (`diffLines` + `diffWords`). Non-color gutter glyphs for accessibility.
- **Per-version author display** -- version dropdown now shows author name (participant-colored) + relative timestamp + summary
- **Edit-in-place from the web UI** -- textarea replaces content area with autoresize attachment, Save/Cancel controls, Cmd+Enter / Esc shortcuts, dirty-state confirm, and a remote-update banner for collaborative conflict handling
- **Markdown rendering** -- `plan`/`doc` types render as markdown via `marked` + DOMPurify (strict sanitize config + external-image interception) with Shiki syntax highlighting using a `cssVariables` theme mapped to the Carbon Ember palette
- **Star/pin artifacts** -- hover-to-reveal star button, dedicated STARRED section, identity-scoped localStorage (`claude-comms:${identityKey}:starred-artifacts`), reconcile on mount, 500-entry cap
- **Polished empty state** -- FileText icon, copy, and GitHub-hosted USAGE.md link
- **Copy/Download buttons** -- icon-only Clipboard and Download lucide buttons in the detail header
- **Shared `lib/api.js`** -- `API_BASE` derivation + `apiGet` / `apiPost` / `ensureToken` / `prefetchToken` helpers with bearer-token bootstrap and 401 retry
- **Shiki unification** -- `CodeBlock.svelte` refactored to use Shiki via `highlightCode()` from `lib/markdown.js`; deleted the hardcoded keyword tokenizer, gaining proper grammar-based highlighting for 200+ languages across chat, artifact markdown, and artifact code
- **Subcomponent extraction** -- `ArtifactPanel.svelte` split into orchestrator + `ArtifactList`, `ArtifactDetailHeader`, `ArtifactDetailBody`, `RemoteUpdateBanner`, `ArtifactEditor` for clean ownership boundaries (R6-1)

#### Server (REST API + config)

- **`POST /api/artifacts/{conv}/{name}`** -- edit-in-place endpoint with conditional registration, loopback-only binding, bearer-token auth, and participant registry authorization
- **`GET /api/capabilities`** -- returns `writable` + feature flags for client feature detection
- **`GET /api/web-token`** -- loopback-only bearer token fetch; regenerates on every daemon restart
- **New config keys** -- `web.api_base`, `web.allow_remote_edits`, `web.ws_url`, `web.csp_extra_connect_src`, `web.strict_cors`, `web.migrate_nfc_on_startup`, `web.use_legacy_codeblock_highlighter`, `web.markdown_render_enabled`
- **`REVERSE_PROXY` env var** -- reverse-proxy deployment flag; disables the POST edit route
- **Windows-filesystem-compatible artifact naming** -- broader character set (spaces, most punctuation, Unicode), NFC normalization, reserved-name blocking, startup NFC migration with collision quarantine (R6-2)
- **Version counter fix** -- post-pruning correctness via `max(v.version)` instead of `len()`

#### Security

- **Bearer-token auth** -- fresh on every daemon start, loopback-only fetch endpoint, per-request 401 retry, consistent `"Session expired"` error copy
- **Loopback-only POST** -- never trusts `X-Forwarded-For`
- **Feature flag default-off** -- `allow_remote_edits: false`; opt-in rollout
- **Content-Security-Policy headers** -- `default-src 'self'`, strict `connect-src`, `X-Frame-Options: DENY`
- **CORS exact-match** -- replaces the previous buggy substring match (was CVE-adjacent)
- **Path-traversal defenses** -- symlink realpath check, NFC normalization, `.json`-suffix rejection, case-collision protection, fullwidth-char (U+FF00-U+FFEF) rejection
- **DOMPurify strict sanitize config** + external-image placeholder interception

#### Accessibility

- **axe-core scan as blocking CI gate** -- 17 tests covering 6 panel states + reduced-motion variants
- **21 keyboard-navigation tests** -- listbox ArrowUp/Down/Home/End/Enter/Space/Escape, focus management, Esc priority
- **Non-color diff signaling** -- `+`/`-`/`=` gutter glyphs
- **ARIA wiring** -- `aria-pressed` on star button, `aria-live="assertive"` on remote-update banner, dynamic `aria-label` throughout
- **`prefers-reduced-motion`** -- disables banner slide animation
- **`nested-interactive` fix** -- star button inside a row button in ArtifactList, converted to non-nested structure

#### Tests

- **117 Vitest tests** (new Vitest setup -- first JS tests in this repo) -- markdown XSS corpus (13 vectors), render race guard, diff chunked-fetch bounds, CodeBlock Shiki, starred-artifacts localStorage, store self-update TTL, detail view rendering, edit flow (autoresize, shortcuts, retry, dedup), axe a11y, keyboard a11y
- **203 Python tests** -- 75+ new artifact-naming tests (30+ Unicode corpus), 37 server-plumbing tests (POST endpoint / token / CORS / conditional route registration / version counter)

#### Operational

- **CI bundle-size check** with hard ceilings: `index <= 180 KB gzipped`, `vendor-markdown <= 130 KB`, `vendor-diff <= 25 KB` -- all passing with headroom
- **Rollback runbook** -- 7 kill-switch config flags documented
- **Fallback ladder** -- documented in `CONTRIBUTING.md`
- **Pinned exact dep versions** (no caret ranges) -- prevents silent sanitizer drift from transitive updates: `marked@18.0.2`, `dompurify@3.4.1`, `shiki@3.0.0`, `marked-highlight@2.2.4`, `diff@8.0.1`, `vitest@4.1.5`, `@vitest/ui@4.1.5`, `jsdom@29.0.2`, `axe-core@4.11.3`, `@testing-library/svelte@5.3.1`

#### Plan

- **`plans/artifact-improvements.md`** (1862 lines) -- 6 adversarial review rounds, 45 findings all accepted, Svelte 5 conventions audit, Svelte MCP tooling mandate

### Conversation Discovery & Invites (2026-03-30)

Browse, create, and invite participants to conversations with full metadata, human-in-the-loop enforcement, and cross-client support.

#### Backend (`src/claude_comms/conversation.py`)

- **`ConversationMeta` Pydantic model** for conversation metadata (topic, creator, created_at, member list)
- **Metadata file I/O** -- atomic conversation creation using `O_CREAT | O_EXCL` to prevent races
- **"general" channel bootstrap** -- guaranteed on startup, undeletable
- **Backfill migration** -- auto-generates metadata for existing conversations missing metadata files
- **`LastActivityTracker`** -- debounced writes for conversation last-activity timestamps

#### 3 New MCP Tools

- **`comms_conversation_create`** -- Create a conversation with topic, auto-joins creator + all human participants, posts system messages to both new conversation and #general (async)
- **`comms_conversation_update`** -- Update conversation topic with rate-limited system messages (async)
- **`comms_invite`** -- Invite a participant to a conversation, posts invite notification in #general (async)

#### Modified Existing Tools

- **`comms_conversations`** -- New `all` parameter: when `all=true`, returns ALL conversations on the server (not just joined), including topic, member_count, message_count, last_activity, and joined status
- **`comms_join`** -- Now async. On implicit conversation creation (first join to a new name), triggers same side effects as `comms_conversation_create`: auto-joins humans, creates metadata, posts system message

#### Human-in-the-Loop Enforcement

- All human-type participants are automatically joined to any new conversation (server-enforced)
- Creation notifications always posted to #general so humans always see them
- "general" channel bootstrapped on startup, undeletable

#### REST API

- **`GET /api/conversations?all=true`** -- List all conversations with metadata (topic, members, activity, joined status)

#### Web UI (`ConversationBrowser.svelte`)

- **Slide-out conversation browser panel** for browsing all conversations on the server
- **Join button** for unjoined conversations
- **"Browse All" button** in sidebar
- **System messages** (`sender.type === "system"`) rendered with distinct style (no avatar, centered, muted, smaller font)

#### TUI

- **`/discover` command** -- List all conversations with topic, join status, and last activity
- **System message rendering** -- System-type MQTT messages routed to `add_system_message()` for distinct rendering

#### Tests

- **42 unit tests** in `tests/test_conversation.py` covering model, storage, atomic creation, backfill, bootstrap, LastActivityTracker, tool functions, invite validation, rate limiting, conversation listing with `all` param

### Collaborative Artifacts (2026-03-30)

Versioned shared documents for multi-agent collaboration. Participants can create, update, read, list, and delete artifacts within conversations, with optimistic concurrency control to prevent silent overwrites.

#### Backend (`src/claude_comms/artifact.py`)

- **Pydantic models** (`Artifact`, `ArtifactVersion`) for versioned document storage
- **Artifact types**: `plan`, `doc`, `code`
- **Atomic writes** (tmp + rename) to prevent corruption on concurrent access
- **Version pruning** -- max 50 versions per artifact, oldest pruned automatically
- **Chunked reading** -- 50K character chunks with offset/limit pagination for large artifacts
- **Name validation** -- lowercase alphanumeric + hyphens slug format

#### 5 MCP Tools

- **`comms_artifact_create`** -- Create a new artifact (async, publishes system message to chat)
- **`comms_artifact_update`** -- Update with new version, optional `base_version` for optimistic concurrency (async)
- **`comms_artifact_get`** -- Read content with chunked pagination (sync)
- **`comms_artifact_list`** -- List artifacts with summary metadata, no content (sync)
- **`comms_artifact_delete`** -- Delete artifact + all versions (async, publishes system message)

#### REST API

- **`GET /api/artifacts/{conversation}`** -- List all artifacts in a conversation
- **`GET /api/artifacts/{conversation}/{name}?version=N`** -- Get artifact with optional version selection
- **CORS/OPTIONS handlers** for both artifact endpoints

#### Web UI (`ArtifactPanel.svelte`)

- **Slide-out panel** triggered from header button (FileText icon)
- **List view** showing all artifacts with type badges, version count, and author
- **Detail view** with version selector dropdown and content display
- Fetches from REST API, reactive to channel changes

#### TUI Commands

- **`/artifact list`** -- List all artifacts in current conversation
- **`/artifact view <name>`** -- View artifact content
- **`/artifact help`** -- Show command help

#### Storage

- One JSON file per artifact: `~/.claude-comms/artifacts/{conversation}/{name}.json`
- No content size limit on write; reads chunked at 50K chars default
- System messages auto-posted to chat on create/update/delete (sender type "system")
- System messages use reserved key `00000000` with type "system", published as raw JSON bypassing Message model validation

#### Tests

- **42 unit tests** in `tests/test_artifact.py` covering models, storage, CRUD, validation, version pruning, chunked reading, optimistic concurrency, and MCP tool integration
- All tools validate: caller key registered, conversation ID valid, artifact name valid, caller is conversation member

#### Design Decisions

- **Optimistic concurrency**: `base_version` param on update prevents silent overwrites when multiple participants edit the same artifact
- **Collaboration protocol**: draft -> discuss -> revise -> approve

### Final Overnight Summary (2026-03-30)

- **902 Python tests** (up from 818) -- 42 new artifact tests, 42 new conversation discovery tests, plus TUI +20, CLI +31, MCP server +20, and hundreds of gap/integration tests across all modules
- **Security fixes** -- XSS vulnerability patched in SearchPanel (unsanitized HTML injection); CORS lockdown applied to REST API endpoints
- **Performance audit complete** -- All 8 audit findings addressed: IntersectionObserver O(1) optimization, `$effect` timer cleanup, message cap (5000), reaction array spread replaced with O(1) self-assignment, 3-chunk Vite build split
- **CONTRIBUTING.md created** -- Developer onboarding guide with setup, testing, architecture, and contribution workflow
- **Coverage report** -- 68% overall (core modules 95-100%); coverage report committed to repo
- **30 Svelte components documented** -- JSDoc annotations on all public props, events, and exported functions
- **Dead code cleanup** -- mqtt-store-v2 and other unused modules moved to `_alt/` directory
- **CI lint gate** -- Lint job now properly blocks builds; 109 ruff errors fixed across `src/` and `tests/`
- **pyright 0 type errors** -- Full type checking passes clean across the Python codebase
- **README badges added** -- Test count, coverage, pyright, ruff, and license badges

### Added

### Fixed

- **Svelte 5 reactivity in class stores -- RESOLVED** -- `$derived` state inside the `MqttStore` class was not triggering component re-renders (e.g., message list, participant list). Root cause: Svelte 5 runes (`$state`, `$derived`) must live in `.svelte.js` files to be compiled as reactive. The store was in a plain `.js` file, so runes were treated as normal variables. Fix: renamed `mqtt-store.js` to `mqtt-store.svelte.js`, which enables the Svelte compiler to process runes correctly. A module-level alternative (`mqtt-store-v2.svelte.js`) also exists for future use if the class-based pattern needs revisiting.

### Known Issues

- **TCP-to-WebSocket message bridging** -- amqtt does not bridge messages between its TCP (:1883) and WebSocket (:9001) listeners. Clients on different transports cannot see each other's messages. All clients should use the same transport (WS recommended for web+TUI interop).

#### Overnight (2026-03-30 final): Lint Cleanup, Docker Config, TUI Polish, API Tests

- **109 ruff lint errors fixed** -- All `ruff check` and `ruff format` issues resolved across `src/` and `tests/`. CI lint job now passes clean.
- **CI workflow lint job gates properly** -- Lint job no longer set to `continue-on-error`; it now fails the build on lint violations as intended.
- **Web UI host configurable for Docker** -- Web server bind address now reads from `config.yaml` (`web.host`), defaulting to `0.0.0.0` in Docker containers for proper container accessibility.
- **TUI typing indicators + LWT** -- Typing indicator re-trigger bug fixed on send; Last Will and Testament publishes to global `system/participants/{key}` topic for cross-channel offline detection.
- **25 API endpoint tests** -- New test coverage for REST API endpoints (message history, identity, participants).
- **818 Python tests passing** (up from 714) -- 104 new tests across TUI, CLI, and MCP server modules.
- **174 total commits** for the overnight build session.

#### Overnight (2026-03-30 late): Presence REST API, Build Optimization, Cross-Browser Diagnostics

- **Presence REST API** (`/api/participants/{channel}`) -- New REST endpoint returns the participant list for a given channel, including `client` (web/tui/mcp) and `status` (online/offline) fields. Enables external tooling and health checks to query channel membership without an MQTT subscription.
- **Build optimization: 3-chunk split** -- Vite `manualChunks` config splits the JS bundle into `vendor-mqtt` (mqtt.js), `vendor-ui` (bits-ui + lucide-svelte), and the app chunk. Eliminates the 500KB chunk size warning from production builds.
- **Stale presence filtering** -- Both TUI and Web UI now filter out stale/offline presence entries from the participant list, fixing phantom participants that accumulated from retained MQTT messages of disconnected clients.
- **Cross-browser integration test diagnostics** -- Documented TCP-to-WebSocket bridging gap: the MQTT broker exposes TCP (:1883) and WS (:9001) as separate listeners, but amqtt does not bridge messages between transport types. All clients using the same transport (e.g., all WS) see each other's messages; cross-transport requires protocol bridging not yet implemented.

#### Overnight (2026-03-30): Test Expansion, REST API, Broker Resilience, UI Polish

- **746 Python tests** (up from 647) -- 36 expanded gap tests across broker, log exporter, MCP tools, notification hook, and CLI modules, plus 32 new tests in the final session
- **REST API for message history** (`/api/messages/{conversation}`) -- Web UI now persists messages on page refresh via new REST endpoints backed by the MQTT message store
- **Unified identity endpoint** (`/api/identity`) -- Single REST endpoint returns the daemon's configured identity (name, key, type, client), used by Web UI and TUI to display consistent identity info
- **MCP `comms_join` publishes MQTT presence** -- Joining a conversation now publishes a retained presence message to `system/participants/{key}`, making MCP-connected agents visible to TUI and Web UI clients
- **Client type display** -- Participants show their client type in the UI: "Phil (web)", "Phil (tui)", "claude-orchestrator (mcp)". Client field included in presence messages for all connection types.
- **Broker crash resilience** -- Daemon handles amqtt broker crashes on WebSocket disconnect gracefully with a retry loop instead of terminating the entire process
- **Connection banner auto-hide + dismiss** -- Connection status banner auto-hides after successful connect; dismiss button added for manual close
- **Mobile hamburger menu** -- Responsive navigation menu for narrow viewports
- **Emoji picker enlarged** -- Picker sizing increased for better usability; reaction badges improved with better visibility
- **Full code cleanup** -- Removed unused imports and dead code from both Python source files and Svelte components; moved misplaced import to top of EmojiPicker script block
- **12 user story E2E tests** (2 rounds) -- Comprehensive end-to-end user story coverage across Web UI flows
- **~981 total tests** -- 746 Python tests + 235 Playwright E2E tests across 25 spec files
- **Debug cleanup passes** -- Removed debug seed messages and console.debug logging injected by agents
- **14,076 lines of source code** / **8,768 lines of test code** -- 98+ commits overnight across 121 files changed

#### Overnight (2026-03-29 final): Critical Daemon Fix + Feature Completion

- **MCP server + Web UI now actually start** -- The daemon's `claude-comms start` command previously only printed "MCP server ready" and "Web UI available" as placeholder messages without launching either server. Now the daemon starts the MCP server (uvicorn + FastMCP on `:9920`) and the web UI static file server (Starlette on `:9921`) as async tasks alongside the broker. Graceful shutdown added for both servers. **(Placeholder audit #1 and #2 -- CRITICAL fix)**
- **UserProfileView component** (`web/src/components/UserProfileView.svelte`) -- Slide-out panel for viewing other participants' info (avatar, name, handle, role badge, type, key, status). "View Profile" on someone's ProfileCard now shows their profile instead of opening your own Settings. Own profile still opens SettingsPanel. Added to Escape priority chain.
- **7 user story E2E tests** (`web/e2e/user-stories.spec.js`) -- End-to-end flows: new user first experience, team discussion with threads, channel management, message reactions/interactions, search/navigation, customization/settings, mobile user at 480px viewport. All 7 passing with 26 screenshots.
- **Placeholder audit completed** -- 25 items identified across Python backend and Svelte frontend; high-priority items (#1 MCP server, #2 web UI, #4 forward, #6 search filters, #7 sidebar search, #8 settings name persist) now resolved
- **Sidebar channel search** -- Sidebar search input now filters starred and unstarred channels by case-insensitive name match using `$derived` reactive state **(Placeholder audit #7)**
- **Search panel filter tabs wired** -- All/Messages/Files/Code/Links tabs now actively filter results: URL regex for links, triple-backtick detection for code, attachment markers for files. Clicking a tab re-runs the search immediately **(Placeholder audit #6)**
- **ForwardPicker component** (`web/src/components/ForwardPicker.svelte`) -- Modal overlay listing all channels except current; forwards via `store.forwardMessage()` with confirmation toast. Replaces the "Forwarding coming soon" clipboard stub **(Placeholder audit #4)**
- **Settings name persistence** -- Display name changes in SettingsPanel now persist to localStorage, surviving page reloads **(Placeholder audit #8)**
- **Component polish** -- DateSeparator (gradient lines, ember glow, hover effect), ReadReceipt (animated staggered check marks, hover tooltip with reader names, theme support), LinkPreview (favicon via Google S2, image thumbnail, hover elevation, proper `<a>` element)
- **Store improvements** -- JSDoc on all public methods, `messageCount` derived state, `getChannelById()` and `getParticipantByKey()` helpers, improved MQTT error messages (ECONNREFUSED shows broker URL, WebSocket-specific errors, offline/reconnect messages)
- **Utils improvements** -- `formatRelativeTime()` for human-readable timestamps, `sanitizeHtml()` for safe rendering, `truncateText()` with word-boundary awareness, improved `parseMentions()` edge case handling
- **Notification sound toggle** -- Web Audio API beep (880Hz sine, 300ms decay) gated by `soundEnabled` state, `toggleSound()` export, click-to-focus on notification click, channel name prefix in notification body
- **Profile card buttons functional** -- "Message" button pre-fills `@name` in input; "View Profile" opens UserProfileView for other users or SettingsPanel for self

### Fixed

#### Overnight (2026-03-30 late)

- **TUI phantom participants** -- TUI participant list showed stale/offline entries from retained MQTT presence. Now filters the same way as the Web UI.
- **Presence API missing fields** -- `/api/participants/{channel}` initially returned only name/key; added `client` and `status` fields for full participant metadata.

#### Overnight (2026-03-30)

- **MCP presence not published on join** -- `comms_join` tool did not publish an MQTT retained presence message, making MCP-connected agents invisible to TUI/Web UI participant lists. Now publishes to `system/participants/{key}`.
- **Broker crash on WS disconnect** -- amqtt broker could crash the entire daemon process when a WebSocket client disconnected ungracefully. Added exception handling to keep the daemon running.
- **Svelte 5 reactivity for historical messages** -- Deferred `fetchHistory` state update so Svelte 5 reactivity correctly renders messages loaded from the REST API on page refresh.
- **Svelte cleanup** -- Removed unused imports and dead code; fixed misplaced import in EmojiPicker component.
- **Debug artifacts removed** -- Cleaned up debug seed messages and `console.debug` logging left by overnight agents.
- **Own presence overwrite** -- Skip own presence messages to prevent offline status from overwriting online status during reconnection.

#### Overnight (2026-03-29 final)

- **View Profile showed own settings** -- Clicking "View Profile" on any user's ProfileCard always opened the SettingsPanel. Now correctly shows the target user's profile via UserProfileView.
- **ForwardPicker Svelte 5 syntax** -- Used Svelte 4 event modifier syntax (`onmousedown|stopPropagation`) which broke the build. Fixed to Svelte 5 pattern.

#### Overnight: Comprehensive Test Expansion (668+ total tests, up from 661+)

- **504 Python tests** (up from 360) -- 113 new MQTT integration tests across 5 rounds: broker lifecycle (31), MCP tools logic (43), log exporter (24), CLI commands (19), gap coverage for error handling and edge cases (27)
- **19 new CLI tests** (`tests/test_cli.py`) -- init config creation, name options, key generation, force overwrite, status commands, env var overrides, deep merge
- **43 new TUI tests** (`tests/test_tui.py`) using Textual's `app.run_test()` with `Pilot` -- app rendering, channel switching, message sending, keyboard shortcuts (Ctrl+Q/N/K), edge cases (long messages, unicode, code blocks, @mention tab completion, unread badges, presence updates)
- **60 new comprehensive web E2E tests** (`web/e2e/overnight-comprehensive.spec.js`) -- 9 rounds covering sidebar, header, input, messages, panels, modals, member list, theme/responsive, keyboard
- **19 new members/theme/responsive tests** (`web/e2e/overnight-members-theme.spec.js`) -- member list, profile card (7 tests), theme toggle (3 tests), responsive layout at 5 viewpoints (5 tests)
- **10 new accessibility Playwright tests** (`web/e2e/a11y-keyboard.spec.js`) -- Tab focus movement, focus-visible rings, Enter activation, Escape handling, ARIA roles verification, sr-only class verification

#### Overnight: Accessibility Overhaul

- **ARIA roles added to 21 components** -- `role="log"` on ChatView, `role="article"` on MessageBubble, `role="toolbar"` on MessageActions, `role="search"` on SearchPanel, `role="complementary"` on PinnedPanel/ThreadPanel/SettingsPanel, `role="status"`/`role="alert"` on ConnectionStatus, `role="alert"` on NotificationToast, `role="separator"` on DateSeparator, `role="presentation"` on backdrops, `aria-modal`/`aria-label` on dialogs
- **All 7 svelte-ignore a11y suppressions removed** -- replaced with proper semantic roles and keyboard handlers (FileAttachment, MessageBubble, PinnedPanel, EmojiPicker, ProfileCard x2, SearchPanel)
- **`.sr-only` utility class** added to `app.css` for screen reader labels on emoji search, search input, and thread reply input
- **`aria-hidden="true"`** on decorative elements: DateSeparator SVGs, ReadReceipt SVGs, ConnectionStatus dots, ReactionBar emoji spans
- **`aria-label` on all icon-only buttons** -- ThemeToggle, ScrollToBottom, CodeBlock copy, ReactionBar buttons with emoji name + count, Avatar with profile name
- **`aria-pressed` state** on ReactionBar toggle buttons
- **Enhanced `focus-visible` CSS rules** -- 2px outline + box-shadow on buttons, inputs, textareas, and ARIA interactive roles

#### Overnight: TUI Improvements

- **12 sender colors** -- expanded from 8 to 12 (ember, gold, teal, rose, emerald, sky, violet, pink, bright amber, light blue, purple, green)
- **Sender type icons** -- robot emoji for Claude, person emoji for human
- **Channel message previews** -- last message preview under each channel name (sender: text, truncated to 22 chars) with `set_channel_preview()` API
- **Muted channel indicator** -- bell-off emoji with `--muted` CSS class and `set_channel_muted()` API
- **Unread badges** -- inline count display in channel header row
- **New `StatusBar` widget** (`tui/status_bar.py`) -- connection state (green/red dot), active channel with `#` prefix, participant count, typing indicators ("pencil username is typing..." in amber italic), current user identity
- **@mention highlighting** in amber/gold throughout message text
- **Warmer Carbon Ember styling** -- ember-tinted borders (`#2a2017`), updated sidebar backgrounds (`#1a1a1c`), themed Footer key hints, 1px scrollbar

#### Overnight: Web UI Polish

- **Improved empty states** -- ChatView shows MessageSquare icon with pulsing double-ring animation; SearchPanel shows contextual empty states for before-search and no-results
- **Improved connection states** -- animated bouncing dots during connecting, retry countdown with RefreshCw icon during disconnect, spinning reconnect indicator
- **Tooltips added** to SearchPanel close/filters, NotificationToast dismiss, FileAttachment download, DateSeparator (full date), LinkPreview, ReadReceipt
- **ScrollToBottom entrance animation** -- spring slide-up, hover bounce, badge animation
- **Toast progress bar** -- amber gradient countdown bar for auto-dismiss timing
- **CodeBlock theme-independence** -- visual regression fix ensuring code blocks render correctly across themes

#### Sprint 2: bits-ui Component Migration (Batch 1)

- **ContextMenu -> bits-ui ContextMenu** -- `ContextMenu.Root`/`Content`/`Item`/`Separator` with controlled open state, Floating UI viewport-aware positioning (replaces manual clamping), arrow key navigation between items, Enter/Space activation, Escape/click-outside dismiss via bits-ui layers, `data-highlighted` keyboard focus state
- **ChannelModal -> bits-ui Dialog** -- `Dialog.Root`/`Portal`/`Overlay`/`Content`/`Title`/`Close` with focus trap, `role="dialog"`, `aria-labelledby` auto-wiring, portal rendering into document body, Escape and backdrop dismiss handled natively
- **EmojiPicker -> bits-ui Popover** -- `Popover.Root`/`Content` with click-outside dismiss, `onOpenAutoFocus` for search input auto-focus, controlled `open` prop for parent state management
- **ProfileCard -> bits-ui Popover** -- `Popover.Root`/`Content` replacing manual backdrop div, click-outside and Escape dismiss via bits-ui layers, removed a11y suppression comments
- **MentionDropdown -> bits-ui Combobox** -- `Combobox.Root`/`Input`/`ContentStatic`/`Item` providing `role="listbox"`/`role="option"`, `aria-selected`, `aria-activedescendant`, `data-highlighted`, hidden input for keyboard event ownership (replaces manual keydown handler and index tracking)

#### Sprint 2: Lucide Icon Migration (Batch 2)

- **~37 inline SVGs replaced with lucide-svelte imports** across 15 components -- tree-shakeable, consistent sizing via `size` prop
- **App.svelte**: `Users`, `Search`, `Pin`, `Settings`
- **ThemeToggle.svelte**: `Sun`, `Moon`
- **Sidebar.svelte**: `Hash`, `VolumeX`, `Plus`, `Settings`
- **MemberList.svelte**: `Search`
- **MessageInput.svelte**: `Type`, `Code`, `Paperclip`, `Smile`, `SendHorizontal`
- **MessageActions.svelte**: `Reply`, `Smile`, `Ellipsis`
- **ScrollToBottom.svelte**: `ChevronDown`
- **ContextMenu.svelte**: `Reply`, `Forward`, `Pin`, `Copy`, `Smile`, `MailOpen`, `Trash2`
- **ProfileCard.svelte**: `Star`
- **PinnedPanel.svelte**: `Pin`, `X`
- **SearchPanel.svelte**: `X`
- **ThreadPanel.svelte**: `MessageSquare`, `Send`, `X`
- **CodeBlock.svelte**: `Copy`, `Check`
- **FileAttachment.svelte**: `File`, `Download`

#### Sprint 2: Dead Buttons Wired (Batch 3)

- **SettingsPanel** (new component) -- slide-out panel with profile editing, notification toggles, appearance section, connection status; wired to header settings button and Sidebar gear button
- **Member list toggle** -- header member count pill toggles `MemberList` visibility via `showMemberList` state
- **Member search** -- search input in MemberList filters online/offline members by name with `$derived` reactive filtering
- **Attach file button** -- hidden file input triggered by attach button; shows "File sharing coming soon" notice
- **Format help button** -- toggles Markdown formatting reference popover (`` **bold** *italic* `code` ``)
- **Code snippet insertion** -- inserts fenced code block template at cursor position in message input
- **Context menu Forward action** -- copies message body to clipboard with toast notification
- **Context menu Mark Unread action** -- calls `store.markUnread(message)` setting `unreadFrom` cursor
- **Context menu Delete action** -- opens ConfirmDialog (new bits-ui Dialog component) for confirmation, then calls `store.deleteMessage(messageId)`
- **ConfirmDialog** (new component) -- reusable confirmation dialog using bits-ui Dialog, with danger styling option
- **Channel mute toggle** -- mute buttons on sidebar channels call `store.muteChannel(channelId)`, visual `.muted` class with reduced opacity, VolumeX icon indicator
- **File download handler** -- FileAttachment download button triggers programmatic `<a>` download with `url` prop
- **More button -> context menu** -- MessageActions More button opens context menu at button position via `onMore` -> `onContextMenu`
- **Store methods added**: `markUnread()`, `deleteMessage()`, `muteChannel()`, `forwardMessage()` in `mqtt-store.svelte.js`

#### New Dependencies

- **bits-ui** -- headless Svelte 5 UI primitives (ContextMenu, Dialog, Popover, Combobox) for accessibility, keyboard nav, ARIA roles, focus trapping, floating positioning
- **lucide-svelte** -- tree-shakeable SVG icon library (1500+ icons as Svelte components)

#### Comprehensive Functional Browser Testing (10 Parallel Agents)

- **10 parallel testing agents** deployed for functional browser testing across the entire web UI -- **121+ Playwright tests** written, **12 bugs found and fixed**
- **20 Playwright E2E spec files** (`web/e2e/`) covering: messages (10 tests), emoji picker (10), channel switching (7), console smoke test (18 interactions), app loading (5), sidebar (8), chat (6), panels (11), modals (7), member list (6+11), context menu (5), console errors (3), channel modal flow (11), keyboard shortcuts (10), theme/responsive (7), user stories (7)
- **120+ test screenshots** captured across all testing areas (`mockups/test-*.png`, `mockups/screenshot-*.png`)
- **668+ total tests** across the project: 504 Python + 43 TUI + 121+ Playwright browser E2E
- **Zero JS runtime errors** confirmed across all 18 interaction types during comprehensive smoke testing
- **`playwright.config.js`** -- Headless Chromium, screenshots on failure, video on failure, 1 retry, 30s timeout, built-in web server config, CDP workaround for mqtt.js event loop blocking
- **npm test scripts** -- `test` (headless), `test:ui` (Playwright UI mode), `test:headed` (visible browser)
- **`data-testid` attributes** -- 60+ attributes added across all 18 interactive Svelte components for reliable Playwright test selectors (replaces fragile CSS class selectors). All E2E test files use `[data-testid="..."]` selectors.

#### Reaction System

- **`addReaction()` method** in `mqtt-store.svelte.js` -- creates/toggles reactions on messages with proper count tracking and active state
- **`onReact` prop threading** through `MessageBubble` -> `MessageGroup` -> `ChatView` -> `App.svelte` for full reaction callback chain
- **React button wired** in `MessageActions.svelte` -- previously had no `onclick` handler
- **`handleEmojiSelect`** in `App.svelte` now calls `store.addReaction()` instead of being a TODO

#### Defensive Programming (Python Backend)

- **6 Python modules hardened** -- `participant.py` and `message.py` validators accept `None` safely; `log_exporter.py` handles missing/malformed fields gracefully; `hook_installer.py` validates inputs and wraps file I/O in try/except; `broker.py` validates `generate_client_id()` inputs; `mcp_server.py` replaces bare `assert` with proper `RuntimeError` (asserts are stripped with `python -O`)

### Fixed

#### Overnight Bug Fixes

- **TUI Ctrl+K binding conflict** -- Textual's built-in `Input` widget binds `ctrl+k` to `delete_right_all`, intercepting the app-level Ctrl+K conversation switching shortcut. Fixed by adding `priority=True` to the binding in `app.py`.
- **Unused CSS selector** -- `.header-members svg` in App.svelte was unused because Svelte scopes CSS; changed to `.header-members :global(svg)` to pierce scoping.

#### Bugs Found by Parallel Testing Agents

- **`addReaction` method missing** -- Store had no method to add/toggle reactions on messages; emoji picker selection was a TODO that never persisted reactions
- **React button had no onclick handler** -- `MessageActions.svelte` "React" button did nothing when clicked
- **localStorage key not persisted** -- Each browser session generated a new random key via `generateKey()`, creating phantom participants that accumulated as retained MQTT presence messages. Fixed by persisting user key in localStorage.
- **Ctrl+K shortcut missing** -- No keyboard shortcut existed to open the search panel. Added global `handleGlobalKeydown` with `svelte:window onkeydown` binding for Ctrl+K / Cmd+K toggle.
- **Escape key priority ordering** -- Multiple components independently listened for Escape, causing all open panels to close simultaneously. Centralized Escape handling in `App.svelte` with priority order: modal > context menu > emoji picker > profile card > pinned panel > search panel > thread panel.
- **Focus return after closing panels** -- After pressing Escape to close a panel, focus was lost to `document.body`. Now returns focus to the message input after any Escape-triggered close.
- **ThemeToggle not wired** -- `ThemeToggle.svelte` component existed but was never imported or rendered in `App.svelte`. Wired into the chat header actions bar.
- **No light theme CSS** -- Only dark theme variables existed. Added `:root[data-theme="light"]` rule block with full light color palette and converted hardcoded backgrounds in Sidebar, MemberList, and chat header to CSS variables.
- **Mobile viewport overflow** -- At 320px and 480px viewports, content overflowed the screen width. Fixed sidebar to `display: none` at 480px, hid header elements, reduced padding, added `overflow: hidden` on layout containers.
- **Context menu viewport edge clamping** -- Context menu positioned at raw cursor coordinates without boundary clamping, rendering off-screen near viewport edges. Added `$derived` clamped coordinates constraining the menu within 8px of all edges.
- **Search panel z-index / close button unclickable** -- Search panel (`z-index: 50`) sat behind the chat header (`z-index: 101`), making its close button unreachable. Repositioned panel below the header.
- **Search input not auto-focused** -- Opening the search panel did not focus the input field. Added `onMount` handler with `bind:this` to auto-focus.
- **Header glow pseudo-element intercepting clicks** -- `.chat-header::after` glow effect could intercept pointer events. Added `pointer-events: none`.
- **Duplicate channels in sidebar** -- Starred channels appeared in both "Starred" and "Conversations" sections because conversations list rendered all channels instead of filtering out starred ones. Added `$derived` `unstarredChannels` filter.
- **Messages don't appear without MQTT broker** -- `sendMessage()` only published to MQTT with no local echo. Added immediate local store update via `#handleChatMessage()` with deduplication, and removed the broker-required guard so the UI works offline.
- **Toast notifications never auto-dismiss** -- `addToast`/`dismissToast` used in-place array mutations (`push`/`splice`) on `$state` arrays inside `setTimeout` closures, which didn't reliably trigger Svelte 5 reactivity. Switched to immutable updates (`[...arr]`/`filter()`).

#### Visual Polish and Mockup Fidelity

- **Unicode rendering** -- Fixed 4 Svelte template escape sequences rendering as literal `\uXXXX` text: `\u2318K` -> `⌘K`, `\u2605` -> `★`, `\u25BE` -> `▾` (2 instances). Replaced 25 surrogate pair unicode escapes in EmojiPicker with actual emoji characters.
- **Message bubble shadows** -- Adjusted to match R10 mockup (simplified shadow, tweaked human inset glow)
- **Consecutive bubble corners** -- Added rounded corner treatment for grouped messages
- **Chat header** -- Fixed letter-spacing, added border-bottom from spec, matched background gradient
- **Input area** -- Changed to gradient background with proper border-top per mockup
- **Scanline overlay removed** -- `.center::after` repeating-linear-gradient not in design spec
- **Mask fade reduced** -- Messages container mask-image fade from 20px to 8px to avoid obscuring content
- **Connection status banner** -- Reduced prominence when connected (lower opacity, smaller padding/font)
- **Empty state** -- Added "No messages yet" placeholder for channels with no messages
- **Mobile responsive** -- Member list hidden on narrow viewports; sidebar overlays content below 480px

#### Infrastructure Discovery: mqtt.js Event Loop Blocking

- **mqtt.js blocks browser event loop** during WebSocket reconnection cycles (~3s interval), causing Playwright's `page.click()`, `page.fill()`, and `page.evaluate()` to hang indefinitely
- **Workaround documented**: (1) WebSocket mock via `addInitScript` prevents MQTT from connecting, (2) CDP `Runtime.evaluate` bypasses Playwright's actionability wait system
- **Browser crashes under memory pressure** -- Chromium renderer processes killed after ~3s in WSL2 with low RAM when MQTT reconnection + Svelte rendering + CSS animations combine; all existing tests complete within the window

#### Batch 4: Docker, CI, and Integration Tests

- **`Dockerfile`** -- Multi-stage build: Stage 1 (`node:22-slim`) compiles the Svelte web UI, Stage 2 (`python:3.12-slim`) installs the Python package. Exposes ports 1883 (MQTT TCP), 9001 (MQTT WS), 9920 (MCP), 9921 (Web UI). Health check probes MQTT broker every 30s.
- **`docker-compose.yml`** -- Single-service deployment with named volume `comms-data` for persistent config/logs, `CLAUDE_COMMS_PASSWORD` env var, `restart: unless-stopped` policy.
- **`.github/workflows/ci.yml`** -- GitHub Actions CI pipeline:
  - **Lint job**: `ruff check` + `ruff format --check` on `src/` and `tests/`
  - **Test job**: Matrix across Python 3.10, 3.11, 3.12 with pip caching; uploads JUnit XML results as artifacts (30-day retention)
  - **Build Web job**: Node 22 with npm caching; builds Svelte app; uploads dist as artifact
  - Concurrency control: cancels in-progress runs for same git ref
- **Integration test suite** (`tests/test_integration.py`) -- 45 tests covering cross-module interactions: config init flow, message roundtrip, mention resolution pipeline, log exporter integration, shared deduplicator, participant registry, hook installer, and MCP tools pipeline
- **E2E test suite** (`tests/test_e2e.py`) -- 22 tests covering full system flows with a `MockBroker` simulating MQTT pub/sub: two-participant chat, targeted messaging, conversation lifecycle, presence flow, name changes, log format verification, JSONL replay, notifications, and a complete end-to-end session

#### Batch 3: TUI Client and Svelte Web Client

- **TUI Client** (`src/claude_comms/tui/`) -- Textual-based terminal chat with 3-column layout (channels, chat, participants), direct MQTT connection via aiomqtt `@work()` async worker, per-conversation message storage, deterministic sender colors (MD5 hash to Carbon Ember palette), triple-backtick code block rendering (Rich Syntax, Monokai), @mention Tab completion, unread badges, presence indicators, modal new-conversation dialog
- **Svelte 5 Web Client** (`web/`) -- 35-file Svelte 5 + Vite SPA implementing the "Obsidian Forge" design language. Svelte 5 runes (`$state`, `$derived`, `$effect`), Tailwind CSS v4 with `@theme` directive, mqtt.js direct WebSocket connection to broker. Components include: channel sidebar, message bubbles with grouping, @mention autocomplete, emoji picker, thread panel, search panel, context menu, profile cards, notification toasts, scroll-to-bottom button, file attachments, link previews, read receipts, reaction bars, date separators. All mockup animations replicated (ambient drift, brand breath, badge pulse, typing wave, send shine, etc.)

### Fixed

#### Web Client Bug Sweep

- **MQTT topic routing** -- `#handleMessage` used fragile `parts[2] === 'conv' || parts[1] === 'conv'` condition which missed `system/participants/+` topics entirely (participant registry never populated). Replaced with proper prefix-strip and direct `topicParts[0]` matching.
- **MQTT typing channel extraction** -- `#handleTyping` used `this.activeChannel` instead of extracting the channel from the MQTT topic, causing typing indicators to always appear in the viewer's active channel instead of the actual typing channel.
- **MQTT LWT topic** -- Last Will and Testament published to a channel-specific presence topic (`conv/{channel}/presence/{key}`), which only notified that single channel. Changed to `system/participants/{key}` so offline status is visible globally.
- **Sidebar onShowProfile event mismatch** -- Sidebar passed raw participant object to `onShowProfile` while App.svelte's handler expected `e.detail` wrapper. Normalized all event callback props to pass data directly (no `{ detail: ... }` wrapper) across Sidebar, MemberList, MessageBubble, ContextMenu, and EmojiPicker.
- **A11y: clickable divs/spans without keyboard handlers** -- Added `onkeydown` handlers (Enter/Space) to all interactive `div`/`span` elements: channel items (Sidebar), member items (MemberList), sender name and thread indicator (MessageBubble), user avatar (Sidebar).
- **A11y: non-semantic clickable elements** -- Converted header-members from `div` to `button` (App.svelte), section collapse arrows from `span` to `button` (Sidebar), search filter pills from `span` to `button` (SearchPanel).
- **A11y: labels without associated controls** -- Added `for`/`id` associations to Channel Name and Description labels in ChannelModal.
- **A11y: icon-only button without label** -- Added `aria-label="Send reply"` to ThreadPanel send button.
- **A11y: noninteractive tabindex on Avatar** -- Split Avatar into two branches (clickable with role/tabindex/onkeydown vs. static without) to eliminate the noninteractive tabindex warning.

- **Dependency conflict resolved** -- Changed `mcp[cli]` to `mcp` (without the `[cli]` extra) and pinned `typer>=0.15.0,<0.16.0` in `pyproject.toml`. The `[cli]` extra required `typer>=0.16.0` which conflicted with `amqtt`'s pin on `typer==0.15.4`.

### Design

- **Obsidian Forge design finalized** -- Evolved from "Phantom Ember" through 17 iterative adversarial refinement rounds across 11 initial concepts. Final design language: dark as polished obsidian, warm as ember glow, alive with subtle breath. Applied to both TUI (Carbon Ember palette) and Web UI (full Obsidian Forge).

---

## [0.1.0] -- 2026-03-29

Initial release. Built across three development batches by 8 parallel Claude Code agents.

### Added

#### Core Infrastructure
- **`pyproject.toml`** -- Hatchling build system, all dependencies (`amqtt`, `aiomqtt`, `mcp`, `typer>=0.15.0,<0.16.0`, `pyyaml`, `rich`, `pydantic`), optional extras (`tui`, `web`, `all`, `dev`), entry point `claude-comms`, pytest config
- **`src/claude_comms/__init__.py`** -- Package init with `__version__ = "0.1.0"`
- **`src/claude_comms/__main__.py`** -- `python -m claude_comms` entry point

#### Configuration (`config.py`)
- YAML config management at `~/.claude-comms/config.yaml`
- `load_config()` with deep merge against defaults for forward compatibility
- `save_config()` with automatic `chmod 600` enforcement
- `get_default_config()` with `secrets.token_hex(4)` identity key generation
- Password resolution chain: `CLAUDE_COMMS_PASSWORD` env var > YAML value > warning
- WSL2 chmod fallback with warning when file permissions cannot be set

#### Message Model (`message.py`)
- Pydantic v2 `Message` model with `Sender` embedded model
- Fields: `id` (UUID4), `ts` (ISO 8601 with timezone), `sender`, `recipients`, `body`, `reply_to`, `conv`
- `Message.create()` convenience constructor with auto-generated ID and timestamp
- `to_mqtt_payload()` / `from_mqtt_payload()` JSON serialization (string and bytes)
- `topic` property generating `claude-comms/conv/{conv}/messages`
- `is_broadcast` / `is_for(key)` routing helpers
- Conversation ID validation: `^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$` regex, reserved names (`system`, `meta`)
- Recipient key validation: 8 lowercase hex characters

#### Participant Model (`participant.py`)
- Pydantic v2 `Participant` model with `key`, `name`, `type` fields
- Key generation via `secrets.token_hex(4)` (8 lowercase hex chars, ~4 billion combinations)
- `Participant.create()` with auto-generated key
- `with_name()` for immutable name changes (key preserved)
- MQTT serialization and `registry_topic` property

#### @Mention System (`mention.py`)
- `extract_mentions(body)` -- pulls display names from `[@name1, @name2]` prefix
- `strip_mentions(body)` -- removes prefix, returns bare text
- `build_mention_prefix(names)` -- constructs `[@name1, @name2] ` prefix
- `resolve_mentions(body, name_to_key)` -- resolves names to participant keys with deduplication

#### Embedded Broker (`broker.py`)
- **`EmbeddedBroker`** -- lifecycle wrapper around `amqtt.broker.Broker`
  - `from_config()` factory, `start()` / `stop()` async lifecycle, PID file management
  - TCP (`:1883`) and WebSocket (`:9001`) listeners
  - Config-driven auth, JSONL log replay on startup
- **`MessageDeduplicator`** -- bounded LRU seen-ID set (default 10,000 entries), thread-safe
- **`MessageStore`** -- in-memory per-conversation message history (configurable cap, default 1,000)
- **`replay_jsonl_logs()`** -- reconstructs message history from `.jsonl` files on startup
- **`generate_client_id()`** -- unique MQTT client IDs: `claude-comms-{component}-{key}-{random}`

#### Log Exporter (`log_exporter.py`)
- **`LogExporter`** class with `write_message()` and `write_presence()` methods
  - Per-conversation `.log` (human-readable) and `.jsonl` (structured) files
  - UUID-based deduplication via shared `MessageDeduplicator`
  - Conversation ID validation (prevents path traversal)
  - Automatic header generation on first write
- **`format_log_entry(msg)`** -- renders timestamped message blocks with 4-space body indent
- **`format_log_header(conv_id, ts)`** -- renders `====` separator header
- **`format_presence_event(name, key, event, ts)`** -- renders `--- name (key) joined/left ---` lines
- **Log rotation** -- numbered suffix rotation (`.1`, `.2`, ...) at configurable size
- Format modes: `"text"`, `"jsonl"`, `"both"` (default)

#### MCP Server (`mcp_server.py`)
- FastMCP server with `stateless_http=True` and `json_response=True`
- Binds to `127.0.0.1:9920` (localhost security boundary)
- MQTT subscriber background task with auto-reconnect (2s backoff)
- Separate persistent publish client for outbound messages
- JSONL log replay into `MessageStore` on startup

#### MCP Tools (`mcp_tools.py`)
- **`ParticipantRegistry`** -- thread-safe in-memory participant tracking with per-conversation membership, name-to-key index, read cursors, mixed name/key recipient resolution
- **9 tool implementations:**
  - `comms_join` -- join conversation, name-based idempotency
  - `comms_leave` -- leave conversation
  - `comms_send` -- send message with name-to-key resolution and @mention prefix
  - `comms_read` -- read messages with count/since pagination + token-aware truncation
  - `comms_check` -- unread counts across conversations
  - `comms_members` -- list conversation participants
  - `comms_conversations` -- list joined conversations with unread counts
  - `comms_update_name` -- change display name (key preserved)
  - `comms_history` -- search message history by text/sender with token truncation
- Token-aware pagination: ~4 chars/token, 80,000 char cap (~20k tokens)

#### CLI (`cli.py`)
- **`init`** -- generate identity key, create config, set permissions
- **`start`** -- start daemon (broker + MCP), foreground or `--background`, optional `--web`
- **`stop`** -- SIGTERM with 10s grace period, SIGKILL escalation, stale PID cleanup
- **`send`** -- publish message via short-lived aiomqtt client, `-c` conversation, `-t` recipient
- **`status`** -- daemon PID, broker config, MCP endpoint, web UI, identity, broker connectivity probe
- **`tui`** -- launch Textual TUI
- **`web`** -- open browser to web UI URL
- **`log`** -- `tail -f` with Python polling fallback
- **`conv list`** -- discover from log files + config
- **`conv create`** -- validate conv_id, publish retained metadata to broker
- **`conv delete`** -- confirmation prompt (skip with `--force`), clear retained metadata

#### Notification Hook (`hook_installer.py`)
- **`install_hook()`** -- generates platform-appropriate script (bash/cmd), installs to `~/.claude/hooks/`, updates `~/.claude/settings.json` with PostToolUse entry
- **`uninstall_hook()`** -- removes script file and settings.json entry
- Unix script: drain stdin, check notification file, read + truncate atomically, format messages, output JSON with `additionalContext`
- Windows script: same flow using `more > nul` and PowerShell
- Idempotent (replaces existing entries, no duplicates), 5-second timeout

#### TUI Client (`tui/`)
- **`app.py`** -- 3-column layout (channels | chat | participants), MQTT via aiomqtt `@work()`, keybindings (Ctrl+Q quit, Ctrl+N new conversation, Ctrl+K cycle), modal new-conversation dialog
- **`chat_view.py`** -- Rich Panels with deterministic sender colors (MD5 hash -> Carbon Ember palette), code block highlighting (Monokai), per-conversation message storage, client-side dedup
- **`channel_list.py`** -- conversation sidebar with active highlight and amber unread badges
- **`participant_list.py`** -- presence indicators: green (online), amber (away), gray (offline)
- **`message_input.py`** -- @mention Tab completion cycling through matching participant names
- **`styles.tcss`** -- Carbon Ember themed Textual CSS

#### Web UI (`web/`)
- Svelte 5 + Vite project scaffolding
- "Obsidian Forge" design language

#### Design Mockups (`mockups/`)
- 11 initial design concepts (A through K): Discord, Modern Light, Cyberpunk, Midnight Amethyst, Carbon Ember, Deep Ocean, Obsidian Rose, Phantom Jade, Obsidian Ember, Phantom Ember, Ember Fusion
- 17 refinement rounds on Concept J (Phantom Ember -> Obsidian Forge)
- Final interactive mockup: `concept-j-phantom-ember-v2-r10-interactive.html`

#### Python Test Suite (360 tests, ~0.5s)
- **`tests/conftest.py`** -- shared fixtures (registry, store, publish_spy, tmp_config)
- **`tests/test_config.py`** (21 tests) -- config path, identity key, save/load, permissions, deep merge, password resolution
- **`tests/test_message.py`** (33 tests) -- creation, JSON round-trip, validation, routing
- **`tests/test_mention.py`** (21 tests) -- extract, strip, build, resolve with edge cases
- **`tests/test_participant.py`** (26+ tests) -- key generation, validation, model, serialization
- **`tests/test_broker.py`** (50+ tests) -- deduplicator, store, JSONL replay, broker lifecycle
- **`tests/test_log_exporter.py`** (46 tests) -- formatting, rotation, dedup, conv validation
- **`tests/test_mcp_tools.py`** (42 tests) -- all 9 tools, registry, token pagination
- **`tests/test_notification_hook.py`** (45 tests) -- script generation, settings manipulation, install/uninstall
- **`tests/test_integration.py`** (45 tests) -- cross-module integration: config flow, message roundtrip, mention pipeline, log exporter, dedup, registry, hook installer, MCP tools pipeline
- **`tests/test_e2e.py`** (22 tests) -- end-to-end flows with MockBroker: two-participant chat, targeted messaging, conversation lifecycle, presence, name changes, JSONL replay, notifications

#### Playwright Browser E2E Tests (16 spec files, 120+ screenshots)
- **`web/e2e/messages.spec.js`** (10 tests) -- type, send, grouping, wrapping, @mentions, empty guard, alignment, timestamps, auto-scroll
- **`web/e2e/emoji-picker.spec.js`** (10 tests) -- open/close, emoji selection, reactions, category tabs, search, frequent emojis
- **`web/e2e/smoke-test-all-interactions.spec.js`** (18 interactions) -- comprehensive console error monitoring across all UI interactions
- **`web/e2e/test-members.spec.js`** (11 tests) -- avatars, presence dots, profile card positioning/closing, role badges, mobile hiding
- **`web/e2e/sidebar.spec.js`** (8 tests) -- channel list, active highlight, collapse/expand, new conversation, search, user profile
- **`web/e2e/modals.spec.js`** (7 tests) -- channel modal lifecycle, form fields, cancel, backdrop/Escape close, toggle
- **`web/e2e/chat.spec.js`** (6 tests) -- input, Enter/button send, message container, bubble display, hover actions
- **`web/e2e/panels.spec.js`** (6 tests) -- search/pinned panel open/close, toggle behavior, channel switching with panel
- **`web/e2e/member-list.spec.js`** (6 tests) -- sidebar visible, header count, sections, profile card open/contents/close
- **`web/e2e/app-loads.spec.js`** (5 tests) -- page load, 3-column layout, header, input, no console errors
- **`web/e2e/context-menu.spec.js`** (5 tests) -- right-click menu, items, close behaviors
- **`web/e2e/console-errors.spec.js`** (3 tests) -- navigate all interactions without JS errors, rapid operations
- **`web/e2e/channel-modal-flow.spec.js`** (11 tests) -- open modal, form fields, type name/description, private toggle, cancel, backdrop close, Escape close, create channel, active state, empty name validation
- **`web/e2e/keyboard.spec.js`** (10 tests) -- Ctrl+K opens search, Escape priority ordering, focus return to input, Enter/Shift+Enter, Tab navigation, focus rings, Ctrl+K while typing
- **`web/e2e/theme-responsive.spec.js`** (7 tests) -- dark/light theme toggle, 5 viewport sizes (1920-320px), resize transitions, no mobile overflow
- **`web/e2e/user-stories.spec.js`** (7 tests) -- E2E user stories: new user first experience, team discussion with threads, channel management, reactions/interactions, search/navigation, customization/settings, mobile user

### Architecture Decisions

- **MQTT 3.1.1** via amqtt -- embedded, no external broker required
- **Stateless MCP** via FastMCP with `stateless_http=True` -- each request independent, multiple Claude Code instances share one server
- **Server-side deduplication** as primary defense against QoS 1 at-least-once redelivery
- **Localhost security boundary** for MCP server (no auth layer)
- **LWT (Last Will and Testament)** for automatic offline detection
- **Retained messages** for presence state persistence
- **Token-aware pagination** to stay within MCP 25,000-token output limit
- **Config forward compatibility** via deep merge with defaults
- **Lazy imports** throughout CLI for fast startup and graceful degradation

### Design Process

- 11 initial UI concepts explored across different aesthetic directions
- Concept J (Phantom Ember) selected as winner
- 17 iterative adversarial refinement rounds producing "Obsidian Forge" final design
- Architecture plan survived 7 adversarial review rounds before APPROVED status

### Project Stats

- **64 source files** across Python, Svelte, JS, CSS, and shell scripts
- **668+ total tests**: 504 Python (12 test modules, ~0.5s) + 43 TUI (Textual run_test) + 121+ Playwright browser E2E (20 spec files) with **120+ test screenshots**
- **10 parallel testing agents** deployed for comprehensive functional browser testing, finding and fixing **12 bugs**
- **Zero JS runtime errors** confirmed across all interaction types
- **27 Svelte components** (26 in `components/` + `App.svelte`) with **60+ `data-testid` attributes**
- **18 Python source files** (14 modules + TUI subpackage)
- **63 agent work logs** documenting all development and testing activity
- **4 deployment targets**: pip install, Docker, docker-compose, VPS

### Known Issues

- WSL2 with Windows-mounted filesystems may not support `chmod 600` on config files (falls back to warning)
- Architecture plan example key `phil0e8a` contains non-hex characters -- all real keys use `[0-9a-f]{8}` only
- **mqtt.js event loop blocking** -- The mqtt.js library blocks the browser event loop during WebSocket reconnection, which affects Playwright testing (workaround: WebSocket mock + CDP `Runtime.evaluate`). Does not affect normal user interaction.
- **Retained presence accumulation** -- Previously, each browser session generated a new unique key. Now fixed via localStorage persistence (key survives reloads), but old phantom retained messages from prior sessions are not cleaned up. TTL-based cleanup still recommended for long-running deployments.

[0.1.0]: https://github.com/Aztec03Hub/claude-comms/releases/tag/v0.1.0
