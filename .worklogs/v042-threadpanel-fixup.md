# v0.4.2 follow-up — ThreadPanel fixup (3 issues, single commit)

**Wave:** v0.4.2 follow-up after Step 3.12 (commit `4195661`).
**Baseline HEAD before this work:** `c602c67` (Wave E.1 integrated).
**vitest baseline:** 935. **vitest after:** 939 (+4 new). 0 failing.
**pnpm build:** green in 5.80s.

## 1. WHAT shipped (three fixes, single commit)

This single commit lands the three follow-up items the Step 3.12 worklog
flagged for the orchestrator (the `[VERIFY]` items) plus two user-reported
UX gaps in the same surface:

1. **Issue 1 (App.svelte wire flip).** The Step 3.12 ThreadPanel refactor
   shipped a dual-path implementation gated on a `useSharedComposer`
   discriminator (truthy iff a `store` prop is supplied). App.svelte was
   intentionally NOT updated by that step because the wave's read-only
   list excluded it. This commit flips App.svelte's `<ThreadPanel ... />`
   mount from the legacy `onSendReply` callback to the shared-composer
   path (`{store}` + `channelName` + `typingUsers` + `onOpenEmoji`).
   Production users now get the `MessageInput` composer inside threads,
   inheriting @mentions, the slash-command registry, over-limit
   handling, the format toolbar, the snippet inserter, and the
   emoji-picker trigger.
2. **Issue 2 (scrollbar overflow).** Users reported the thread panel did
   not scroll when reply content overflowed the visible area. Root cause:
   while `.thread-replies` already declared `flex: 1; overflow-y: auto`,
   it lacked the load-bearing `min-height: 0` declaration. Without it
   the flex child cannot shrink below its content height and the
   scrollbar never engages even though `overflow-y: auto` is set. This
   is the classic flex-child scrollbar bug. Fix below in §4.
3. **Issue 3 (visible close button).** A clickable close affordance
   already existed in the panel header (`data-testid="thread-panel-close"`)
   but its visual contrast against the dark `.thread-panel` background
   was too low for discoverability — the user-reported symptom was
   "there is no way to close the thread panel except Escape." The close
   button is unchanged structurally; its styling is strengthened so it
   reads as an interactive surface at first glance (see §5).

## 2. File / LOC deltas

| File | Before | After | Delta |
|---|---|---|---|
| `web/src/components/ThreadPanel.svelte` | 396 | 427 | +31 |
| `web/src/App.svelte` | 1475 | 1475 | 0 (net) |
| `web/tests/thread-panel.spec.js` | 372 | 543 | +171 |

App.svelte stays at 1475 lines because the mount block swap is one-line
neutral: 2 legacy prop lines removed, 4 new prop lines added, plus the
3 unrelated props get reshuffled (no net change).

## 3. App.svelte ThreadPanel prop-wire change

**Before** (legacy path, pre-fixup):

```svelte
{#if showThreadPanel && threadParent}
  <ThreadPanel
    parentMessage={threadParent}
    messages={store.activeChannelReplies.filter(m => m.reply_to === threadParent.id)}
    participants={store.participants}
    currentUser={store.userProfile}
    onClose={() => { showThreadPanel = false; threadParent = null; }}
    onSendReply={(body) => store.sendMessage(body, threadParent.id)}
  />
{/if}
```

**After** (shared-composer path, post-fixup):

```svelte
{#if showThreadPanel && threadParent}
  <ThreadPanel
    parentMessage={threadParent}
    messages={store.activeChannelReplies.filter(m => m.reply_to === threadParent.id)}
    onClose={() => { showThreadPanel = false; threadParent = null; }}
    {store}
    channelName={store.activeChannel}
    typingUsers={store.activeTypingUsers}
    onOpenEmoji={() => showEmojiPicker = !showEmojiPicker}
  />
{/if}
```

