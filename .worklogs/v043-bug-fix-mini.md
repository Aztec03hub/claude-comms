# v0.4.3 bug-fix-mini worklog

**Phase:** v0.4.3 hotfix - bug-fix-mini (parallel to Phase 2 Agent B)
**Wave:** N=2 parallel; files DISJOINT (I own components + 2 new vitest
specs; Agent B owns `web/e2e/scenarios/05-07.spec.ts`)
**HEAD before:** `18f9a4f`
**Brief input:** Phase 2 Agent A's two production-bug surfaces:
- `[VERIFY-PHASE2A-3]` ChannelModal Create button swallowed
- `[VERIFY-PHASE2A-EDIT-TOPIC-DOUBLE-FIRE]` topic Enter double-fire

## 1. WHAT shipped (before / after snippets)

### BUG-PHASE2A-1: ChannelModal Create button intermittently swallowed

**File:** `web/src/components/ChannelModal.svelte`
**Net LOC:** +21 (handler + state + comment)

**Before** (handler):
```js
function handleCreate() {
  if (!nameIsValid) return;
  onCreate(sanitizedName, description);
}
```

**Before** (button markup):
```html
<button class="modal-btn primary" onclick={handleCreate}
  disabled={!nameIsValid} data-testid="channel-modal-create">
  Create Channel
</button>
```

**After** (handler + new pointerdown bypass + submitting latch):
```js
let submitting = $state(false);

function handleCreate() {
  if (!nameIsValid || submitting) return;
  submitting = true;
  onCreate(sanitizedName, description);
}

function handlePrimaryPointerDown(e) {
  if (e.button !== 0) return;
  if (!nameIsValid || submitting) return;
  handleCreate();
}
```

**After** (button markup):
```html
<button class="modal-btn primary"
  onpointerdown={handlePrimaryPointerDown}
  onclick={handleCreate}
  disabled={!nameIsValid}
  data-testid="channel-modal-create">
  Create Channel
</button>
```

### BUG-PHASE2A-2: ChannelAdminPanel topic Enter double-fire

**File:** `web/src/components/ChannelAdminPanel.svelte`
**Net LOC:** +9 (1 guard line in `commitEditTopic`, 1 guard line in
`commitRename`, plus comments)

**Before** (`commitEditTopic`):
```js
async function commitEditTopic() {
  const next = topicDraft;
  editingTopic = false;
  topicDraft = '';
  if (next === (channel?.topic ?? '')) return;
  if (typeof store?.setTopic === 'function') {
    await store.setTopic(channel.id, next);
  }
}
```

**After** (`commitEditTopic`):
```js
async function commitEditTopic() {
  if (!editingTopic) return;   // ← guard, BUG-PHASE2A-2 fix
  const next = topicDraft;
  editingTopic = false;
  topicDraft = '';
  if (next === (channel?.topic ?? '')) return;
  if (typeof store?.setTopic === 'function') {
    await store.setTopic(channel.id, next);
  }
}
```

Same guard pattern was preventatively applied to `commitRename`, which
has the IDENTICAL Enter+blur double-fire wiring shape and would have
been the next bug to surface.

## 2. Root cause per bug

### BUG-PHASE2A-1 root cause

bits-ui Dialog's focus-trap intercepts and re-focuses on synthetic
`click` events when the trap detects a focusable interactive whose
`disabled` flips inside the same microtask as the click resolves.
Agent A observed the swallow across `.click()`, `.click({force:true})`,
`.dispatchEvent('click')`, and `inputEl.press('Enter')` - i.e. EVERY
synthetic click path Playwright exposes. Real users in real Chromium
may also be hitting this intermittently (Phil's Layer B item #4
predates the cascade fix).

**Why pointerdown fixes it:** `pointerdown` fires in the SAME tick the
user presses the mouse button, BEFORE the focus-trap's synthetic-event
machinery runs (the trap operates on `focus` / `click` events). By
acting on the pointer event, we sidestep the entire focus-trap
swallow path. We keep `onclick` for keyboard activation (Enter / Space
on a focused button only ever dispatches a click - no pointerdown).
The `submitting` latch guarantees that even if BOTH paths reach
`handleCreate` in a single gesture, the wire fires exactly once.

### BUG-PHASE2A-2 root cause

The topic input wires BOTH `onkeydown=Enter -> commitEditTopic` AND
`onblur -> commitEditTopic`. Pressing Enter calls `commitEditTopic`,
which sets `editingTopic = false` BEFORE awaiting `store.setTopic`.
The `{#if editingTopic}` block then unmounts the input element in the
same microtask. The unmounting input fires `blur` on its way out,
which re-enters `commitEditTopic` with `topicDraft` already reset to
`''`. The second call computes `next = '' !== channel.topic` (true)
and calls `store.setTopic(channelId, '')`, wiping the topic.

