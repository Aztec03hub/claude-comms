# Worklog — Polish Wave P2: TypeNameConfirmDialog.svelte

**Agent:** svelte-file-editor (Agent-P-DialogComponent, Batch 1 of 4)
**Started:** 2026-05-19T01:25:00Z
**Completed:** 2026-05-19T01:35:00Z
**Step from architecture doc:** `.worklogs/v041-remaining-items-plan.md` Phase 1 / item P2

## 1. Scope

Created a brand-new focus-trapped modal component
`web/src/components/TypeNameConfirmDialog.svelte` plus its companion
test suite `web/tests/type-name-confirm-dialog.spec.js`. The dialog
gates destructive actions behind a "type the resource name exactly"
prompt (GitHub / Linear pattern). Public prop contract is the one
locked in the Polish Wave plan so Batch-2 wiring agent (Agent-P-Wire)
can mount it from `ChannelDirectoryModal`'s Admin tab and the Sidebar
context-menu Delete handler without rename churn:
`{ resourceName, requireTypedName, title?, body, confirmLabel?,
severity?, onConfirm, onCancel }`. Component-only; no wiring touched
in this step (Batch 2 owns the call sites).

## 2. Files modified

- `web/src/components/TypeNameConfirmDialog.svelte` (NEW, 421 lines) — focus-trapped destructive-action confirm dialog with type-the-name gate. Mirrors `LeaveChannelDialog.svelte`'s a11y + focus-trap patterns for visual + behavioral parity.
- `web/tests/type-name-confirm-dialog.spec.js` (NEW, 357 lines, 22 tests) — covers layout / copy, the disabled-until-match gate (incl. case-sensitivity + edit-back), a11y + keyboard (default focus, Escape, Enter on Confirm enabled/disabled, Enter on input swallowed), and click wiring (Cancel, Confirm enabled/disabled, overlay, content-stopPropagation).

## 3. Files consulted (read-only)