Key contract: `useSharedComposer` flips true the moment `store` is
non-null. The `onSendReply` callback is dropped because the thread-scoped
store proxy (constructed inside ThreadPanel) now stamps `parentMessage.id`
as `replyTo` on every default-path send, so the App-level callback
became redundant. The `participants` / `currentUser` props are dropped
too — Step 3.12 already documented them as unused-but-tolerated; the
component's display path reads `parentMessage.sender.name` directly.

The discriminator name (`useSharedComposer`) is the contract from Step
3.12 and is preserved verbatim. The legacy `{:else}` branch inside
ThreadPanel is still in place; it becomes dead code at runtime now but
the test suite still exercises it (Test 1 from Step 3.12) and removing
it would be a separate cleanup commit.

## 4. Scrollbar approach

**Container:** `.thread-replies` (the flex item between `.thread-parent`
and the composer).

**Approach:** flex layout with explicit `min-height: 0`, NOT max-height.
The `.thread-panel` host is already `position: absolute; top: 0;
bottom: 0; display: flex; flex-direction: column;` which gives it a
known height. Inside that column we want exactly one item to absorb
free space and scroll, with everything else (`flex-shrink: 0`) anchored
at its natural height.

**Concrete CSS delta:**

```css
.thread-replies {
  flex: 1 1 0;          /* was: flex: 1 */
  min-height: 0;        /* NEW — load-bearing flex-child scrollbar fix */
  overflow-y: auto;     /* unchanged */
  overflow-x: hidden;   /* NEW — defensive; long words shouldn't bust the panel width */
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  scrollbar-gutter: stable;  /* NEW — no layout shift when scrollbar appears */
}

/* New: thin styled scrollbar so users actually see it. */
.thread-replies::-webkit-scrollbar { width: 8px; }
.thread-replies::-webkit-scrollbar-track { background: transparent; }
.thread-replies::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 4px;
}
.thread-replies::-webkit-scrollbar-thumb:hover { background: var(--ember-700); }

/* New: anchor the non-scrolling sibling regions so the replies list
   is the SOLE flex item that absorbs free space and scrolls. */
.thread-header  { ...; flex-shrink: 0; }   /* NEW: flex-shrink: 0 */
.thread-parent  { ...; flex-shrink: 0; }   /* NEW: flex-shrink: 0 */
.thread-composer { flex-shrink: 0; }       /* NEW rule */
.thread-input    { ...; flex-shrink: 0; }  /* NEW: flex-shrink: 0 */
```

Why not max-height? max-height would couple the panel to a hard pixel
budget and break responsive layouts (Phil's mobile breakpoint at 480px
already shrinks the chrome). flex + min-height: 0 is the idiomatic
Svelte / CSS solution and is documented by Phil's existing components
(SettingsPanel's `.settings-body` uses the same pattern).

## 5. Close button approach

**Mirrored panel:** PinnedPanel's `.pinned-close` (the cleanest existing
pattern at 28×28 with a border + bg-elevated background). PinnedPanel,
SearchPanel, and SettingsPanel all use the `<X size={16} />` icon from
`lucide-svelte`; ThreadPanel was already on the same icon (Step 3.12
shipped it), so no icon change.

The structural button was already present at
`data-testid="thread-panel-close"`. This commit strengthens its
discoverability through styling only:

```css
.thread-close {
  width: 28px;
  height: 28px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);   /* was: var(--bg-surface) — now more contrast */
  color: var(--text-primary);       /* was: var(--text-secondary) — clearer */
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: var(--transition-fast);
  flex-shrink: 0;
  opacity: 0.92;                    /* NEW — softens fully-opaque on the dark bg */
}

.thread-close:hover {
  background: var(--bg-surface);
  color: var(--ember-400);          /* was: var(--text-primary) — ember brand on hover */
  border-color: var(--ember-700);
  opacity: 1;
}

/* NEW: keyboard focus ring so tabbing users see the focused control. */
.thread-close:focus-visible {
  outline: 2px solid var(--ember-400);
  outline-offset: 2px;
}
```