**Why the guard fixes it:** the first call flips `editingTopic` to
`false` before the blur fires; the second call sees `editingTopic ===
false` at its very first line and short-circuits. The blur-commit UX
path (user blurs WITHOUT pressing Enter, e.g. Tab-away or
click-outside) still works because in that path `editingTopic === true`
when blur fires.

## 3. Tests by name + mutation-test invariants each protects

### `web/tests/channel-modal-bugfix.spec.js` (8 tests)

1. **`P-8 pre-click state: Create button is mounted, visible, has the canonical testid, and is enabled after typing a valid name`** - fails if the create-button testid is renamed; load-bearing P-8 assertion that the bug WAS pre-state-reachable.
2. **`pointerdown (primary button) fires onCreate exactly once with sanitized name + description`** - fails if `onpointerdown` is removed from the Create button.
3. **`click (keyboard activation path) fires onCreate exactly once when pointerdown did not fire`** - fails if `onclick` is removed from the Create button (would break keyboard Enter/Space activation).
4. **`pointerdown + click in the same gesture fires onCreate EXACTLY ONCE (submitting latch dedupes)`** - fails if the `submitting` latch is removed; without it the same gesture would create two channels.
5. **`pointerdown with a non-primary button (right-click) does NOT fire onCreate`** - fails if the `e.button !== 0` guard is removed; right-click would create channels.
6. **`pointerdown is ignored when name is invalid (button disabled gate must hold)`** - fails if `!nameIsValid` guard is removed from `handlePrimaryPointerDown`; empty-name submits would slip through.
7. **`P-1 source pin: Create button wires BOTH onpointerdown AND onclick (and the submitting latch is declared)`** - fails at edit-time if any of: `onpointerdown=`, `onclick=`, the `submitting` declaration, the `if (!nameIsValid || submitting) return;` line, or the `e.button !== 0` guard is removed. Quadruple-coverage.
8. **`P-1 source pin: handlePrimaryPointerDown stays a pure activation handler (no state writes other than via handleCreate)`** - fails at edit-time if a future refactor inlines the latch flip into the pointerdown handler (bypassing the `nameIsValid` gate).

Mutation-tested: removing `onpointerdown` from the button flipped 2 of 8 tests red (functional test + source pin). Restored.

### `web/tests/channel-admin-panel-topic-enter.spec.js` (8 tests)

1. **`Enter on the topic input fires store.setTopic EXACTLY ONCE with the typed value (no empty-string overwrite)`** - fails if the Enter keydown path no longer commits.
2. **`Enter then blur (the real-browser sequence) still fires store.setTopic exactly once and with the correct value (the guard short-circuits the blur)`** - **load-bearing regression test for BUG-PHASE2A-2.** Fails if `if (!editingTopic) return;` guard is removed.
3. **`Blur alone (commit-on-blur, no Enter) still commits the typed value when editing - guard must not break the blur-commit UX path`** - fails if the guard is over-aggressive (e.g. `if (editingTopic) return;` inversion).
4. **`Direct subsequent invocation of the topic editor: open -> blur with NO changes -> reopen -> still works (no stale-state lock)`** - fails if the guard inadvertently locks the function permanently (catches the `if (editingTopic) return;` inversion explicitly).
5. **`Escape during edit cancels without firing store.setTopic`** - regression-pin that Escape still cancels cleanly through both the keydown and the subsequent blur.
6. **`P-1 source pin: commitEditTopic body starts with if (!editingTopic) return; guard`** - fails at edit-time if the guard line is deleted. Also asserts guard ORDERING (guard must precede state writes and store calls).
7. **`P-1 source pin: commitRename carries the same if (!editingName) return; guard`** - fails at edit-time if the preventive guard on the rename function is removed.
8. **`P-3 dual-coverage: topic input still wires BOTH onkeydown AND onblur`** - catches the tempting "simplification" fix of dropping the blur path entirely (which would break the commit-on-blur UX).

Mutation-tested: removing `if (!editingTopic) return;` flipped 4 of 8 tests red. Restored.

## 4. svelte-autofixer per file

- `ChannelModal.svelte`: autofixer run on the representative snippet (script + footer) - **clean**, no issues, no suggestions.
- `ChannelAdminPanel.svelte`: autofixer run on the representative snippet (script + topic-input markup) covering both `commitEditTopic` and `commitRename` - **clean**, no issues, no suggestions.

Both files compile cleanly under `pnpm build` (5.36s, no warnings related to my edits).

## 5. Iteration log entry to merge into v043-iteration-log.md

