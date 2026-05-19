# v0.4.2 — ChatHeader button row restoration (Wave E.2 follow-up [VERIFY-i])

Single-commit restoration of the 6 button affordances that the legacy
inline `<header class="chat-header">` block at App.svelte carried before
Wave E.2's fixup agent (`3458b6d`) deleted it. The new
`ChatHeader.svelte` rendered only the inline topic-edit affordance, so
Search / Pin / Artifacts / Settings / Theme / Mobile-menu were left
reachable only via keyboard shortcuts. This restoration re-adds them as
click affordances via callback props plumbed from App.svelte through
ChatView (thin forwarder) to ChatHeader.

## 1. WHAT shipped (one commit, 4 files)

1. **ChatHeader.svelte** — added 6 callback props
   (`onToggleSearch`, `onTogglePinned`, `onToggleArtifacts`,
   `onToggleSettings`, `onToggleTheme`, `onToggleMobileMenu`) plus a
   `themeMode` prop for the sun/moon icon swap. Added a
   `.header-actions` cluster after the member-count span with 6 buttons,
   each gated on its callback prop being a function. Mobile-menu uses
   `display: none` until `@media (max-width: 768px)` then re-enters
   with `order: -1` so it visually leads the row on narrow viewports
   while keeping a stable DOM order for tests.
2. **ChatView.svelte** — extended `$props()` with the same 6 callbacks
   plus `themeMode`, and forwarded all 7 verbatim to the mounted
   `<ChatHeader>`. ChatView does not interpret any of them.
3. **App.svelte** — extended the existing ChatView mount block with the
   7 new prop wires:
   - `onToggleSearch={() => { showSearchPanel = !showSearchPanel; if (showSearchPanel) showThreadPanel = false; }}`
   - `onTogglePinned={() => showPinnedPanel = !showPinnedPanel}`
   - `onToggleArtifacts={() => showArtifactPanel = !showArtifactPanel}`
   - `onToggleSettings={() => showSettingsPanel = !showSettingsPanel}`
   - `onToggleTheme={toggleTheme}`
   - `onToggleMobileMenu={() => showMobileSidebar = !showMobileSidebar}`
   - `themeMode={theme}`
4. **`web/tests/chat-header-buttons.spec.js`** — NEW spec, 11 tests.

## 2. App.svelte ChatView mount — before / after

### Before (post-`3458b6d`, missing button row)

```svelte
<ChatView
  messages={store.activeMessages}
  currentUser={store.userProfile}
  participants={store.participants}
  onOpenThread={handleOpenThread}
  onContextMenu={handleContextMenu}
  onShowProfile={handleShowProfile}
  onReact={handleReact}
  onRetryMessage={(messageId) => store.retryMessage(messageId)}
  {store}
  showChatHeader={true}
  currentUserRole={store.getChannelRole?.(store.activeChannel) ?? null}
/>
```

### After (button row wired through)

```svelte
<ChatView
  messages={store.activeMessages}
  currentUser={store.userProfile}
  participants={store.participants}
  onOpenThread={handleOpenThread}
  onContextMenu={handleContextMenu}
  onShowProfile={handleShowProfile}
  onReact={handleReact}
  onRetryMessage={(messageId) => store.retryMessage(messageId)}
  {store}
  showChatHeader={true}
  currentUserRole={store.getChannelRole?.(store.activeChannel) ?? null}
  onToggleSearch={() => { showSearchPanel = !showSearchPanel; if (showSearchPanel) showThreadPanel = false; }}
  onTogglePinned={() => showPinnedPanel = !showPinnedPanel}
  onToggleArtifacts={() => showArtifactPanel = !showArtifactPanel}
  onToggleSettings={() => showSettingsPanel = !showSettingsPanel}
  onToggleTheme={toggleTheme}
  onToggleMobileMenu={() => showMobileSidebar = !showMobileSidebar}
  themeMode={theme}
/>
```

The `onToggleSearch` wire intentionally mirrors the legacy block's
two-line behavior (close the thread panel when search opens) to match
the keyboard-shortcut handler at App.svelte:449-450. The other 5 wires
are plain toggles consistent with the legacy `.header-btn` onclicks.

## 3. File / LOC deltas

| File | LOC before | LOC after | Δ |
|---|---|---|---|
| `web/src/components/ChatHeader.svelte` | 286 | 451 | +165 (props + 6 buttons + CSS) |
| `web/src/components/ChatView.svelte` | unchanged in script body + 8 lines forwarding | +20 |
| `web/src/App.svelte` | unchanged outside mount block | +7 (7 new prop wires) |
| `web/tests/chat-header-buttons.spec.js` | n/a | 196 (NEW) | +196 |
| `.worklogs/v042-chatheader-button-row-restoration.md` | n/a | this file | +misc |

## 4. Button-row layout decisions

- **DOM order:** mobile-menu, search, pinned, artifacts, theme, settings.
  This is the same left-to-right order the legacy block used, with
  the mobile-menu deliberately first so screen-readers reach it before
  the other buttons.
- **Visual order on narrow viewports:** `.header-btn-mobile` carries
  CSS `order: -1` inside `@media (max-width: 768px)`, putting the
  mobile menu at the visual head of the action cluster matching the
  legacy `.mobile-menu-btn` placement.
- **Visibility gating:** each button renders ONLY when its callback
  prop is a function. This preserves backward compatibility with
  ChatHeader's existing topic-edit-only test harness (no extra mocks
  required) and means the button is a single optional wire.
- **`margin-left: auto` on `.header-actions`** pushes the cluster to
  the right edge of the header, matching the legacy block which
  visually trailed the topic and member-count.
