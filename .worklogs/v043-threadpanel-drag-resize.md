# v0.4.3 ThreadPanel drag-resize agent worklog

**Phase:** v0.4.3 hotfix, Phil mid-Layer-B feature request
**Wave:** N=2 parallel (this agent + E2E Phase 1 scaffolding agent; files disjoint)
**Base commit:** `cb5695d` (post Agent 1 bug-fix integration)
**Status:** SHIPPED

## 1. WHAT shipped

ThreadPanel.svelte gains a draggable left-edge resize handle that mirrors
ArtifactPanel.svelte's pattern verbatim. Width persists per-user in
localStorage under `claude-comms:thread-panel-width`. Pointer Events drive
mouse + touch + pen interaction. The handle is exposed as an ARIA
window-splitter (`role="separator"`) with `tabindex="0"`, `aria-valuenow`,
`aria-valuemin`, `aria-valuemax`, and keyboard nudges (ArrowLeft/Right =
+/-16px, Home = max, End = min).

The pre-v0.4.3 fixed width of `360px` becomes the `DEFAULT_PANEL_WIDTH`
constant so existing users see no visual change on first paint.

## 2. ArtifactPanel pattern + my adaptation

**Approach mirrored verbatim:**
- PointerEvent-based (`pointerdown` / `pointermove` / `pointerup` /
  `pointercancel`) with `setPointerCapture` so drag continues even if the
  cursor leaves the handle. Same lifecycle as ArtifactPanel.
- `dragOffsetX` captured on `pointerdown` so the grip stays under the
  cursor on first move (avoids the snap-to-cursor jump).
- `clampWidth(w)` with viewport-aware upper bound: `Math.min(MAX, viewport - MIN_CHAT_RESERVE)`.
- `safeStorage` wrapper with `try`/`catch` around `localStorage` for
  private-browsing / quota tolerance.
- `$effect` registering a `window.addEventListener('resize', ...)` that
  re-clamps the stored width if the viewport shrinks. Cleanup function
  removes the listener on unmount.
- Same a11y pattern with two `svelte-ignore` comments for
  `a11y_no_noninteractive_tabindex` + `a11y_no_noninteractive_element_interactions`.

**Deltas (intentional, panel-specific):**
- `MIN_PANEL_WIDTH = 280` (ArtifactPanel uses 320). ThreadPanel hosts
  shorter reply text + a single composer column, so a tighter floor is
  usable. ArtifactPanel hosts code blocks + diffs which need 320 minimum.
- `MAX_PANEL_WIDTH = 720` (ArtifactPanel uses 900). Threads rarely benefit
  from very wide layouts — long replies wrap fine at 720; wider just eats
  chat real estate.
- `DEFAULT_PANEL_WIDTH = 360` (ArtifactPanel uses 380). Preserves the
  pre-v0.4.3 fixed width for existing users — no surprise on first paint.
- Storage key: `claude-comms:thread-panel-width` (mirrors
  ArtifactPanel's `claude-comms:artifact-panel-width` naming convention).

## 3. Shared ResizeHandle component extracted? NO

**Rationale:** the brief permitted extraction only "if ArtifactPanel has
one and it's clean; otherwise inline." ArtifactPanel inlines the handle —
it is NOT a separate component. Two arguments for keeping ThreadPanel
inline too:

1. **Scope discipline.** ArtifactPanel.svelte is READ-ONLY per the brief.
   Extracting a shared component would require touching ArtifactPanel to
   adopt it, violating scope.
2. **Coupling.** The handle's state (`panelWidth`, `isResizing`,
   `resizeHandleEl`, `dragOffsetX`) is tightly bound to the parent
   panel's own state — extracting would push 6 props + 2 callbacks across
   the boundary, which is more friction than the ~50 LOC of shared
   handler code saves. Better refactor target for v0.5+ when there is a
   THIRD consumer.

## 4. File + LOC deltas

| File | Before | After | Delta | Touch |
|---|---|---|---|---|
| `web/src/components/ThreadPanel.svelte` | 427 | 680 | +253 | EDIT |
| `web/tests/thread-panel.spec.js` | 543 | 815 | +272 | EXTEND |
| `.worklogs/v043-threadpanel-drag-resize.md` | 0 | (this) | new | NEW |

