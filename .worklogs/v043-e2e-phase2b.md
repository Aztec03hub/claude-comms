# v0.4.3 E2E Phase 2 Agent B worklog

**Branch:** main (shared tree, N=2 wave with parallel bug-fix-mini
agent `a3d340ca`). File-disjoint: bug-fix-mini owns `.svelte` source;
Agent B owns `web/e2e/scenarios/05-07.spec.ts` + their baseline PNG
dirs + this worklog.
**Files owned:** `web/e2e/scenarios/05-invite-participant.spec.ts`,
`web/e2e/scenarios/06-status-editor.spec.ts`,
`web/e2e/scenarios/07-chat-header-buttons.spec.ts`,
`web/e2e/__screenshots__/{05,06,07}-*` baseline PNG dirs,
this worklog.
**Files OFF-LIMITS (and not touched):** Phase 1 fixtures, scenarios
01-04, `web/playwright.config.js`, any .svelte / .js / .py source,
any vitest spec, `CHANGELOG.md`, `pyproject.toml`,
`web/package.json`, `USAGE.md`, `web/src/components/ChannelModal.svelte`,
`web/src/components/ChannelAdminPanel.svelte` (parallel agent owns).
**Goal:** scenarios 05 (invite) + 06 (status-editor) +
07 (chat-header-buttons) with screenshot baselines.

## What shipped

### `web/e2e/scenarios/05-invite-participant.spec.ts` (~520 LOC)

Phil Layer B item #6 (InviteParticipantDialog regression-prevent).

Functional tests (13):
- `Right-click channel row to Invite participant... opens the dialog`
  (P-8 pre-click state assertions on every dialog surface)
- `Picker excludes the caller and existing channel members`
- `Search-as-you-type filters the picker (case-insensitive substring
  on name)` — exercises both empty / matched / no-match states
- `Submit fires POST /api/invite with conversation_id + invitee_key +
  note` — P-3 dual-coverage via page.route() intercept; pins the
  exact wire shape from the brief
- `Success path: 200 closes dialog + shows success toast`
- `403 path: caller-not-member surfaces permission error`
- `404 path: conv-not-found surfaces channel-gone error`
- `400 path: malformed request surfaces invalid-input error` — note:
  apiPost throws `Error('HTTP 400')` not "Server returned HTTP" so
  the toast surface reads "HTTP 400"; documented inline
- `409 path: already-a-member surfaces idempotency error`
- `Cancel button closes the dialog without firing /api/invite`
- `Escape key closes the dialog without firing /api/invite`
- `Note field counter increments + caps at 200 chars (NOTE_MAX)`
- `Submit is disabled until a candidate is selected`

Screenshot baselines (3):
- `invite-dialog-open.png`
- `invite-dialog-picker-filtered.png`
- `invite-dialog-with-selection.png`

Source-level invariants (6 tests, P-1 + P-2):
- `InviteParticipantDialog pins NOTE_MAX = 200`
- `InviteParticipantDialog pins the data-testid surface`
- `InviteParticipantDialog filter is case-insensitive substring on name`
- `ChannelContextMenu dispatches claude-comms:invite-participant bus event`
- `App.svelte listens for claude-comms:invite-participant and mounts
  InviteParticipantDialog`
- `store.inviteParticipant uses POST /api/invite with snake_case wire shape`

Total: 22 tests.

### `web/e2e/scenarios/06-status-editor.spec.ts` (~480 LOC)

Phil Layer B item #7 (StatusEditor regression-prevent).

Functional tests (11):
- `Click inline status row opens StatusEditor with all surfaces`
  (P-8 pre-click state on every surface)
- `Pick an emoji from the 8-emoji strip - selected gets active class`
  (P-8 active-state assertion)
- `Type text - live char counter updates from 0 to length`
- `Text input maxlength="60" rejects the 61st character`
- `Save with emoji + text + 1h expiry fires
  comms_profile_status_set with snake_case args` (P-3 dual-coverage
  via MCP route intercept; pins the exact `expires_at` wire shape
  from the brief; bounds-checks the 1h delta against Date.now)