- `web/src/components/LeaveChannelDialog.svelte` — canonical focus-trap + overlay reference per the step brief; pattern lifted verbatim where applicable (queueMicrotask default-focus, three-resolved-Promise + tick microtask flush, ID suffix randomization, overlay-click bubbling guard via stopPropagation on the modal).
- `web/tests/leave-channel-dialog.spec.js` — test harness reference (`makeProps`, `flushMicrotasks`, `fireKey` helpers, `afterEach(cleanup)`, `@testing-library/svelte`'s `render` + `fireEvent`).
- `web/package.json` — confirmed Svelte 5 + vitest 4.1.5 + `@testing-library/svelte` 5.3.1 in use.
- `.worklogs/v041-remaining-items-plan.md` — full plan (read in line order per memory `feedback_never_skim_design_docs`).
- `.worklogs/architecture-and-orchestration-plan.md` §I.5 + §I.6 — worklog format + 12 standing rules.

## 4. Code changes (samples)

### a) Disabled-until-match gate (the heart of the dialog)

```diff
+ let inputValue = $state('');
+
+ // Exact, case-sensitive match. Empty `requireTypedName` would make the
+ // gate trivially passable, so guard against that defensively.
+ let canConfirm = $derived(
+   typeof requireTypedName === 'string' &&
+     requireTypedName.length > 0 &&
+     inputValue === requireTypedName
+ );
```

Confirm button binds `disabled={!canConfirm}` and `aria-disabled={!canConfirm}`. The click handler ALSO guards on `canConfirm` so a programmatic dispatch that bypasses the `disabled` attribute (e.g. testing-library doesn't enforce native click-blocking on disabled buttons) still doesn't trigger `onConfirm`.

### b) Enter-on-input suppression (the typer-Enter-through reflex guard)

```diff
+ function handleInputKeydown(e) {
+   if (e.key === 'Enter') {
+     e.preventDefault();
+   }
+ }
+ // <input onkeydown={handleInputKeydown} bind:value={inputValue} ... />
```

Typing the resource name and reflexively pressing Enter must NOT submit. The user must Tab (or click) to the Confirm button. This is the same "destructive default-focus on Cancel" philosophy LeaveChannelDialog uses, applied to the input field.

### c) Severity-driven button color (danger / warning / primary)

```diff
+ <button
+   type="button"
+   class="type-name-btn {severity}"
+   disabled={!canConfirm}
+   ...
+ >{confirmLabel}</button>
```

`.danger` keeps parity with LeaveChannelDialog's red gradient; `.warning` (amber) and `.primary` (blue) added for future callers (`severity = 'danger'` by default, which matches both v0.4.0 placeholder sites).

## 5. Verification commands run

```
$ /home/plafayette/claude-comms/.venv/bin/ruff check src/ tests/ 2>&1 | tail -3
All checks passed!
```

```
$ /home/plafayette/claude-comms/.venv/bin/python -m pytest --tb=no -q 2>&1 | tail -3
-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html
1268 passed, 66 warnings in 23.67s
```

(Baseline 1268; unchanged. Component-only addition; no Python surface.)

```
$ cd web && CI=true pnpm exec vitest run --reporter=dot tests/type-name-confirm-dialog.spec.js 2>&1 | tail -10
 RUN  v4.1.5 /home/plafayette/claude-comms/.claude/worktrees/agent-acf20eb2a60193b3d/web

······················

 Test Files  1 passed (1)
      Tests  22 passed (22)
   Start at  20:33:38
   Duration  836ms (transform 277ms, setup 0ms, import 381ms, tests 57ms, environment 326ms)
```

All 22 new tests pass on first run.

```
$ cd web && CI=true pnpm exec vitest run --reporter=dot 2>&1 | tail -6
···············································································································································································································

 Test Files  43 passed (43)
      Tests  767 passed (767)
   Start at  20:33:43
   Duration  26.05s (transform 54.93s, setup 0ms, import 141.78s, tests 7.03s, environment 19.06s)
```

Baseline 745 → 767 (+22). No regressions in the other 745 tests.

```
$ cd web && CI=true pnpm build 2>&1 | tail -3
../src/claude_comms/web/dist/assets/vendor-ui-DQlGeG72.js                          413.56 kB │ gzip:  65.18 kB │ map: 1,388.37 kB
✓ built in 7.75s
```

Build green. Bundle integrates without errors.

```
$ ls web/src/components/TypeNameConfirmDialog.svelte
web/src/components/TypeNameConfirmDialog.svelte

$ grep -c "—" web/src/components/TypeNameConfirmDialog.svelte
0

$ grep -E "(describe|it)\(.*—" web/tests/type-name-confirm-dialog.spec.js ; echo "exit=$?"
exit=1
```

Zero em dashes in the component AND in test `describe()` / `it()` strings. Em dashes that remain in the test file are all inside JS line comments (`// — note`), which are dev-only prose, not user-facing copy.

### Svelte autofixer

Called via the MCP `svelte-autofixer` tool on the final component. Result:

```
issues: []
suggestions: [
  "queueMicrotask inside $effect — check for $derived",
  "function-call inside $effect (cancelBtn?.focus) — check for $derived",
  "function-call inside $effect (previouslyFocused.focus cleanup) — check for $derived",
  "bind:this could be replaced by attachment",
  "bind:this could be replaced by attachment"
]
```

All five are advisory `suggestions` (not `issues`). Each one is a deliberate pattern-parity choice with the canonical reference component `LeaveChannelDialog.svelte` (Step 2.11):

- The three `$effect` warnings flag DOM-imperative side effects (focusing an element after mount, restoring focus on unmount). These can't be modeled as `$derived` — they ARE side effects on the DOM, which is exactly what `$effect` is for.
- The two `bind:this` warnings recommend Svelte 5 attachments. LeaveChannelDialog uses `bind:this` for the same role (cancel-button + dialog-root refs); preserving parity keeps the two destructive-confirm dialogs textually similar for future maintenance.

## 6. Tests added / modified

- `web/tests/type-name-confirm-dialog.spec.js` — 22 new tests organized into 4 `describe` blocks: 5 layout/copy, 6 disabled-until-match gate, 6 a11y/keyboard, 5 click wiring. Spec requested >= 8; delivered 22 to fully pin the prop contract and gate semantics so Batch-2 wiring doesn't regress them.

## 7. Findings surfaced during work

- **(S) Suggestion for Batch 2 (Agent-P-Wire)**: the two v0.4.0 placeholder sites are `ChannelDirectoryModal`'s Admin tab (likely `window.confirm` for archive/delete) and the Sidebar context-menu Delete. To keep both call-sites consistent, recommend Agent-P-Wire wraps the dialog mount in a small helper (e.g. `confirmDestructive({ resourceName, requireTypedName, body, confirmLabel })`) that returns a Promise resolving on Confirm and rejecting on Cancel. This mirrors the ergonomic of the `window.confirm` API it replaces and keeps the two call sites grep-equivalent.
- **(S) Severity-color tokens hardcoded**: I hardcoded the danger/warning/primary gradients to match `LeaveChannelDialog`'s `.leave-btn.danger` rather than threading through Tailwind theme tokens. The v0.5.0 architectural cleanup (Eng A11Y-1/2/3 area) is a natural time to consolidate these gradient styles into a shared `.btn-danger` class. No action needed in the Polish Wave.
- **(S) `bind:this` vs attachments**: per autofixer suggestion 4-5, Svelte 5 attachments are the recommended forward style. If/when LeaveChannelDialog migrates to attachments (likely in v0.5.0 A11Y-2 dialog focus-trap consolidation), TypeNameConfirmDialog should follow in the same commit for parity.

No (M+) items surfaced.

## 8. Rollback

If committed: `git revert <sha>` undoes this step cleanly. Yes.

Both touched files are NEW (no existing-file modifications), so revert
just removes them. No store / API / wiring side effects.

## 9. Outstanding concerns

None. Brief was unambiguous, prop contract was pre-locked by the plan,
reference component was identified, and all verification gates passed on
the first attempt.
