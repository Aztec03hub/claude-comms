# Worklog — v0.4.2 Polish Wave P3: UndoToast.svelte

**Step:** Polish Wave P3 (Agent-P-UndoToast, Batch 1)
**Agent:** svelte
**Worktree:** `/home/plafayette/claude-comms/.claude/worktrees/agent-a7094bce9483d7961`
**Branch:** `worktree-agent-a7094bce9483d7961`
**Base SHA:** `a4dba0c` (v0.4.1 hotfix)
**Status:** complete
**Date:** 2026-05-18

## 1. Summary

Created a new standalone Svelte 5 component, `UndoToast.svelte`, that provides
the 15-second undo affordance for the silent `leaveChannel` and
`archiveChannel` paths in `mqtt-store.svelte.js`. The store's existing
`{ done, cancel }` envelope is the design contract; this component renders the
UI half of that affordance. Wiring into Sidebar is owned by Agent-P-Wire in
Batch 2.

## 2. Scope (writeable files in this dispatch)

| File | Action | LOC |
|------|--------|-----|
| `web/src/components/UndoToast.svelte` | CREATE | 317 |
| `web/tests/undo-toast.spec.js` | CREATE | 226 |

No other files touched. Disjoint from sibling Batch-1 agents (P1+P6 store,
P2 dialog, P5+P7 docs) per the file-ownership matrix.

## 3. Public contract (do NOT rename — Agent-P-Wire consumes)

```svelte
let {
  message,                  // string. Toast body, e.g. "Left #general".
  undoLabel = 'Undo',       // string. Button label.
  timeoutMs = 15000,        // number. Countdown ms; matches store envelope.
  onUndo,                   // () => void. User clicked Undo in window.
  onExpire,                 // () => void. Timer expired OR user dismissed.
} = $props();
```

### Behavior

- Mount starts a single `setTimeout` for `timeoutMs`.
- Undo click → `onUndo()` + cleanup timer + exit animation. NOT `onExpire`.
- Timer fires → `onExpire()` + cleanup + exit animation. NOT `onUndo`.
- X-dismiss click → `onExpire()` (NOT a separate callback). Design rationale
  per brief: dismissing without undoing means the user accepted the action.
- Idempotent finalize() guards against double-fire (e.g. timer firing during
  the exit animation after a click).
- Unmount via parent → `$effect` cleanup clears the pending timer, so no
  late `onExpire` fires against stale closures.

### A11y

- `role="status"` + `aria-live="polite"` on the root container.
- Undo and Dismiss are real `<button>` elements with `type="button"`.
- Dismiss has explicit `aria-label="Dismiss"`.

### Reduced motion

- `prefers-reduced-motion: reduce` detected on mount via `window.matchMedia`.
- Progress bar snaps (via `.reduced` class + CSS `@media` query) instead of
  smooth-animating. Countdown timer logic is unchanged.

### Visual

- Position: lower-right (`bottom: 16px; right: 16px; position: fixed`).
  Intentionally distinct from `NotificationToast.svelte` (top-right) so the
  two toast streams do not visually collide. Per Polish-wave risk note in
  plan, they are also separate queues.
- Color: neutral (`var(--bg-elevated)` background + `var(--border)`), NOT
  the ember accent that `NotificationToast` uses for new messages. The undo
  affordance is informational, not destructive.
- Progress bar: thin (`2px`) gradient bar at the bottom, animates via
  `transform: scaleX(1 -> 0)` over `--undo-duration` (bound from
  `timeoutMs` via inline style).

## 4. Tests

`web/tests/undo-toast.spec.js` covers 17 cases across 5 describe blocks:

1. **Render contract (6 tests)**: message text, default undoLabel, custom
   undoLabel, dismiss button is a `<button>`, role/aria-live attributes,
   undo button is a `<button type="button">`.
2. **Undo within window (3 tests)**: clicking Undo fires onUndo, does NOT
   fire onExpire, cancels the pending timer so advancing the clock past
   timeoutMs still does not fire onExpire.
3. **Countdown expiration (4 tests)**: fires onExpire after exactly
   timeoutMs (not at timeoutMs-1), does NOT fire onUndo, respects a custom
   timeoutMs of 250ms (proves prop is wired), fires onExpire at most once.