- `After Save the sidebar status row shows the picked emoji + text
  (optimistic local update)`
- `Click Clear fires comms_profile_status_clear + status row reverts
  to "Set a status"` (P-3 dual-coverage)
- `Cancel button closes editor without firing any MCP call`
- `Escape key closes editor without firing any MCP call`
- `Save with only emoji (no text) still fires set and shows emoji-only row`
- `Save button disabled when both emoji and text are empty (canSave gate)`

Screenshot baselines (3):
- `status-editor-open.png`
- `status-editor-with-values.png`
- `sidebar-status-row-set.png`

Source-level invariants (6 tests, P-1 + P-2):
- `StatusEditor pins MAX_TEXT_LEN = 60`
- `StatusEditor pins the 8-emoji strip` (length + first-glyph check)
- `StatusEditor pins the 4 expiry presets`
- `StatusEditor pins the data-testid surface`
- `Sidebar mounts StatusEditor on profile-status row click`
- `store wires comms_profile_status_set / _clear with snake_case args`

Total: 20 tests.

### `web/e2e/scenarios/07-chat-header-buttons.spec.ts` (~430 LOC)

Phil Layer B item #8 (ChatHeader button row visibility, cascade-fix).

Functional tests (12):
- `All 6 ChatHeader buttons are VISIBLE on a viewed channel
  (cascade-fix proof)` — W-2 mitigation: `toBeVisible()` for the 5
  always-visible buttons; mobile-menu hidden by media-query at the
  1280px viewport but `toHaveCount(1)` confirms DOM presence
- `Mobile-menu button becomes VISIBLE on narrow viewport (<=768px)`
  — exercises the `@media (max-width: 768px)` CSS rule
- `Search button click opens SearchPanel`
- `Pinned button click opens PinnedPanel`
- `Artifacts button click opens ArtifactPanel` (closed via the panel's
  own close button to avoid pointer-intercept overlap with the
  artifact-panel overlay)
- `Settings button click opens SettingsPanel`
- `Theme toggle flips data-theme on <html> between dark and light`
- `Mobile-menu button click opens the mobile sidebar wrapper`
- `Topic inline edit: Enter saves the new topic (post-BUG-PHASE2A-2
  fix)` — ChatHeader's `commitEditTopic` already snapshots-then-clears
  edit state, and `handleTopicBlur` guards on editingTopic; both
  patterns mirror the parallel-agent's fix to ChannelAdminPanel
- `Topic inline edit: Escape cancels without saving`
- `No state_unsafe_mutation thrown across every panel toggle sequence`
  — load-bearing cascade-prevent (P-5)
- `Chat-header continues to render after rapid channel switches
  (regression-prevent)`

Screenshot baselines (3):
- `chat-header-with-all-6-buttons.png`
- `chat-header-after-search-toggle.png`
- `chat-header-light-theme.png`

Source-level invariants (6 tests, P-1 + P-2):
- `ChatHeader pins all 6 button testids`
- `ChatHeader gates each button on its callback prop being a function`
- `ChatView forwards all 6 onToggle... props through to ChatHeader`
- `App.svelte supplies all 6 callbacks + themeMode to ChatView`
- `getChannelRole stays a pure read (cascade-fix regression-prevent)`
  — mirrors Agent 1's pattern
- `ChatHeader pins the mobile-menu media-query CSS rule`

Total: 21 tests.

## File / LOC delta

| File | LOC | Type |
|---|---|---|
| `web/e2e/scenarios/05-invite-participant.spec.ts` | ~520 | NEW |
| `web/e2e/scenarios/06-status-editor.spec.ts` | ~480 | NEW |
| `web/e2e/scenarios/07-chat-header-buttons.spec.ts` | ~440 | NEW |
| `web/e2e/__screenshots__/05-invite-participant.spec.ts-snapshots/` | 3 PNG | NEW |
| `web/e2e/__screenshots__/06-status-editor.spec.ts-snapshots/` | 3 PNG | NEW |
| `web/e2e/__screenshots__/07-chat-header-buttons.spec.ts-snapshots/` | 3 PNG | NEW |
| `.worklogs/v043-e2e-phase2b.md` | this | NEW |

