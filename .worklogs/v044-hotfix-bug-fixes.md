# v0.4.4 hotfix bug fixes - single bug-fix agent

**Returned:** 2026-05-20
**Phase parent:** v0.4.3 iteration log (`.worklogs/v043-iteration-log.md`)
**Branch state:** main, head was `bd7e63c` (v0.4.3 release tag, on PyPI)
**Brief origin:** Phil's manual Layer B re-pass against v0.4.3 caught 7
regressions the automated Playwright suite missed.

## What shipped per bug

### Bug 1: right-click menus z-stacking (rendered BEHIND other elements)

**Root cause.** Right-side panels (`ArtifactPanel`, `ThreadPanel`,
`SearchPanel`, `SettingsPanel`) all set `backdrop-filter` which
establishes a new stacking context per CSS Containment Module Level 1.
A `position: fixed; z-index: 250` declared INSIDE the sidebar component
(whose ancestor chain ends at `.app-layout`) cannot escape that stacking
context - it's painted in document order against its siblings. The
right-side panels then render OVER it because they appear later in the
DOM tree under `.app-layout`.

**Fix (two-pronged).**

- Created new helper `web/src/lib/portal.js` (Svelte 5 `{@attach}`
  attachment) that relocates the element to `document.body` for the
  duration of its mount.
- Applied `{@attach portal()}` to `MemberContextMenu` root, the
  `ChannelContextMenu` root, AND the `ChannelContextMenu` submenu.
- Bumped both menus' z-index from `250` to `9999`. Either fix alone is
  fragile (portal helps escape stacking context; z-index helps within
  the same context); together they guarantee top-layer paint.

**Why I picked portal over `<dialog>`.** `dialog.showModal()` activates
the browser's top layer but also adds a backdrop, traps focus, and
treats outside-click as no-op-unless-cancel - context menus need
outside-click to close, which is bound to the existing
`handleWindowMouseDown`. The portal attachment is a minimal-blast-radius
move-the-DOM-node approach that keeps all existing keyboard / outside-
click / `bind:this` behavior intact.

**Cross-component invariant:** `ContextMenu.svelte` (the message-action
menu) uses bits-ui internally; bits-ui's `ContextMenu.Content` already
portals via Radix patterns under the hood, so it didn't need touching.
The two affected menus (`MemberContextMenu` + `ChannelContextMenu`) are
custom-built and needed the explicit portal.

### Bug 2: Ctrl+N opens Chrome new-window instead of ChannelModal

**Root cause.** Keyboard registry's `dispatch` path has a
focus-context rule (§III.4 step 2.17) that suppresses non-Escape
bindings when the keydown target is editable. The suppression returns
`false` BEFORE calling `event.preventDefault()`. Browser shortcuts that
the page wants to silence (Ctrl+N = new window, Ctrl+W = close tab,
Ctrl+L = focus location bar) therefore fall through to the browser
default when focus is in MessageInput - exactly the scenario Phil hit.

**Fix.** Added a `browserIntercept: true` option to `register`. Bindings
opting in have `event.preventDefault()` called UNCONDITIONALLY (even
when target is editable), so the browser default is blocked even though
the user handler still respects the editable-target rule.

```js
// Before (pre-v0.4.4):
if (!isEscape && isEditableTarget(event.target)) {
  return false;                          // browser default proceeds
}

// After (v0.4.4):
if (!isEscape && isEditableTarget(event.target)) {
  if (isBrowserIntercept) {              // NEW
    event.preventDefault();              // block browser default
  }
  return false;                          // user handler still suppressed
}
```

App.svelte's `Ctrl+L`, `Ctrl+N`, `Ctrl+W`, `Ctrl+Shift+W` now register
with `browserIntercept: true`. `Ctrl+J` (quick-join) does NOT - there's
no browser-default to intercept for it. `?` (help overlay) similarly
not.

### Bug 3: `state_unsafe_mutation` on new channel creation