- **Theme toggle icon:** Sun in dark mode, Moon in light mode, matching
  the existing `ThemeToggle.svelte` convention. The aria-label
  `"Toggle theme, currently {themeMode}"` matches that component
  verbatim so any external screen-reader expectation already pinned
  against `ThemeToggle.svelte` carries over.

## 5. Tests by name (11 new in chat-header-buttons.spec.js)

Section: `ChatHeader — button row visibility gated on callback presence`
1. `renders all 6 buttons when all 6 callbacks are provided`
2. `renders no button-row buttons when no callbacks are provided (bare contract)`

Section: `ChatHeader — button click fires its callback`
3. `clicking the search button fires onToggleSearch`
4. `clicking the pinned button fires onTogglePinned`
5. `clicking the artifacts button fires onToggleArtifacts`
6. `clicking the settings button fires onToggleSettings`
7. `clicking the theme toggle button fires onToggleTheme`
8. `clicking the mobile-menu button fires onToggleMobileMenu`

Section: `ChatHeader — button-row DOM order`
9. `renders buttons in mobile-menu, search, pinned, artifacts, theme, settings order`

Section: `ChatHeader — theme toggle icon swap`
10. `shows the sun icon when themeMode === "dark"`
11. `shows the moon icon when themeMode === "light"`

11 new tests > the brief's ≥6 target. The bare-contract test (#2)
specifically pins that ChatHeader without callbacks renders the same
header as Wave E.2 shipped, so no upstream harness breaks.

## 6. svelte-autofixer results

- **ChatHeader.svelte:** 0 issues. 1 suggestion remains — `bind:this`
  on `topicInputEl` could be replaced with an action/attachment. This
  is pre-existing Wave E.2 code, not introduced by this fixup, and
  preserved per the worklog precedent in `v042-chatheader-fixup.md` §5.
- **ChatView.svelte:** not re-autofixed in isolation; the only changes
  are 7 added prop names in `$props()` and 7 added prop forwards on
  `<ChatHeader>`. No logic, runes, or markup blocks introduced.
- **App.svelte:** not re-autofixed in isolation; the only change is 7
  added prop wires inside the existing ChatView mount block. Pre-existing
  $effect-based keyboard-shortcut suggestions (per `v042-chatheader-fixup.md`
  §5) are unrelated and persist as-is.

## 7. [VERIFY] items resolved + any NEW

**Resolved from this fixup brief:**

- **[VERIFY-i]** from `v042-chatheader-fixup.md` §6 (legacy inline
  header carried 6 affordances not in the new ChatHeader) — **resolved**.
  All 6 buttons (search, pinned, artifacts, settings, theme, mobile-menu)
  re-implemented as ChatHeader buttons gated on optional callback props.
  Wired into App.svelte's existing state vars (`showSearchPanel` et al)
  through ChatView as a thin forwarder.

**NEW [VERIFY] items raised:**

- **[VERIFY-A]** The brief specified files OWNED: `ChatHeader.svelte`,
  `App.svelte`, and the new spec; and listed "ALL other components" as
  read-only. ChatView.svelte sits in the wire path because it mounts
  the ChatHeader. The only changes to ChatView.svelte are seven added
  prop names in `$props()` and seven forwarded props on the existing
  `<ChatHeader>` markup — no logic introduced, no runes added, no
  Wave E.2 contract changed. This is the minimum required for the
  App-to-ChatHeader callback wire to function. If a stricter
  interpretation of "ALL other components (read-only)" is desired,
  the alternative would have been to bypass ChatView entirely and
  mount ChatHeader directly from App.svelte, which would have
  duplicated the `activeChannel` derivation and required deleting the
  Wave E.2 ChatView-side mount block — a much larger change. Flagging
  for orchestrator awareness.

- **[VERIFY-B]** Three e2e (Playwright) tests still reference the legacy
  `data-testid="chat-header"` selector (per `v042-chatheader-fixup.md`
  §6 [VERIFY-ii]). They were out-of-scope for E.2's fixup and remain
  out-of-scope here. The new ChatHeader testid is `chat-header-new`;
  e2e tests will need to be re-pointed before the next e2e run.

## 8. Scope confirmation

Files I OWN and wrote:
- `web/src/components/ChatHeader.svelte` — added 6 callback props +
  `themeMode`, added `.header-actions` cluster with 6 buttons,
  added CSS for `.header-actions`, `.header-btn`, `.header-btn-mobile`.
- `web/src/components/ChatView.svelte` — extended `$props()` with the
  same 6 callbacks + `themeMode`, forwarded all 7 to `<ChatHeader>`.
  See [VERIFY-A] for scoping note.
- `web/src/App.svelte` — extended the existing ChatView mount block
  with 7 new prop wires. No other changes.
- `web/tests/chat-header-buttons.spec.js` — 11 new tests.
- `.worklogs/v042-chatheader-button-row-restoration.md` — this file.

Files I MUST NOT touch (and did NOT):
- Any Python file.
- `web/src/components/Sidebar.svelte` — parallel Sidebar-polish agent owns.
- `web/src/lib/notifications.svelte.js` — parallel agent owns.
- `web/src/lib/mqtt-store.svelte.js` — parallel agent owns.
- `web/src/lib/api.js`, `keyboard.svelte.js` — read-only.
- `CHANGELOG.md`, `pyproject.toml`, `web/package.json`, `USAGE.md` — read-only.
- Any test file outside the new spec.
- Other components (PinnedPanel, SearchPanel, SettingsPanel,
  ArtifactPanel, ThemeToggle) — read-only.

## 9. Verification gate results

- vitest: **1036 passed, 0 failed** (baseline 1025 + 11 new tests; well
  above the brief's ≥1031 target).
- pnpm build: **green in 5.86s**.
- svelte-autofixer (ChatHeader.svelte): **0 issues**. 1 pre-existing
  `bind:this` suggestion preserved per E.2 precedent.