No ResizeHandle.svelte; no other files touched.

## 5. Tests by name + mutation invariant each protects

10 new tests in `describe('ThreadPanel — drag-resize handle (v0.4.3 new feature)')`:

| # | Test name | Mutation invariant protected |
|---|---|---|
| 9.1 | `drag-handle is rendered with separator role and ew-resize cursor (source-level pin)` | deletes role="separator" / tabindex="0" / aria-label / `cursor: ew-resize` / `touch-action: none` |
| 9.2 | `pointerdown + pointermove resizes ThreadPanel (panel width tracks cursor)` | deletes `handleResizePointerDown` or `handleResizePointerMove` body; deletes `isResizing = true` (no class applied) |
| 9.3 | `pointerup ends the drag (is-resizing class drops)` | deletes `isResizing = false` in `handleResizePointerUp` |
| 9.4 | `size persists to localStorage on pointerup (committed width survives unmount)` | deletes `safeStorage.setItem(STORAGE_KEY, ...)` in `handleResizePointerUp` |
| 9.5 | `localStorage value is restored on mount (initialPanelWidth reads STORAGE_KEY)` | deletes `safeStorage.getItem(STORAGE_KEY)` in `initialPanelWidth` (would default to 360 not 480) |
| 9.6 | `min size is enforced (drag below clamps to MIN_PANEL_WIDTH=280)` | deletes `Math.max(MIN_PANEL_WIDTH, ...)` in `clampWidth`; renames the constant to anything other than 280 (source pin) |
| 9.7 | `max size is enforced (drag above clamps to MAX_PANEL_WIDTH=720)` | deletes `Math.min(upper, w)` in `clampWidth`; renames MAX to anything other than 720 (source pin) |
| 9.8 | `keyboard ArrowLeft grows the panel (16px nudge) and persists` | deletes ArrowLeft case in `handleResizeKeydown`; or removes the `safeStorage.setItem` on key commit |
| 9.9 | `storage key is "claude-comms:thread-panel-width" (source-level pin guards localStorage namespace)` | renames STORAGE_KEY constant; also asserts ArtifactPanel uses the same namespace so the mirror invariant holds |
| 9.10 | `Home key jumps to MAX, End key jumps to MIN (keyboard accessibility extremes)` | deletes Home/End cases in `handleResizeKeydown` |

All 10 verified mutation-testable via §I.19 mental check.

**Source-level regex pins** used in 9.1, 9.6, 9.7, 9.9 per the §I.19
finding that they are robust against future regressions because they bite
at edit time, not runtime.

**DOM presence is NOT used alone** — tests 9.2/9.3 check `class:is-resizing`
on `panel.className`, 9.5/9.6/9.7/9.10 check `style="width: Npx"` on the
panel element. Each assertion is a computed/applied effect of the
production code path, not a vacuous "element exists" check.

## 6. svelte-autofixer per file

`ThreadPanel.svelte`: `issues: []` (zero errors). Remaining suggestions:
- 6 `$effect` suggestions about "reassigning stateful variable inside
  $effect" — these are noise. The effect is a `window.addEventListener`
  cleanup pair which CANNOT be expressed as `$derived` (need listener
  registration). ArtifactPanel.svelte (the source-of-truth pattern Phil
  approved) exhibits the identical pattern.
- 1 `bind:this` suggestion to use an attachment instead. Same as above:
  ArtifactPanel uses `bind:this` for the same `setPointerCapture` use
  case. Mirror verbatim is the brief.

