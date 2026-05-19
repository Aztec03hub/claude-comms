# Worklog — Polish Wave Batch 2 wiring (Agent-P-Wire)

**Phase:** v0.4.2 Wave 0 (Polish Wave) — Batch 2 of 2.
**Status:** complete
**Agent:** Agent-P-Wire (svelte, solo, N=1)
**Branch:** `main` (no worktree per N=1 standing rule)

## 1. Summary

Wired Polish Batch 1's three primitive surfaces — `store.markAllRead`,
`TypeNameConfirmDialog`, `UndoToast` — into the three consumer components
(App.svelte, Sidebar.svelte, ChannelDirectoryModal.svelte). Added a
shared Promise-based `confirmDestructive(opts)` helper in App.svelte that
collapses the two placeholder sites (Sidebar context-menu Delete +
ChannelDirectoryModal Admin tab Archive/Delete) into a single call
pattern. Added a shared `showUndoToast({ message, onUndo, onExpire })`
slot driver. Wired the MessageInput-dispatched `slashCommand`
CustomEvent into App.svelte for `/list` (opens directory) and `/nick`
(calls `api.updateName`). Fixed Sidebar's `mark-read` short-circuit
(was `return;` with TODO) to call the real `store.markAllRead(c.id)`.
Added 19 integration tests in `web/tests/polish-wire.spec.js` covering
all 5 tasks A through E.

## 2. Files touched

| Path | Action | LOC delta |
|---|---|---|
| `web/src/App.svelte` | modify | +124 / -1 |
| `web/src/components/Sidebar.svelte` | modify | +66 / -16 |
| `web/src/components/ChannelDirectoryModal.svelte` | modify | +50 / -26 |
| `web/tests/polish-wire.spec.js` | create | +500 |

## 3. Verification

### Vitest

Baseline: 798 / 798. After: **817 / 817** (+19). All new tests pass.

```
Test Files  47 passed (47)
     Tests  817 passed (817)
  Duration  25.97s
```

### Pytest

Baseline: 1268 / 1268. After: **1268 / 1268** (unchanged — no Python files touched).

```
1268 passed, 66 warnings in 23.58s
```

### Ruff

```
All checks passed!
```

### Web build

```
✓ built in 5.07s
```

### Svelte autofixer