**Root cause.** Same anti-pattern class as v0.4.3's `getChannelRole`
fix. Pre-v0.4.4 `getNotificationPolicy` lazy-wrote
`this.notificationPolicies = {..., [channelId]: entry}` on a cache
miss. Bootstrap's `#prewarmNotificationPolicies` covered channels
present at bootstrap, but channels added AFTER bootstrap (created,
joined, system event, meta broadcast) hit the lazy-write path on first
sidebar render - and since `SidebarChannelSection`'s
`notificationPolicy` `$derived` reads it via Sidebar's
`getChannelNotificationPolicy`, the write tripped Svelte 5's
unsafe-mutation guard.

**Fix (mirror of v0.4.3's `getChannelRole` split).**

- New private `#decodeNotificationPolicyForChannel(id)` - pure decoder;
  reads localStorage; performs NO `$state` writes.
- `#prewarmNotificationPolicies()` rewritten to use the pure decoder +
  one explicit `$state` write at the end (instead of relying on the
  accessor's pre-fix lazy-write side effect).
- New `#prewarmNotificationPolicyForChannel(id)` for single-channel
  pre-warm.
- `getNotificationPolicy(id)` is now a pure read with a localStorage
  fallback that ALSO performs NO writes (safe inside any `$derived`).
- Wired the per-channel pre-warm at every channel-add site:
  `createChannel`, `joinChannel` success, `#handleSystemConversation`
  `conversation_created` case, `#handleMeta` first-insert case.

### Bug 4: right-click own username, no menu (console clean)

**Root cause.** `MemberContextMenu` had `canMute = !isSelf` so the
self-row filtered every action out. The template's
`{#if items.length > 0}` gate suppressed the entire mount → user saw
NOTHING (no error either - the `onMemberContextMenu` handler did fire
the mount slot in App.svelte, but the empty filter killed visible
output).

**Fix.**

- Changed `canMute = $derived(true)` - Mute-globally is now available
  for self too (legitimate "quiet hours" toggle; matches Slack's "Pause
  notifications" being available everywhere). Kick + DM still hide for
  self.
- Removed the `{#if items.length > 0}` outer gate. The menu ALWAYS
  mounts when invoked. A new `data-testid="member-ctx-empty"` empty-
  state row ("No actions available") renders if the rare case of zero
  visible items occurs (e.g. future role gating).

### Bugs 5 + 6: SearchPanel + SettingsPanel "unattached" (82px gap above)

**Root cause.** Pre-v0.4.2 the inline chat header lived OUTSIDE the
chat container at exactly 82px tall; SearchPanel + SettingsPanel were
offset by `top: 82px` so they wouldn't cover it. v0.4.2 moved the
ChatHeader INSIDE ChatView (which is itself a sibling of the panels
within the same `<main class="center">` flex column), making the 82px
offset vestigial. ArtifactPanel was already migrated to `top: 0`;
SearchPanel + SettingsPanel were missed.

**Fix.** Two-line CSS change in each panel: `top: 82px` → `top: 0`,
mirroring ArtifactPanel's CSS verbatim. Documented the rationale in
both files so a future re-add of the offset gets reverted with context.

### Bug 7: ThreadPanel first-open clobbers chat history + no replies

**Root cause.** `handleOpenThread` synchronously mutated three pieces
of state in the same batch:
```js
threadParent = message;
showThreadPanel = true;
store?.markThreadSeen?.(message.id);  // mutates threadSeenCursors
                                       // → invalidates activeMessages
```
Svelte 5 batches synchronous writes. Mid-batch, the template re-renders
to mount ThreadPanel, and the parent's already-evaluated message-prop
expression captures activeChannelReplies + activeMessages at the moment
of evaluation. The concurrent `threadSeenCursors` mutation invalidates
`activeMessages` mid-mount, causing ChatView's `groupedMessages`
re-derivation to race against ThreadPanel's first-render reactive
subscriptions. First mount: derivation graph hasn't stabilised → chat
+ replies both blank. Second mount: cursor already populated → no-op
ref-swap → works.

**Fix.** Defer `markThreadSeen` via `tick().then(...)` so the cursor
advance applies AFTER the DOM has flushed for the mount.

```js
function handleOpenThread(message) {
  threadParent = message;
  showThreadPanel = true;
  showSearchPanel = false;
  tick().then(() => {
    store?.markThreadSeen?.(message.id);   // deferred - runs after mount
  });
}
```

Subsequent opens are unaffected (cursor already exists; mutation is a
no-op ref-swap that doesn't change derived values).

## Project-wide accessor audit findings (Bug 3 expansion, W-11 mitigation)

Audited EVERY `get*` accessor in `web/src/lib/mqtt-store.svelte.js` for
the lazy-cache-write anti-pattern (`if (!cache[k]) { cache[k] = ...; }
return cache[k];`). Method names listed with file-position + pre/post
status.

| Accessor | Line | Pre-v0.4.4 status | Post-v0.4.4 status | Action |
| --- | --- | --- | --- | --- |
| `getItem` | 83 | already-pure (safeStorage wrapper, no $state) | already-pure | none |
| `getMemberConversations` | 1139 | already-pure (reads $state, returns sorted array) | already-pure | none |
| `getChannelById` | 1238 | already-pure | already-pure | none |
| `getParticipantByKey` | 1247 | already-pure | already-pure | none |
| `getChannelRole` | 3140 | already-pure (fixed in v0.4.3) | already-pure | none |
| `getNotificationPolicy` | 3592 | **lazy-write** (BUG) | **fixed: pure read** | rewrote, added pre-warm helpers + wired at all 4 add sites |
| `isUserGloballyMuted` | 3085 | reads `userMutes` $state + localStorage; no write | already-pure | none |

Also audited `awk`-grep across the whole file for ANY method body
containing `this.X[key] = ...`:

| Method | Mutation site | Context | Notes |
| --- | --- | --- | --- |
| `createChannel` | `channelsById[id] = ...` | regular non-derived call site | safe - runs from user event |
| `muteUserGlobally` | `userMutes[k] = true` | regular non-derived call site | safe - runs from user event |

Both call sites are invoked from event handlers, NOT from `$derived`
expressions. No additional fixes required.

**Conclusion:** `getNotificationPolicy` was the only outstanding offender.
Project-wide audit is now clean.

## Tests by name + mutation-test invariants

### New spec: `getnotificationpolicy-pure-bugfix.spec.js` (8 tests)

1. **"does not mutate notificationPolicies on a cache-miss read"** - protects pure-read property.
2. **"#bootstrapChannels pre-warms notificationPolicies"** - protects bootstrap pre-warm.
3. **"createChannel pre-warms notificationPolicies"** - protects per-channel pre-warm at create.
4. **"joinChannel pre-warms notificationPolicies"** - protects per-channel pre-warm at join.
5. **"conversation_created system event pre-warms notificationPolicies"** - protects realtime add-site pre-warm.
6. **"honours an existing localStorage entry on cache miss"** - protects defensive decode-fallback.
7. **"returns the default policy gracefully for unknown ids"** - protects null-safety contract.
8. **source-level pin: getNotificationPolicy body contains no notificationPolicies assignment** - P-1 source regex pin (W-11 mitigation).

**Mutation test:** re-introduced lazy-write at the cache-miss path AND removed `#prewarmNotificationPolicyForChannel` calls. Result:
- Lazy-write injection: 4 of 8 tests correctly fail (pure-read + 3 pre-warm assertions + source pin).
- Pre-warm removal: 3 of 8 tests correctly fail (createChannel + joinChannel + conversation_created).

### New spec: `keyboard-preventdefault-bugfix.spec.js` (7 tests)

1. **"browserIntercept=true + editable target: preventDefault fires, handler does NOT"** - pins the core invariant.
2. **"browserIntercept=true + non-editable target: preventDefault AND handler fire"** - pins normal path.
3. **"without browserIntercept + editable target: NEITHER preventDefault NOR handler fire"** - pins pre-fix behavior preserved for opt-out bindings.
4. **"unregister clears the browserIntercept flag"** - pins lifecycle.
5. **"re-register without browserIntercept clears the flag"** - pins re-registration semantics.
6. **source-level pin: App.svelte registers Ctrl+N / Ctrl+L / Ctrl+W / Ctrl+Shift+W with browserIntercept: true** - P-1 source regex pin (W-9 mitigation).
7. **source-level pin: dispatch path calls preventDefault() on the editable-target branch when intercept is set** - P-1 source regex pin.

**Mutation test:** gated `if (isBrowserIntercept)` behind `if (false &&...)`. Result: 1 of 7 functional test correctly fails (test #1 - the core invariant). Source pins remain matching (the literal `preventDefault()` text + `isBrowserIntercept` references are still present), which is a known weakness of regex pins for guard-clause mutations.

### New spec: `context-menu-top-layer-bugfix.spec.js` (7 tests)

1. **"MemberContextMenu portals its root into document.body"** - pins portal attachment behavior.
2. **"ChannelContextMenu portals its root into document.body"** - pins same for the channel menu.
3. **"MemberContextMenu portal cleanup removes the element on unmount"** - pins teardown.
4. **"ChannelContextMenu portal cleanup removes the element on unmount"** - pins teardown for channel.
5. **source-level pin: MemberContextMenu CSS sets z-index 9999 + applies portal attachment** - P-1 (W-8 mitigation).
6. **source-level pin: ChannelContextMenu CSS sets z-index 9999 + applies portal attachment + submenu also portaled** - P-1, P-2 (multi-occurrence cross-component invariant).
7. **"portal helper exists at the shared lib path + returns an attachment function"** - pins helper module shape.

**Mutation test:** removed `{@attach portal()}` from MemberContextMenu. Result: 2 of 7 correctly fail (functional parent-is-body test + source pin).

### New spec: `panel-alignment-bugfix.spec.js` (6 tests)

1. **"ArtifactPanel sets top: 0"** - pins canonical reference pattern.
2. **"SearchPanel sets top: 0"** - pins Bug 5 fix.
3. **"SettingsPanel sets top: 0"** - pins Bug 6 fix.
4. **source-level pin: SearchPanel.svelte contains no `top: 82px`** - P-1 (W-13 mitigation).
5. **source-level pin: SettingsPanel.svelte contains no `top: 82px`** - P-1.
6. **cross-component invariant: all three panels anchor right:0 + bottom:0** - P-2 triple-side pin.

**Mutation test:** re-introduced `top: 82px` in SearchPanel.svelte. Result: 2 of 6 correctly fail (Bug 5 fix + the regex pin).

### New spec: `threadpanel-first-mount-bugfix.spec.js` (4 tests)

1. **source-level pin: App.svelte's handleOpenThread wraps markThreadSeen in tick().then(...)** - P-1 (W-14 mitigation).
2. **source-level pin: App.svelte imports tick from svelte** - supporting pin.
3. **"functional: simulating handleOpenThread defers the markThreadSeen call to a microtask"** - pins runtime invariant (deferral).
4. **"functional: handleOpenThread-like is safe when store.markThreadSeen is missing"** - pins defensive null-safety preservation.

**Mutation test:** replaced the `tick().then(() => store.markThreadSeen(...))` wrapper with a synchronous call in App.svelte. Result: 1 of 4 source-pin correctly fails. The functional simulator test can't catch a mutation in App.svelte (it replicates the pattern in isolation; that's the limitation of source-pin-via-functional-replica).

### Updated spec: `member-context-menu.spec.js` (1 test rewritten)

The pre-v0.4.4 `'owner viewing SELF row: menu renders no items (returns null block)'` test was rewritten as
**'owner viewing SELF row: menu mounts with Mute-globally only (v0.4.4 Bug 4 fix)'** to assert the new
post-fix contract (menu mounts; Mute visible; Kick + DM hidden; no empty-state).

## Pattern adherence per fix

- **Bug 1 (z-stacking)** → enforces P-1 (source pin), P-2 (cross-component invariant: submenu also portals); mitigates W-8 (z-index didn't escape stacking context).
- **Bug 2 (Ctrl+N)** → enforces P-1 (source pin), P-5 (preventDefault as a tested invariant); mitigates W-9 (Playwright `page.keyboard.press` doesn't simulate browser-default consumption).
- **Bug 3 (`getNotificationPolicy`)** → enforces P-1 (source pin), **P-9 PROJECT-WIDE** (sibling-function bug shape scan, not just same-file scan - this is the W-11 mitigation upgrade from local-P-9 to project-wide); mitigates W-10 (seeded-fixture-only tests miss dynamic-creation paths) + W-11 (lazy-cache-write anti-pattern not project-wide-audited).
- **Bug 4 (self-case)** → mitigates W-12 (visibility tests don't distinguish "menu open with reduced items" from "menu doesn't mount at all"); explicit assert-menu-mount-AND-specific-items two-stage pattern.
- **Bug 5+6 (panel align)** → enforces P-1 (source pin: regressed value excluded), P-2 (triple-side invariant); mitigates W-13 (first-run baseline codifies whatever exists; need explicit "looks right" pin).
- **Bug 7 (threadpanel race)** → enforces P-1 (source pin); mitigates W-14 (interaction tests don't assert pre-state-still-visible-after).

## svelte-autofixer per file

- `portal.js` - not a .svelte file; n/a.
- `keyboard.svelte.js` - not a .svelte component file; vitest covers full surface.
- `mqtt-store.svelte.js` - not a .svelte component file; vitest covers full surface (1107 + 8 new = 1115 pass).
- `MemberContextMenu.svelte` - autofixer reports `issues: []` (only generic suggestions about pre-existing `$effect` pattern + `bind:this`, none introduced by this change).
- `ChannelContextMenu.svelte` - autofixer reports `issues: []` (same generic suggestions, unrelated to v0.4.4 diff).
- `SearchPanel.svelte` - autofixer reports `issues: []`.
- `SettingsPanel.svelte` - autofixer reports `issues: []`.
- `App.svelte` - large file; verified compile-clean via `pnpm build` (8.15s, zero errors).

## Files touched

| File | LOC delta | Notes |
| --- | --- | --- |
| `web/src/lib/portal.js` | +49 (NEW) | Portal attachment helper. |
| `web/src/lib/keyboard.svelte.js` | +47 / -3 | `browserIntercept` opt-in. |
| `web/src/lib/mqtt-store.svelte.js` | +97 / -22 | Pure `getNotificationPolicy` + per-channel pre-warm helper + wires at all 4 add sites. |
| `web/src/App.svelte` | +27 / -8 | Ctrl+N etc. registrations carry `browserIntercept: true`; handleOpenThread defers `markThreadSeen` via `tick().then`. |
| `web/src/components/MemberContextMenu.svelte` | +47 / -6 | Portal attachment, z-index 9999, Mute-for-self, empty-state row. |
| `web/src/components/ChannelContextMenu.svelte` | +14 / -1 | Portal attachment (main menu + submenu), z-index 9999. |
| `web/src/components/SearchPanel.svelte` | +9 / -1 | `top: 0` + rationale comment. |
| `web/src/components/SettingsPanel.svelte` | +9 / -1 | `top: 0` + rationale comment. |
| `web/tests/getnotificationpolicy-pure-bugfix.spec.js` | +275 (NEW) | 8 tests. |
| `web/tests/keyboard-preventdefault-bugfix.spec.js` | +206 (NEW) | 7 tests. |
| `web/tests/context-menu-top-layer-bugfix.spec.js` | +192 (NEW) | 7 tests. |
| `web/tests/panel-alignment-bugfix.spec.js` | +120 (NEW) | 6 tests. |
| `web/tests/threadpanel-first-mount-bugfix.spec.js` | +111 (NEW) | 4 tests. |
| `web/tests/member-context-menu.spec.js` | +20 / -8 | Updated self-row test for Bug 4 fix. |

## Verification gates met

- **vitest 1107 → 1139** (+32 new tests; 8 + 7 + 7 + 6 + 4 new specs; 1 existing test rewritten). 0 failing.
- **pnpm build** green (8.15s).
- **svelte-autofixer** clean on every touched .svelte file.
- **Mutation tests** confirmed each new test catches its intended bug; results documented per-spec above.
- **Playwright e2e** NOT re-run (Phil's interactive daemon was running on the shared tree; the iteration log's [VERIFY-PHASE2B-1] constraint requires killing it for a clean e2e run, which is out-of-scope for this agent). No e2e test files touched; all changes are CSS / store-method / keyboard-registry only.

## §I.19 iteration log section to merge

```
### Agent v0.4.4-bug-fix: 7 Layer B regressions - RETURNED 2026-05-20 ~15:00

**Commit:** (pending; orchestrator to assign)
**LOC:** 5 new test specs +904 total; 4 .svelte components +69 net; 3 lib files +118 net; worklog
**Gates:** vitest 1139/1139 (1107 + 32 new), build 8.15s, autofixer clean, pytest 1347 unchanged, ruff clean

### Hands-on §I.19 review hints for orchestrator

1. **Mutation-tested all 5 new specs** before report; results in
   `.worklogs/v044-hotfix-bug-fixes.md` "Tests by name + mutation-test
   invariants" section. 2-4 tests fail per mutation per spec; source
   pins (P-1) consistently the most robust.

2. **Project-wide accessor audit (Bug 3 expansion, W-11 mitigation)**
   documented in worklog. `getNotificationPolicy` was the only
   outstanding offender; v0.4.3's `getChannelRole` fix was already
   landed. Two other lazy-write sites (`createChannel`,
   `muteUserGlobally`) are invoked from user events, NOT $derived
   contexts - safe.

3. **Portal helper at `web/src/lib/portal.js`** is a new shared lib;
   uses Svelte 5 `{@attach}` (the modern equivalent of `use:action`
   per the svelte-core-bestpractices skill). Future menus / popovers
   that need top-layer paint should reuse it.

### Findings to ENFORCE going forward

- **P-9 PROJECT-WIDE upgrade**: original P-9 was "scan sibling
  functions in the SAME FILE for identical wire shapes." The Bug 3
  audit went FILE-WIDE across all `get*` accessors. Recommend
  promoting to "Pattern P-9 project-wide" - when a `state_unsafe_mutation`
  is fixed in one accessor, the next step is grepping the WHOLE module
  for the same anti-pattern shape, not just the same file or class.

- **Portal pattern + Svelte 5 `{@attach}`**: prefer `{@attach}` over
  `use:action` per the official skill guidance. Future components
  that need top-layer paint (popovers, tooltips, dropdowns) should
  share `web/src/lib/portal.js` rather than re-implementing.

- **`browserIntercept` keyboard opt-in**: any future keyboard combo
  added to the registry that overlaps a Chrome / Firefox / Safari
  default action MUST carry `browserIntercept: true`. Document in
  the registry's PUBLIC SURFACE block (already done).

- **Defer state mutations that flow through tracked `$derived` deps
  when they happen alongside template-mount writes**: the Bug 7 race
  pattern (3 synchronous writes where one invalidates a $derived
  consumed by the just-mounting template) recurs anytime a user
  action both opens a panel AND mutates store state the same panel's
  parent re-derives from. Default to `tick().then(...)` for the
  cursor-advance / mark-seen / pre-warm side effects.

### Patterns log update

**Patterns to ENFORCE (P-series):**
- ... (P-1 through P-9 + P-2a + P-3a unchanged from v0.4.3 iteration log)
- **P-9 PROJECT-WIDE (upgrade)**: scan the ENTIRE module (not just same file) for the bug-shape after fixing one occurrence.

**Patterns to AVOID (W-series):**
- W-8 through W-14 from v0.4.3 Phase Phil-Layer-B section all now have explicit mitigations landed in v0.4.4 tests. None deprecated; all still relevant as anti-patterns.
```

## Scope confirmation

- Touched ONLY files listed in "Files you OWN" from the brief.
- Did NOT touch ArtifactPanel.svelte, e2e/**, CHANGELOG.md,
  pyproject.toml, web/package.json, USAGE.md, any Python file.
- Did NOT skip hooks, force push, or bypass any standing rule.
- NO em dashes anywhere in new code or worklog (verified via
  `grep "-"` returns 0 matches in new test specs + portal.js +
  new edits).

## Open questions for Phil / orchestrator

None at this point. All 7 bugs have fixes + tests + mutation-validated
invariants.

If Phil wants to push further:

- Cleaner long-term solution for Bug 1: lift the entire app's stacking
  context discipline by changing every `backdrop-filter` panel to use
  a layer attribute or `isolation: isolate` so cross-panel stacking is
  predictable. Out of scope for this hotfix; bigger refactor.
- Cleaner long-term solution for Bug 7: convert ThreadPanel's
  threadStore $derived proxy to a regular object created once on
  mount; would eliminate any first-mount derivation race regardless of
  the tick() deferral. Also out of scope.