4. **X dismiss behavior (2 tests)**: clicking X fires onExpire (not
   onUndo), and cancels the timer.
5. **Reduced motion + lifecycle (2 tests)**: with matchMedia patched to
   report `(prefers-reduced-motion: reduce)`, the `.reduced` class is
   applied and the timer still fires; unmount before timer fires cleans up
   the pending timer (no late onExpire).

Brief required ≥7 tests; this suite has 17 (+10 over minimum).

`vi.useFakeTimers()` is used for all countdown tests. `cleanup()` runs in
`afterEach` BEFORE `vi.useRealTimers()` so the component's `$effect`
cleanup runs against the fake-timers scheduler (clears the pending fake
timer); otherwise a pending fake timer could leak into the next test's
setup.

## 5. Verification gate

```
$ ls web/src/components/UndoToast.svelte web/tests/undo-toast.spec.js
web/src/components/UndoToast.svelte
web/tests/undo-toast.spec.js

$ /home/plafayette/claude-comms/.venv/bin/ruff check src/ tests/
All checks passed!

$ /home/plafayette/claude-comms/.venv/bin/python -m pytest --tb=no -q
1268 passed, 66 warnings in 24.49s

$ cd web && CI=true pnpm exec vitest run --reporter=dot
Test Files  43 passed (43)
Tests       762 passed (762)
Duration    21.92s

$ CI=true pnpm build
built in 5.87s

$ grep -nE '"[^"]*—[^"]*"' web/src/components/UndoToast.svelte
(no matches — zero em dashes in user-facing string literals)
```

### Baselines

| Gate | Baseline | Now | Delta |
|------|----------|-----|-------|
| pytest | 1268 | 1268 | 0 |
| vitest | 745 | **762** | **+17** (≥7 required) |
| ruff | clean | clean | OK |
| build | green | green | OK |
| Svelte autofixer | n/a | 0 issues | OK |
| em dashes in user copy | 0 | 0 | OK |

## 6. Svelte autofixer report

Final autofixer pass: **0 issues**, 3 advisory suggestions (all about
`setTimeout`/`finalize`/`clearTimers` being called inside `$effect`).
These are genuine lifecycle side effects that cannot be `$derived`; the
advisory text explicitly says "Ignore this suggestion if you are sure" —
which applies here. An inline code comment in the component documents this
decision so a future reader does not try to "fix" it.

The earlier draft had `reduceMotion` assigned inside the `$effect`; I
refactored to initialize it at module scope via a `detectReduceMotion()`
helper so the value is correct on first render (avoids a transient
"animated then snapped" frame) and removes one of the autofixer
advisories. The remaining three relate to the unavoidable timer
registration in `$effect`.

## 7. Follow-ups surfaced

None. The component is fully self-contained for Batch 1. Wiring (sidebar
calls, message construction, mount lifecycle) is Agent-P-Wire's job in
Batch 2.

## 8. Risk notes for Batch 2 (Agent-P-Wire)

- **DO NOT** re-use the existing `NotificationToast` queue. They render in
  different corners (top-right vs lower-right) and have different prop
  contracts. Per the plan's risk note, the two should NOT share a queue.
- The `{ done, cancel }` envelope returned by the store must be consumed
  exactly once. Wire `onUndo` to `cancel()` and `onExpire` to `done()`. The
  finalize() guard in UndoToast ensures only ONE of these fires per toast
  lifetime, so the store-side commit is guaranteed exactly-once.
- If Agent-P-Wire wants to allow multiple in-flight undo toasts (e.g. user
  leaves two channels back-to-back), they should mount multiple instances
  of UndoToast — each manages its own timer. They will visually stack at
  the lower-right; consider a small vertical offset per toast or a queue
  pattern. Not in scope for P3.

## 9. Commit

```
feat(ui): UndoToast.svelte for 15s leave/archive undo affordance (Polish P3)
```

Staged paths (explicit, per §I.6 rule #11):
- `web/src/components/UndoToast.svelte`
- `web/tests/undo-toast.spec.js`
- `.worklogs/v042-P3-undo-toast.md`

## 10. Worktree + branch

- Worktree path: `/home/plafayette/claude-comms/.claude/worktrees/agent-a7094bce9483d7961`
- Branch: `worktree-agent-a7094bce9483d7961`
- Base SHA: `a4dba0c`