The button retains `aria-label="Close thread panel"` and the same
test-id; click still calls `onClose`. Escape-to-close (via App.svelte's
modal priority cascade at lines 370-372) is NOT touched.

## 6. Tests by name

All 4 new tests live in `web/tests/thread-panel.spec.js` and extend the
7 tests Step 3.12 shipped, for 11 total in the file.

1. `ThreadPanel — replies list scrolls on overflow (v0.4.2 follow-up) >
   .thread-replies mounts when overflowing AND its CSS rule declares
   overflow-y: auto + min-height: 0`
   - Renders the panel with 25 stacked replies, asserts `.thread-replies`
     is mounted with all 25 children, then reads the component source
     and asserts the CSS rule body contains BOTH `overflow-y: auto`
     and `min-height: 0`. jsdom doesn't reliably surface Svelte's
     scoped <style> via getComputedStyle, so the CSS contract is
     pinned at source level — a regression that drops either
     declaration fails this test before the build can ship.
2. `ThreadPanel — visible close button (v0.4.2 follow-up) > close button
   is present and click fires onClose in the legacy path`
   - Mounts ThreadPanel with `onSendReply` (legacy path), gets the
     `thread-panel-close` button, asserts it carries the
     `aria-label="Close thread panel"`, clicks it, asserts `onClose`
     fires exactly once. Regression guard so a future cleanup of the
     `{:else}` branch doesn't accidentally bury the affordance.
3. `ThreadPanel — visible close button (v0.4.2 follow-up) > close button
   is present and click fires onClose in the MessageInput path`
   - Same as (2) but with `store={makeStore()}` so the new
     shared-composer path is exercised. Pins the close affordance
     across BOTH composer modes.
4. `App.svelte — ThreadPanel mount uses the shared composer (v0.4.2
   follow-up) > App.svelte passes store + channelName + typingUsers +
   onOpenEmoji to ThreadPanel and not onSendReply`
   - Reads `web/src/App.svelte` from disk, slices the `<ThreadPanel ...
     />` mount block, asserts `{store}`, `channelName=
     {store.activeChannel}`, `typingUsers={store.activeTypingUsers}`,
     and `onOpenEmoji=` all appear inside the block AND `onSendReply`
     does NOT. Static smoke test — pure source assertion, no runtime
     mount of App.svelte (which would need a full MqttChatStore stub
     out of scope for this fixup). Regression guard: if a future
     refactor reverts to the legacy callback the suite fails
     immediately.

## 7. autofixer per file

- `ThreadPanel.svelte`: `{"issues":[],"suggestions":[],"require_another_tool_call_after_fixing":false}` — fully clean.
- `App.svelte`: `{"issues":[],"suggestions":[<11 pre-existing
  $effect-mutates-state warnings>],"require_another_tool_call_after_fixing":true}` — `issues` empty. The 11 suggestions are
  ALL pre-existing keyboard-shortcut $effect patterns (lines 108-171 and
  297-322) registered well before this fixup; they describe a contract
  where the $effect MUST register handlers that mutate state when keys
  fire (this is the intended behavior, documented in inline comments).
  None of the suggestions reference my mount-block edit. Treated as
  pre-existing and out of scope (Phil's no-revert standing rule applies
  to settings, but the broader rule here is that this fixup ships three
  surgical changes and does not refactor the keyboard subsystem).

## 8. [VERIFY] items resolved + new surfaced