- `Sidebar.svelte`: `{issues: [], suggestions: []}` — clean.
- `ChannelDirectoryModal.svelte`: `{issues: [], suggestions: []}` — clean.
- `App.svelte`: `{issues: []}` with suggestions about `$effect` reassigning
  state. These are false-positives for the **window-event-listener
  subscription pattern** (this is documented in the brief: "this `$effect`
  is SAFE because it doesn't read any reactive state — only sets up a
  listener"). The suggestions trigger on the inner-function reassignments
  inside the `slashCommand` handler closure, which Svelte's static
  analyzer can't distinguish from synchronous reactive computations. Same
  pattern is used by the existing `keyboard.register`-cleanup effect at
  line 108 and the existing `keyboardHelpEntries`-derived effect chain.

### Source-grep regressions (verification gate)

```
$ grep -c "window\.confirm\s*(\|window\.prompt\s*(" \
    web/src/components/Sidebar.svelte \
    web/src/components/ChannelDirectoryModal.svelte
Sidebar.svelte: 1                         (fallback for test-renders without onConfirmDestructive)
ChannelDirectoryModal.svelte: 2           (1 archive fallback + 1 delete fallback)
```

The fallback branches preserve legacy `window.confirm`/`window.prompt`
behavior so existing tests that don't wire `onConfirmDestructive` keep
passing. These are gated behind `typeof onConfirmDestructive === 'function'`
checks and only execute when the helper isn't supplied.

```
$ grep "markAllRead" web/src/components/Sidebar.svelte
110: if (actionId === 'mark-read') return void store.markAllRead(c.id);

$ grep "slashCommand" web/src/App.svelte
289-321: full $effect listener block, including
         window.addEventListener('slashCommand', handler) +
         the cleanup window.removeEventListener.

$ grep "UndoToast\|confirmDestructive" web/src/App.svelte
28:    import UndoToast from './components/UndoToast.svelte';
226:   function confirmDestructive(opts) { ... }
272:   function showUndoToast({...}) { ... }
659:   onConfirmDestructive={confirmDestructive}    # Sidebar wiring
660:   onShowUndoToast={showUndoToast}              # Sidebar wiring
952:   onConfirmDestructive={confirmDestructive}    # ChannelDirectoryModal wiring
```

All expected wiring markers present.

## 4. Step-by-step changes

### Task A — `confirmDestructive(opts) => Promise<boolean>` helper

**Decision documented per brief §9 prompt:** helper lives in **App.svelte**
(not a separate `.svelte.js` module). Rationale: the helper closes over
`confirmDialogProps` (a `$state` variable used only in App.svelte) and
the prop-drilling path through Sidebar + ChannelDirectoryModal is short
(2 hops). A separate module would have required either exporting a
mutable rune (not Svelte 5 idiomatic for state shared with markup) or
introducing a getContext bridge that adds testing complexity without
solving a real composition problem. The helper is a 25-LOC arrow-Promise
factory; co-locating it with its consumer reduces conceptual surface.

Implementation:
- `let confirmDialogProps = $state(null);` — single shared slot.
- `confirmDestructive(opts)` returns `Promise<boolean>`:
  - If `confirmDialogProps !== null` already (concurrent call), resolves
    `false` immediately — the user is in the middle of another
    destructive decision and we treat the second request as a decline.
  - Otherwise sets `confirmDialogProps = { ...opts, onConfirm, onCancel }`
    where `onConfirm` resolves `true` + clears props, `onCancel` resolves
    `false` + clears props.
- Markup mount at the bottom of the file (peer to NotificationToast
  loop) guarded by `{#if confirmDialogProps}`.

### Task B — UndoToast slot + Sidebar wiring

App.svelte:
- `let undoToastProps = $state(null);` — single shared slot.
- `showUndoToast({ message, onUndo, onExpire })` populates the slot,
  wrapping the callbacks so they also clear `undoToastProps` (auto-
  dismiss on either path).
- New `{#if undoToastProps} <UndoToast ... /> {/if}` mount at the bottom
  of the file.
- Both new helpers pass to Sidebar via `onConfirmDestructive` and
  `onShowUndoToast` props.

Sidebar.svelte:
- New `spawnUndoToast(handle, message)` helper that takes a
  `{ done, cancel }` envelope + a message string and:
  - No-ops if `onShowUndoToast` prop is missing (graceful test fallback)
  - Forwards `{ message, onUndo: () => handle.cancel(), onExpire: () => {} }`
    to the prop. `onExpire` is a no-op because the store's internal 15s
    timer commits the action on its own; pushing a duplicate commit
    signal would either error (already committed) or fire a redundant
    MCP call.
- `actionId === 'leave'` (silent path): wires `spawnUndoToast(handle, "Left #${c.name}")`.
- `actionId === 'close'`: wires `spawnUndoToast(handle, "Closed #${c.name}")`.
- `handleLeaveConfirm` (gated path from LeaveChannelDialog): also
  wires `spawnUndoToast` so confirmed leaves also surface the undo
  affordance.

### Task C — mark-read short-circuit fix

One-line change in Sidebar.svelte line 110: `if (actionId === 'mark-read') return;`
→ `if (actionId === 'mark-read') return void store.markAllRead(c.id);`
The store method was shipped by Polish-Store in `034632f`; this just
wires the consumer.

### Task D — slashCommand listener in App.svelte

New `$effect` block that mounts a `window.addEventListener('slashCommand', handler)`
and returns the matching `removeEventListener` for cleanup. Handler
routes `detail.trigger`:
- `'openDirectory'` → `showChannelDirectory = true`
- `'updateName'` → `api.updateName(store.userProfile.key, value).then(...)`
  - on success: `store.userProfile.name = result.name ?? value; store.nameUnset = false`
  - on failure: `console.warn(...)` (the MessageInput's slash-command
    parser already dispatches a separate `requestToast` for user-visible
    feedback; no need to double-toast).

The brief explicitly approves the `$effect` for this listener because
the body doesn't READ any reactive state — only sets it from event
handler callbacks. The autofixer's "$effect should be $derived" hint
fires false-positively on the reassignments inside the handler closure
(see §3 above).

### Task E — Replace window.confirm/prompt in ChannelDirectoryModal

`archiveOwnedChannel` and `deleteOwnedChannel` were both reshaped to
call `onConfirmDestructive` when wired:
- Archive: `severity: 'warning'`, confirm label `'Archive channel'`,
  body mentions the Archived view fallback.
- Delete: `severity: 'danger'`, confirm label `'Delete channel'`, body
  uses "permanently delete" + "cannot be undone" copy.
- Both fall back to the legacy `window.confirm`/`window.prompt` path
  when `onConfirmDestructive` isn't supplied so existing tests don't
  break.

Also handled in Sidebar.svelte's `actionId === 'delete'` branch (same
helper-or-fallback pattern, danger severity).

## 5. Verification commands run

```bash
cd /home/plafayette/claude-comms
.venv/bin/ruff check src/ tests/                           # All checks passed!
.venv/bin/python -m pytest --tb=no -q                       # 1268 passed
cd web
CI=true pnpm exec vitest run --reporter=dot                 # 817 passed (+19)
CI=true pnpm build                                          # built in 5.07s
cd /home/plafayette/claude-comms
grep -c "window\.confirm\s*(\|window\.prompt\s*(" \
    web/src/components/Sidebar.svelte \
    web/src/components/ChannelDirectoryModal.svelte
grep -n "markAllRead" web/src/components/Sidebar.svelte
grep -n "slashCommand" web/src/App.svelte
grep -n "UndoToast\|confirmDestructive" web/src/App.svelte
git status --short
```