```markdown
### bug-fix-mini (parallel with E2E Phase 2 Agent B): BUG-PHASE2A-1 + BUG-PHASE2A-2 - RETURNED 2026-05-20

**Commit:** `<filled by orchestrator>` on main (shared tree N=2, file-disjoint with Agent B)
**LOC:** ChannelModal.svelte +21, ChannelAdminPanel.svelte +9, 2 new
vitest specs (channel-modal-bugfix.spec.js 213 LOC + channel-admin-
panel-topic-enter.spec.js 247 LOC), worklog NEW
**Gates:** vitest 1103 (+16 from 1087), pnpm build 5.36s green,
autofixer clean on both .svelte files

### Hands-on §I.19 review hints for orchestrator

1. **Mutation-test both fixes before trusting the suite.** I did:
   - Removing `if (!editingTopic) return;` from `commitEditTopic`:
     4 of 8 admin-panel-topic-enter tests correctly failed (incl.
     the source-level pin). Restored.
   - Removing `onpointerdown=` from the Create button: 2 of 8
     channel-modal-bugfix tests correctly failed (incl. the
     source-level pin). Restored.
2. **Both bugs are real production-impacting**, not just
   test-environment artifacts:
   - BUG-PHASE2A-1: bits-ui focus-trap synthetic-click swallow is
     deterministic in headless and intermittent (timing-sensitive)
     in headed Chromium. Phil's Layer B item #4 may be PARTIALLY
     attributable to this even after Bug 1's cascade fix.
   - BUG-PHASE2A-2: 100% reproducible in any browser. Every user
     who pressed Enter to confirm a topic edit lost their topic.
3. **Preventive rename guard.** The same Enter+blur double-fire
   shape exists in `commitRename` (lines 82-96 of
   ChannelAdminPanel.svelte). I applied the SAME guard there as a
   defensive measure - it costs 1 line and avoids the next
   "topic Enter wipe" bug discovery on a rename refactor. A source-
   level pin on `commitRename` catches it at edit time if removed.

### New patterns reinforced

- **P-1 + P-8 combo for focus-trapped UIs**: the BUG-PHASE2A-1 spec
  exercises P-8 (pre-click state assertion) functionally AND P-1
  (source-level regex pin) for the button-attribute surface. The
  combo means a regression is caught at edit time (P-1) AND at
  runtime (P-8/functional). Triple defense.
- **Mutation-test "test isolates the right invariant"**: when I
  removed `if (!editingTopic) return;`, EXACTLY the tests that
  exercise the blur-after-Enter sequence failed. Tests that
  exercise Enter-alone or blur-alone still passed (because they
  don't exhibit the double-fire pattern). This is the desired
  failure surface area: tight, targeted, traceable.

### W-6 adherence verification

The brief explicitly forbids W-6 (workaround-encoding tests). Both
new specs assert PROPER behavior:
- Modal: tests verify onCreate fires exactly once with correct args
  via the user's actual interaction path (pointerdown + click).
  Doesn't workaround by, say, calling `handleCreate` directly.
- AdminPanel: tests verify topic IS SAVED CORRECTLY on Enter (test
  2's `expect(setTopic).toHaveBeenCalledWith('ch-1', 'Welcome to
  phoenix')` and `not.toHaveBeenCalledWith('ch-1', '')`). The bug
  was that Enter wiped the topic; the test asserts Enter saves it.

### Refinement note for v0.4.4 / future hotfix briefs

When TWO bugs surface simultaneously and one fix touches a function
that has TWIN siblings (e.g. commitEditTopic + commitRename share
the Enter+blur shape), the bug-fix brief should explicitly call
for "scan sibling functions for the same shape and protect them
preventively." Saves a round-trip when the next test surfaces the
same bug class on the twin.
```

## 6. Verification gates (final)

| Gate | Required | Actual |
|---|---|---|
| vitest | ≥1095 (1087 + ≥8 new) | **1103** (1087 + 16 new) |
| vitest failures | 0 | **0** |
| `pnpm build` | green | **green, 5.36s** |
| svelte-autofixer ChannelModal | clean | **clean** |
| svelte-autofixer ChannelAdminPanel | clean | **clean** |
| no em dashes in new files | yes | **verified via grep** |
| files NOT touched: `web/e2e/**` | yes | **verified via git status** |
| files NOT touched: other components | yes | **verified via git status** |

## 7. Files to commit (explicit paths, W-4 mitigation)

- `web/src/components/ChannelModal.svelte`
- `web/src/components/ChannelAdminPanel.svelte`
- `web/tests/channel-modal-bugfix.spec.js` (NEW)
- `web/tests/channel-admin-panel-topic-enter.spec.js` (NEW)
- `.worklogs/v043-bug-fix-mini.md` (this file, NEW)

Explicit `git add <paths>` only; no `git add .`.

## 8. Commit message (per brief - exact)

```
fix(ui): ChannelModal Create click + ChannelAdminPanel topic Enter double-fire (v0.4.3 BUG-PHASE2A-1 + BUG-PHASE2A-2, surfaced by Agent A E2E build)
```