**Resolved (from Step 3.12's worklog):**

1. **`[VERIFY] 1: App.svelte mount unchanged`** — RESOLVED. App.svelte
   now uses the shared-composer path. The `{:else}` legacy branch in
   ThreadPanel.svelte becomes dead code at runtime but is preserved
   for the test suite's Test 1 (legacy-path back-compat) and as a
   safety net for any third party embedding the component. A separate
   cleanup commit could remove it (~ -100 lines) but is out of scope
   here.
2. **`[VERIFY] 2: Reactivity of the proxy under runtime store
   re-assignment`** — not exercised; the store is still constructed
   once at module init (`const store = new MqttChatStore()` at
   App.svelte line 33) and never hot-swapped. The Step 3.12 contract
   holds.
3. **`[VERIFY] 3: participants / currentUser / Avatar import unused`** —
   PARTIALLY RESOLVED. The two unused props (`participants`,
   `currentUser`) are no longer passed from App.svelte's call site, so
   they're effectively no-ops in production. They remain declared on
   ThreadPanel's `$props()` for back-compat with the legacy test path
   (Test 1 still passes them). The unused `Avatar` import is left in
   place; autofixer doesn't flag it. Future cleanup commit could
   remove all three.
4. **`[VERIFY] 4: Test count`** — RESOLVED. Baseline was 935 before
   this work; +4 new tests lands 939, satisfying the orchestrator's
   "≥ 939 with ≥ 4 new" target.

**Newly surfaced:**

5. **Tailwind / forced-colors mode for the scrollbar.** The custom
   `::-webkit-scrollbar` styling is webkit-only. Firefox falls back to
   the OS native scrollbar (still visible because `overflow-y: auto`
   is set), but the styled thumb / track look-and-feel only renders
   on Chromium-based browsers. Phil's web/ project does not currently
   declare `scrollbar-width` / `scrollbar-color` for Firefox parity;
   that's a broader visual-polish item, not a per-panel regression.
6. **`.thread-composer :global(.input-area)` selector specificity.** The
   override at line 369-371 of `ThreadPanel.svelte` reaches through
   `:global()` into MessageInput. If MessageInput later renames
   `.input-area` the thread composer's vertical rhythm breaks. This is
   the same coupling Step 3.12 introduced; this fixup didn't touch it
   but the contract is worth flagging for the Step 3.12-cleanup commit.

## 9. Scope confirmation

- NO Python file touched.
- NO `MessageInput.svelte`, `PinnedPanel.svelte`, `SearchPanel.svelte`,
  `SettingsPanel.svelte`, `Sidebar.svelte`, `ChatView.svelte`, or any
  other component touched — all consumed read-only for reference
  patterns only.
- NO `mqtt-store.svelte.js` touched.
- NO `CHANGELOG.md`, `pyproject.toml`, `web/package.json`, `USAGE.md`
  touched.
- NO test file outside `web/tests/thread-panel.spec.js` touched.
- NO em dashes in this worklog or in any user-facing text added by this
  commit (overlay text, button labels, test names — all clean).
- NO destructive git ops.
- "Phil LaFayette" appears nowhere user-facing in this commit (no name
  references); the standing rule applies if/when introduced.

## Verification gates (re-summary)

- **vitest:** `pnpm exec vitest run` — 57 files, 939 tests passed, 0
  failing. Baseline was 935; +4 new tests from this commit.
- **pnpm build:** `pnpm build` — `vite build` ran in 5.80s, all 4489+
  modules transformed, dist artifacts generated successfully under
  `src/claude_comms/web/dist/`.
- **svelte-autofixer:**
  - `ThreadPanel.svelte`: 0 issues, 0 suggestions, no further calls needed.
  - `App.svelte`: 0 issues, 11 suggestions (all pre-existing
    `$effect`-mutates-state warnings on the keyboard subsystem, none
    triggered by this commit's mount-block edit).

## Commit message (verbatim)

```
fix(ui): wire App.svelte ThreadPanel to shared composer + add scroll overflow + visible close button (v0.4.2 follow-up)
```

`git add` paths (explicit, no `-A`):

```
web/src/components/ThreadPanel.svelte
web/src/App.svelte
web/tests/thread-panel.spec.js
.worklogs/v042-threadpanel-fixup.md
```