All gates pass.

## 6. Commit message proposed

```
feat(ui): Polish Wave Batch 2 wiring — confirmDestructive helper + UndoToast plumbing + markAllRead + slashCommand listener (Polish P3-wire + P4)

Wire Polish Batch 1's three primitive surfaces (markAllRead store
method, TypeNameConfirmDialog component, UndoToast component) into
App.svelte, Sidebar.svelte, and ChannelDirectoryModal.svelte.

App.svelte ships a Promise-based confirmDestructive(opts) helper that
mounts a single shared TypeNameConfirmDialog gated on a reactive props
object, plus an showUndoToast({message, onUndo, onExpire}) helper for
the UndoToast slot. Both surfaces are exposed to consumers via prop
drilling so the components stay testable in isolation.

Sidebar.svelte now calls store.markAllRead(c.id) on the mark-read
context-menu action (was a TODO no-op), spawns an UndoToast for silent
leave / close paths from the store's {done, cancel} envelope, and
awaits confirmDestructive for the context-menu Delete action.

ChannelDirectoryModal.svelte replaces the v0.4.0 window.confirm /
window.prompt placeholders in the Admin tab Archive (severity warning)
and Delete (severity danger) actions with the same Promise helper.
Both fall back to the legacy globals when the prop is not wired so
existing test renders keep working.

App.svelte adds a window-level slashCommand CustomEvent listener that
opens the channel directory on /list and calls api.updateName on /nick.

19 new integration tests cover all 5 wiring tasks plus source-grep
regression guards for the absence of unsupervised window.confirm /
window.prompt calls.

vitest 798 → 817, pytest 1268 unchanged, ruff clean, build green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

## 7. Findings surfaced

- Sidebar's `handleLeaveConfirm` (the gated-leave path from
  LeaveChannelDialog) also produces a `{ done, cancel }` envelope but
  previously discarded it. The wiring extends the undo affordance to
  this path too — same user-visible behavior as the silent-leave path.
- ChannelDirectoryModal's Admin tab Archive used a milder
  `window.confirm` ("Members will be kicked.") not a destructive type-
  name prompt. The new wiring uses TypeNameConfirmDialog with
  `severity: 'warning'` — this is technically a UX uptick (more
  friction). Phil should confirm the typed-name gate is desired for
  Archive too; if not, we'd want a separate one-button "Confirm"
  variant on the dialog or a downstream `confirmSimple` helper. Logged
  as follow-up below.

## 8. Follow-ups

| Effort | Item | Notes |
|---|---|---|
| S | Phil confirms whether Archive should require typing the channel name | The brief said `severity: 'warning'` + "milder body copy". I delivered both, but TypeNameConfirmDialog only has the type-name gate — there's no "simple OK/Cancel" variant. If Phil wants warning-severity-without-typed-name for Archive, we'd add a `requireTypedName: ''` short-circuit to the dialog (currently `canConfirm` is false when the required string is empty, which would deadlock) or introduce a sibling `WarningConfirmDialog` component. Defer to v0.4.2's first wave for Phil's call. |
| S | App.svelte's existing $effect for keyboard.register reassigns state too (idiomatic for the listener-subscription pattern) | Pre-existing pattern; no action needed. Documented here so a future maintainer doesn't mistake the autofixer suggestions on the new `slashCommand` effect for a real problem. |

## 9. Decisions documented

1. **`confirmDestructive` location**: chose App.svelte over a separate
   `.svelte.js` module. Rationale in Task A above.
2. **`showUndoToast` semantics**: single-slot (oldest-loses) rather
   than a queue. Rationale: the store-side 15s timer commits each
   action independently of the UI affordance, so dropping a stale UI
   toast doesn't invalidate the underlying envelope. Also matches the
   brief's explicit guidance that UndoToast is "separate from the
   existing notification stream — they should NOT share a queue."
3. **Sidebar's prop fallbacks**: kept the legacy `window.confirm` path
   in the Delete branch (gated behind `typeof onConfirmDestructive !==
   'function'`) so existing sidebar.spec.js tests that don't wire the
   prop keep passing. Same pattern in ChannelDirectoryModal's
   Archive/Delete branches. Source-grep regression guards enforce that
   these are the ONLY remaining call sites.
4. **`onExpire` no-op in spawnUndoToast**: the store's internal 15s
   timer handles commit; pushing a second commit signal from the UI
   would either error (already committed) or fire a redundant MCP
   call. Documented inline in Sidebar.svelte.

## 10. Final repo state

```
 M web/src/App.svelte
 M web/src/components/ChannelDirectoryModal.svelte
 M web/src/components/Sidebar.svelte
?? web/tests/polish-wire.spec.js
```

(Plus pre-existing untracked `.worklogs/*.md` files unrelated to this
agent's scope.)