Net code LOC added: **~1440**. Net screenshots added: **9 PNG baselines**.

## Test count summary

| Scenario | Functional | Screenshot | Source-level | Total |
|---|---|---|---|---|
| 05 | 13 | 3 | 6 | 22 |
| 06 | 11 | 3 | 6 | 20 |
| 07 | 12 | 3 | 6 | 21 |
| **Phase 2B total** | **36** | **9** | **18** | **63** |

Plus Phase 1's scenario 01 (14 tests) + Phase 2A's scenarios 02-04
(43 tests) → **120 total Playwright tests**.

Brief targets:
- Scenario 05: ≥10 (delivered 22) — exceeds by 2x.
- Scenario 06: ≥10 (delivered 20) — exceeds by 2x.
- Scenario 07: ≥10 (delivered 21) — exceeds by 2x.
- Total new: ≥30 (delivered 63) — exceeds by 2x.
- Screenshots: ~10 (delivered 9) — within target.

## Cold-start verification (P-6)

Pre-run state cleanup:
```
$ pgrep -af claude_comms
(no output)
$ rm -rf /tmp/cc-e2e-*
$ ls -d /tmp/cc-e2e-*
(no such file)
```

Cold run command:
```
$ cd web && pnpm exec playwright test --workers=1
```

Result: **120 / 120 passed in 1m30s** (full suite: scenarios 01-07).
- scenario 01: 14 tests pass (Phase 1)
- scenarios 02-04: 43 tests pass (Phase 2A)
- scenarios 05-07: 63 tests pass (Phase 2B, this agent's work)

Workers=1 is required because the web UI hardcodes ws://*:9001/mqtt
and the daemon fixture pins MQTT to 1883/9001 (see [VERIFY-PHASE2-5]
from Phase 1). The Playwright config sets `workers: undefined` so
`--workers=1` must be passed explicitly. CI mode sets workers=1 by
default.

Post-run state verification (P-6):
```
$ pgrep -af claude_comms
(0 daemons)
$ ls -d /tmp/cc-e2e-*
(0 dirs)
```

## Pattern adherence per scenario

### P-1 source-level regex pins (every constant the spec introduces)

- 05: `NOTE_MAX = 200` + 10 testids + 2 filter-shape regex pieces
  + `'invite'` action id pinned in the channel context menu.
- 06: `MAX_TEXT_LEN = 60` + 8-emoji literal-strip check (with length
  assertion) + 4 expiry ids (never/1h/4h/tomorrow) + 8 testids +
  `statusEditorOpen` state name in Sidebar + `comms_profile_status_set`
  + `_clear` MCP tool names + snake_case `expires_at:` pin.
- 07: 7 ChatHeader testids + 6 callback-prop type-checks +
  `getChannelRole` pure-read pin (mirrors Agent 1 + scenarios 03/04)
  + `display: none` + `@media (max-width: 768px)` CSS rule pin.

### P-2 cross-component invariant pins

- 05: bus boundary — ChannelContextMenu DISPATCHES
  `claude-comms:invite-participant` AND App.svelte LISTENS for it;
  both sides pinned. Store wire-shape pinned in mqtt-store.svelte.js.
- 06: editor-mount boundary — StatusEditor pins testids + Sidebar
  pins the mount gate (`{#if statusEditorOpen}` + the
  `data-testid="sidebar-profile-status"` trigger). MCP wire-shape
  pinned in mqtt-store.svelte.js (setProfileStatus + clearProfileStatus).
- 07: full prop-drill boundary — App.svelte supplies the 6 callbacks
  AND themeMode; ChatView forwards them all; ChatHeader renders each
  button gated on callback presence. All 3 sides of the boundary
  source-pinned in a single scenario.

### P-3 dual-coverage on tuned values

- 05: invite wire-shape tested functionally via page.route() intercept
  capturing the POST body + source-pinned via the store-shape test.
- 06: MCP wire-shape tested functionally via the mcpCall intercept
  (snake_case `expires_at` validated as ISO-8601 ~1h-from-now) +
  source-pinned via the store-shape test.
- 07: topic inline edit tested functionally via fill+Enter then
  fetch /api/conversations to confirm persistence; source-pinned via
  the 6-callback-typeof gating test.

### P-4 localStorage round-trip

- Not exercised in 05/06/07 (no localStorage-backed UI). Scenario 04
  (Agent A's member-context-menu) is the canonical exercise of P-4.

### P-5 console.error spy + no state_unsafe_mutation

Every test in 05/06/07 ends with `assertNoConsoleErrors(consoleErrors)`.
Scenario 07 includes a dedicated "No state_unsafe_mutation thrown
across every panel toggle sequence" test that explicitly enumerates
the cascades filter and asserts empty. The same scenario's "Chat-
header continues to render after rapid channel switches" test gives
a second cascade-prevent coverage.

### P-6 cold-start verification

Performed pre-report (see "Cold-start verification" section above).

### P-7 daemon dataDir filesystem fallback

Surfaced as available in scenario 06 for status persistence
verification IF the API surface doesn't expose participant status —
but scenario 06 currently verifies via the MCP route intercept +
optimistic UI assertion, which is sufficient. P-7 is held in
reserve; documented for Agent C.

### P-8 pre-click state assertions for focus-trapped UIs

- 05: `Right-click channel row...` asserts all 5 dialog surfaces
  (search input, picker, note, cancel, submit) are visible BEFORE
  any interactive control is exercised.
- 06: `Click inline status row...` asserts 11 editor surfaces are
  visible BEFORE any interactive control is exercised.
- 07: panel-toggle tests assert the panel is NOT visible pre-click
  before firing the toggle; emoji-pick test asserts the active class
  pre/post toggle.

### W-series avoided

- W-1: no `window.innerWidth` mutation without restore. Scenario 07's
  "Mobile-menu button becomes visible on narrow viewport" uses
  Playwright's `setViewportSize` which is page-scoped and cleans up
  on test teardown.
- W-2: every visibility check uses `expect(locator).toBeVisible()`,
  `toHaveCount(N)`, or `toBeEnabled()` / `toBeDisabled()`. No
  `querySelector !== null` patterns anywhere in the new specs.
- W-3: no tautological tests; every spec exercises the behavior it
  claims to test. Submit-fires test pins the actual POST body, not
  just "submit button exists." Theme toggle test reads the actual
  `data-theme` attribute, not just "button responds to click."
- W-4: explicit `git add <paths>` only; no `git add .`.
- W-5: cold-start re-run performed BEFORE this worklog was finalized.
- W-6: tests assert PROPER behavior. Scenario 05 opens the dialog
  via channel-row right-click → context menu → "Invite participant..."
  (the canonical user path, not a workaround). Scenario 07's Enter-
  saves-topic test relies on ChatHeader's `commitEditTopic` already
  having the snapshot-then-clear pattern + the blur-guard, so Enter
  is the canonical commit path (not a blur workaround). Scenario 07's
  Artifacts-toggle test closes the panel via its OWN close button
  (the canonical dismiss UX) instead of fighting the artifact-panel
  pointer-intercept on the chat-header button — that's the production
  way users dismiss the panel anyway.

## [VERIFY] items surfaced for Phase 2 Agent C

### [VERIFY-PHASE2B-1] Workers=1 is mandatory for the full e2e suite

The Phase 1 fixtures pin MQTT to 1883/9001 system-wide because the
web UI hardcodes `ws://${hostname}:9001/mqtt`. With Playwright's
default worker count (cores/2 = 4 on Phil's 8-core WSL2 box), the
e2e suite SHATTERS with port collisions — observed 41 of 120 tests
failing in the first full-suite run. Fix: pass `--workers=1`
explicitly (or rely on CI=true which the config already pins to 1).
**Action for Agent C / v0.4.4**: either (a) bake `workers: 1` into
playwright.config.js unconditionally, (b) document the requirement
in `web/e2e/README.md`, or (c) lift the hardcoded 9001 from
mqtt-store.svelte.js so each worker can use a slot-derived port.
Option (a) is the simplest immediate fix.

### [VERIFY-PHASE2B-2] apiPost error message shape impacts user-facing toast text

`api.js:apiPost` throws `Error('HTTP <status>')` on non-2xx. The
store's inviteParticipant passes that .message through verbatim.
App.svelte's 400 branch uses `msg = msg || 'Invalid invite request.'`
which keeps the truthy "HTTP 400" rather than swapping in the
friendlier generic. Net: users see "HTTP 400" toasts instead of
"Invalid invite request." Scenario 05's 400 test tolerates both
strings via a regex, but the UX is sub-optimal.
**Action for Agent C / v0.4.4**: either rewrite apiPost to throw a
friendlier `.message` AND keep .status, OR have App.svelte's branch
always swap in the friendly fallback (drop the `|| msg` keep-truthy).

### [VERIFY-PHASE2B-3] ArtifactPanel overlay intercepts chat-header pointer events

Clicking the chat-header-artifacts-btn opens ArtifactPanel as a
right-side overlay. On viewports ≥1024px the overlay sits beside
the chat-header, but on the 1280x900 viewport here the overlay's
header DIV overlaps the chat-header-artifacts-btn position, so a
second click on the trigger is intercepted by the overlay. Scenario
07 closes the panel via its own close button (canonical UX), which
side-steps the issue. A real user with a smaller viewport would
also hit this — the artifact panel's close-x is the only reliable
dismiss path.
**Action for Agent C / v0.4.4**: not a regression per se, but worth
documenting in the artifact-panel UX notes. The artifact button
SHOULD also be the toggle (click-again closes); reliability of
toggle-via-trigger across viewports is worth a UX audit.

### [VERIFY-PHASE2B-4] data-testid="artifact-panel-close" is ambiguous

Both `ArtifactDetailHeader.svelte:335` AND `ArtifactPanel.svelte:794`
emit `data-testid="artifact-panel-close"`. Tests must use `.first()`
to disambiguate or scope to the parent. Documented in scenario 07.
**Action for Agent C / v0.4.4**: rename one of them (e.g. the
detail-header close becomes `artifact-detail-close`) so the testid
is unambiguous.

## Iteration log entries to merge into v043-iteration-log.md

> **Agent (Phase 2B): scenarios 05 + 06 + 07 — RETURNED 2026-05-20**
>
> ### Pattern wins
>
> 1. **`page.route()` intercept + capture-then-fulfill is a clean
>    pattern for wire-shape tests.** Scenario 05's "Submit fires
>    POST /api/invite..." test captures the request body, validates
>    every field of the brief's pinned wire shape, AND fulfills with
>    a synthetic 200 so the UI's success-path renders correctly.
>    Same pattern used in scenario 06 for the MCP boundary. Net:
>    the test exercises the FULL user-visible flow (dialog → submit
>    → toast / dialog-close) without depending on the daemon's actual
>    server-side validation surfacing — the route handler IS the
>    server for the duration of the test. Recommend documenting as
>    a new pattern (call it "P-3a: route-intercept dual-coverage").
>
> 2. **3-side prop-drill source-pinning is potent for cascade-style
>    bugs.** Scenario 07's source-level block pins the 6 onToggle
>    callbacks at App.svelte (supply side), ChatView.svelte
>    (forwarder), AND ChatHeader.svelte (render side). A future
>    refactor that drops any side silently breaks the buttons
>    end-to-end — but at least one of the 6 invariant tests trips
>    at edit-time. Belt-and-braces with the runtime visibility
>    assertions. Recommend documenting as a new pattern (call it
>    "P-2a: triple-side prop-drill source pin").
>
> 3. **`expect.poll()` is the right tool for "wait for a side-effect
>    to land in a captured variable".** Scenario 05's submit-fires
>    test was initially flaky because `capturedBody` was checked
>    immediately after the dialog closed but before the route
>    handler had run. `expect.poll(() => capturedBody).not.toBeNull()`
>    waits without an explicit timeout dance. Document as a Phase 2
>    convention.
>
> ### Weaknesses / surfaced gaps
>
> 1. **Default Playwright workers=cores/2 fights the pinned MQTT
>    port.** Documented as [VERIFY-PHASE2B-1]. Full-suite run with
>    default workers shatters with port collisions; --workers=1 is
>    the safe default. Bake into config.
>
> 2. **apiPost error messages bleed through to toast UX.**
>    Documented as [VERIFY-PHASE2B-2]. The 400 path surfaces "HTTP
>    400" not "Invalid invite request." — both unfriendly.
>
> 3. **ArtifactPanel overlay reliability on smaller viewports.**
>    Documented as [VERIFY-PHASE2B-3]. The chat-header-artifacts-btn
>    click-again-to-toggle pattern is fragile when the panel overlay
>    intercepts pointer events. Worth a UX audit.
>
> 4. **Ambiguous testid `artifact-panel-close` shared across 2
>    components.** Documented as [VERIFY-PHASE2B-4]. Tests work
>    around with `.first()`; rename one.
>
> ### Refinements for Phase 2 Agent C brief
>
> 1. **Bake --workers=1 into the brief.** Phase 1's [VERIFY-PHASE2-5]
>    was about parallel safety. Phase 2B confirmed the symptom and
>    the fix. Agent C MUST run with `--workers=1` (or `CI=true`).
>
> 2. **page.route() pattern documented as a default.** Agent C's
>    scenarios 08 (notification-policy), 09 (unread-divider), and
>    10 (thread-panel) will likely intercept MCP calls. The pattern
>    from scenario 06 (interceptMcp helper) can be lifted into a
>    fixture if Agent C wants to reuse.
>
> 3. **`expect.poll()` is preferred over `waitForTimeout` for any
>    "wait for side-effect" pattern.** Document as Phase 2
>    convention.
>
> 4. **Close panels via their own close-x buttons (not the trigger
>    button) when the panel overlays the chat-header.** Lifted from
>    scenario 07.
>
> ### Test-writing patterns to enforce (cumulative)
>
> Adding to the existing P-1..P-8 list:
> - **P-3a (new)**: route-intercept dual-coverage. Use
>   `page.route('**/api/...')` or `**/mcp` to BOTH capture the
>   request body AND fulfill with a synthetic response so the UI
>   exercises its success/error branch without depending on real
>   daemon behavior. Cleaner than relying on the daemon to surface
>   every error code at the right time.
> - **P-2a (new)**: triple-side prop-drill source pin. For any
>   prop-drill chain (App → ChatView → ChatHeader, or similar), pin
>   the supply-side, the forwarder, AND the render-side in 3
>   separate source-level invariant tests. Bites at edit-time even
>   when the runtime chain is silent.

## Verification gates (this Phase 2B agent — final)

- [x] All 120 Playwright tests pass cold-start with `--workers=1`
      (3 new scenarios + Phase 1's scenario 01 + Phase 2A's 02/03/04)
- [x] vitest 1087 unchanged (no vitest touched)
- [x] pytest 1347 unchanged (no Python touched)
- [x] ruff clean
- [x] `pnpm build` green (no .svelte / .js touched)
- [x] 9 screenshot baselines generated + reviewed visually
- [x] `pgrep -af claude_comms` shows 0 after teardown
- [x] `ls -d /tmp/cc-e2e-*` shows 0 after teardown

## Commit message (per brief — exact)

```
feat(test): v0.4.3 Phase 2 Agent B - scenarios 05/06/07 (invite, status-editor, chat-header-buttons) with screenshot baselines
```

## Files MUST commit (explicit paths, W-4 mitigation)

- `web/e2e/scenarios/05-invite-participant.spec.ts`
- `web/e2e/scenarios/06-status-editor.spec.ts`
- `web/e2e/scenarios/07-chat-header-buttons.spec.ts`
- `web/e2e/__screenshots__/05-invite-participant.spec.ts-snapshots/*.png`
- `web/e2e/__screenshots__/06-status-editor.spec.ts-snapshots/*.png`
- `web/e2e/__screenshots__/07-chat-header-buttons.spec.ts-snapshots/*.png`
- `.worklogs/v043-e2e-phase2b.md` (this file)

Explicit `git add <paths>` only; no `git add .`.