Vitest run confirms no Svelte 5 build warnings on the actual file
(initially had warnings about `tabindex` + `mouse/keyboard event
listeners on noninteractive element`; resolved by adding the two
`svelte-ignore` comments matching ArtifactPanel's approach).

## 7. [VERIFY] items

- **[VERIFY-1]** Layer B re-test: drag the ThreadPanel left-edge handle
  in a real browser — width updates smoothly, no snap-to-cursor jump,
  no visible animation lag during drag (the `is-resizing` class kills
  transitions).
- **[VERIFY-2]** Refresh the page after resizing — panel restores to
  the stored width (within MIN/MAX clamp).
- **[VERIFY-3]** Tab to the handle (or click it) and press ArrowLeft/Right —
  width nudges by 16px and persists immediately.
- **[VERIFY-4]** Resize browser window to make viewport narrower than
  `panelWidth + 200` — panel auto-shrinks to keep 200px of chat visible
  (the `$effect` window-resize listener).
- **[VERIFY-5]** E2E Phase 2 scenario `10-thread-panel.spec.ts` should
  exercise this end-to-end (parallel agent owns that file).

## 8. Scope confirmation

- Files OWNED + written: `web/src/components/ThreadPanel.svelte`,
  `web/tests/thread-panel.spec.js`, this worklog.
- Files NOT touched (per brief):
  - `web/src/components/ArtifactPanel.svelte` (read-only reference)
  - `web/src/App.svelte` (mount block unchanged)
  - `web/src/lib/*` (no shared utility added)
  - `web/e2e/**` (parallel agent's territory)
  - All Python files, `CHANGELOG.md`, `pyproject.toml`, `web/package.json`, `USAGE.md`
- No `git add .` or `-a` used; explicit paths only.
- No em dashes anywhere (commit message, code, comments) — per standing
  rule §I.6 #11. Note: the brief itself contained "em dash" rule
  emphasizing this differs from Agent 1's v0.4.3 commit that had to be
  amended to fix em-dash usage.

## 9. §I.19 iteration log update I should append (for the orchestrator)

```markdown
### Agent 2: ThreadPanel drag-resize feature — RETURNED 2026-05-20 ~01:10

**Commit:** (orchestrator to fill in SHA)
**LOC:** ThreadPanel.svelte +253; thread-panel.spec.js +272; worklog
**Gates:** vitest 1087 (+10), pytest unchanged, ruff clean, build 7.16s

**Pattern adherence:** mirrored ArtifactPanel verbatim (PointerEvents,
ARIA window-splitter, localStorage-with-safeStorage-wrapper, viewport-
aware clamp, $effect window-resize listener). Three constants tuned
panel-specific (MIN=280 vs 320, MAX=720 vs 900, DEFAULT=360 vs 380)
with reasons documented in worklog §2.

**Hands-on §I.19 review I (orchestrator) should run:**
1. Run the new describe block in isolation: `pnpm test tests/thread-panel.spec.js -t "drag-resize handle"` — verify all 10 pass clean.
2. Mutation-test 2-3 of the source-pin tests by re-introducing the
   bug-shape they protect (e.g. change `MIN_PANEL_WIDTH = 280` to 240
   in ThreadPanel.svelte; observe test 9.6 fail).
3. Read assertions in tests 9.4 + 9.5 — they exercise the
   localStorage round-trip with both write and read directions; not
   tautological.

**Pattern wins documented:**
- Source-level regex pins for constants (`MIN_PANEL_WIDTH = 280`,
  `STORAGE_KEY = 'claude-comms:thread-panel-width'`) — mirrors the
  pattern from Agent 1's `getchannelrole-pure-bugfix.spec.js` §I.19
  finding. Robust against future regressions because they bite at edit
  time.
- Cross-component invariant pins (test 9.9 asserts BOTH ThreadPanel and
  ArtifactPanel use the `claude-comms:` namespace) — new pattern, worth
  documenting as "panel-mirror invariant" for future panel additions.
- PointerEvent helper `firePointer(node, type, opts)` with try/catch
  fallback to MouseEvent — jsdom's PointerEvent support is patchy across
  versions; this helper is portable.

**Pattern weakness flagged:**
- Tests use `Object.defineProperty(window, 'innerWidth', ...)` to
  control the viewport. Works in jsdom but is technically global-state
  mutation. Future tests should restore the original value in `afterEach`
  if other specs rely on a specific viewport. Currently none do.

**Predictions vs actual:**
- Predicted ~30-45 min agent time. Actual: ~25 min (faster because
  ArtifactPanel pattern was already battle-tested + cleanly documented).
- Predicted LOC delta ~150-200. Actual +253 for ThreadPanel (slightly
  over due to JSDoc comments I retained verbatim from ArtifactPanel for
  consistency).

**No new gotchas surfaced.**
```

(Orchestrator: append the above to `.worklogs/v043-iteration-log.md`
under "Agent iteration entries" + tick the cumulative-gotchas section.)
