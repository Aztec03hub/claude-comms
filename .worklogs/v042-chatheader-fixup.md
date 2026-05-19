# v0.4.2 — ChatHeader / inline header fixup (Wave E.2 follow-up)

Single-commit fixup that completes the dual-path landing from Wave E.2
(`3be7e3b`). E.2 shipped `ChatHeader.svelte` + `UnreadDivider.svelte` as
DUAL-PATH: `ChatView` only mounts `ChatHeader` when `showChatHeader={true}`
is passed in (default `false`), and `App.svelte` kept rendering its
inline `<header class="chat-header">` block. This fixup flips the gate on
in App.svelte's `ChatView` mount AND deletes the now-duplicate inline
header markup, mirroring the prior ThreadPanel fixup pattern (`d9ebbbd`).

## 1. WHAT shipped (3 changes in one commit)

1. **App.svelte ChatView mount** — added two new props in the existing
   ChatView mount block:
   - `showChatHeader={true}` (flips Wave E.2's dual-path discriminator on)
   - `currentUserRole={store.getChannelRole?.(store.activeChannel) ?? null}`
     (consumes Wave B's client-side role inference via the existing
     `getChannelRole(channelId)` accessor on `MqttChatStore`)
2. **App.svelte legacy inline header deleted** — removed the
   `<header class="chat-header" data-testid="chat-header">...</header>`
   block (formerly ~27 lines) plus its now-orphaned imports
   (`Users`, `Search`, `Pin`, `Settings`, `Menu`, `FileText` from
   `lucide-svelte` + `ThemeToggle` component import) and ~110 lines of
   orphaned scoped CSS (`.chat-header`, `.chat-header::after`,
   `.header-icon`, `.header-name`, `.header-sep`, `.header-topic`,
   `.header-members{,:hover,:global(svg)}`, `.header-actions`,
   `.header-btn{,:hover}`, `.mobile-menu-btn{,:hover}`, plus the
   `@media (max-width: 480px)` overrides for those classes).
3. **`web/tests/chat-header-topic-edit.spec.js`** — appended four
   App-level integration tests that mount `App.svelte` with a mocked
   `MqttChatStore` and pin: owner-sees-pencil, member-no-pencil,
   `getChannelRole` is called with the active channel id, and the
   legacy inline header markup is no longer in the DOM.

## 2. Before / after — App.svelte mount block

### Before (Wave E.2 — inline header + un-flipped ChatView)

```svelte
    <header class="chat-header" data-testid="chat-header">
      <button class="mobile-menu-btn" ... onclick={() => showMobileSidebar = !showMobileSidebar} ...>
        <Menu size={20} strokeWidth={2} />
      </button>
      <div class="header-icon">#</div>
      <span class="header-name" data-testid="header-channel-name">{store.activeChannel}</span>
      <span class="header-sep"></span>
      <span class="header-topic">{store.activeChannelMeta?.topic || ''}</span>
      <button class="header-members" ... onclick={() => showMemberList = !showMemberList}>
        <Users size={12} strokeWidth={2} />
        {store.onlineCount + store.offlineParticipants.length}
      </button>
      <div class="header-actions">
        <button class="header-btn" ... onclick={() => { showSearchPanel = !showSearchPanel; showThreadPanel = false; }} ...>
          <Search size={16} strokeWidth={2} />
        </button>
        <button class="header-btn" ... onclick={() => showPinnedPanel = !showPinnedPanel} ...>
          <Pin size={16} strokeWidth={2} />
        </button>
        <button class="header-btn" ... onclick={() => showArtifactPanel = !showArtifactPanel} ...>
          <FileText size={16} strokeWidth={2} />
        </button>
        <ThemeToggle mode={theme} onToggle={toggleTheme} />
        <button class="header-btn" ... onclick={() => showSettingsPanel = !showSettingsPanel} ...>
          <Settings size={16} strokeWidth={2} />
        </button>
      </div>
    </header>

    {#if showPinnedPanel}
      <PinnedPanel ... />
    {/if}

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
    />
```

### After (legacy header gone, ChatView wired)

```svelte
    {#if showPinnedPanel}
      <PinnedPanel ... />
    {/if}

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

## 3. Exact ChatHeader / ChatView prop names verified

Source: `.worklogs/v042-3.2-and-3.7-chatheader-and-unread-divider.md`
§3, §8, and ChatView.svelte:47-49 read directly.

| Prop on ChatView          | Default | Forwarded to ChatHeader as |
|---------------------------|---------|----------------------------|
| `showChatHeader`          | `false` | (gate; mounts ChatHeader)  |
| `currentUserRole`         | `null`  | `currentUserRole`          |
| `onTopicEditError`        | undefined | `onEditTopicError`       |

The brief proposed `currentUserRole={store.getChannelRole(activeChannel?.id)}`
but `store.activeChannel` is a STRING channel id (`activeChannel = $state('general')`
at mqtt-store.svelte.js:129), not an object — so the actual call is
`store.getChannelRole(store.activeChannel)`. The `?.()` guard exists so the
two pre-existing App-mounting tests (`prop-drilling.spec.js`,
`toast-improvements.spec.js`), whose mocked store does not expose
`getChannelRole`, do not throw.

The brief also called out `[VERIFY-A]` from Wave E.2's worklog claiming
`store.getChannelRole` did not exist. **It DOES exist now** — Wave B
landed it as a client-side inference accessor at
`mqtt-store.svelte.js:2745` (returns `'owner' | 'member' | null`; never
synthesizes `'admin'` client-side). Wired straightforwardly.

## 4. Tests by name (4 new, all in chat-header-topic-edit.spec.js)

Section header: `App.svelte — ChatHeader wire (v0.4.2 Wave E.2 follow-up)`

1. `owner sees the ChatHeader inline-edit pencil after the App.svelte wire flip`
2. `member does NOT see the ChatHeader inline-edit pencil`
3. `App.svelte calls store.getChannelRole with the active channel id`
4. `legacy inline <header class="chat-header"> markup is gone from the App DOM`

The suite now totals 16 tests (12 existing + 4 new). Vitest delta:
967 -> 971. Pattern mirrors `prop-drilling.spec.js`'s App-mount approach
(vi.mock of `mqtt-store.svelte.js` + `notifications.svelte.js`, plus
JSDOM shims for `IntersectionObserver` / `ResizeObserver` / `Notification`
/ rAF). Each test pins a `globalThis.__chatHeaderAppRoleOverride`
before rendering so the mocked store's `getChannelRole` returns the
desired role, and a registry on `globalThis.__chatHeaderAppStoreInstances`
captures the App-constructed store so spies can be asserted on.

## 5. svelte-autofixer

`App.svelte` (minimal reproduction of touched regions): 0 issues. 3
suggestions remain, all on pre-existing $effect-based keyboard-shortcut
registration code (unchanged by this fixup) — not introduced by the edit.
Preserved as-is per the autofixer's "ignore if not assigning state"
guidance and per the broader codebase convention of effect-based
registry teardown.

## 6. [VERIFY] items resolved + any NEW

**Resolved from this fixup brief:**

- [VERIFY] (brief Issue 2) — legacy inline header at App.svelte lines
  607-634: lines drifted to 729-756 because of later Wave E inserts, but
  the same block. Deleted in full. Confirmed gone via test #4 above.
- [VERIFY] (brief Issue 1, prop names) — `showChatHeader` and
  `currentUserRole` confirmed verbatim from
  `.worklogs/v042-3.2-and-3.7-chatheader-and-unread-divider.md` and
  ChatView.svelte's `$props` block. Brief was correct; no rename needed.
- [VERIFY] (brief Issue 1, accessor name) — brief said
  `store.getChannelRole(activeChannel?.id)`. Actual accessor signature is
  `getChannelRole(channelId: string)` and `store.activeChannel` is the
  string id itself. Wired as `store.getChannelRole?.(store.activeChannel)`.
  The `?.()` defensive call is necessary so the two pre-existing
  App-mounting suites (`prop-drilling.spec.js`, `toast-improvements.spec.js`)
  whose store mocks predate Wave B's accessor do not throw at render —
  brief forbids modifying those test files.
- [VERIFY-A] from Wave E.2 worklog (claimed `getChannelRole` did not
  exist) — **superseded**. Wave B added the accessor. ChatHeader's
  `currentUserRole` is now hydrated end-to-end from App through ChatView
  to ChatHeader.
- [VERIFY-G] from Wave E.2 worklog (inline header duplication after
  flipping `showChatHeader={true}`) — **resolved** here. Inline header
  block + orphan imports + orphan CSS all removed.

**NEW [VERIFY] items raised:**

- [VERIFY-i] The legacy inline header carried several toggles not
  present in the new `ChatHeader.svelte`: mobile-menu button, search /
  pin / artifacts / settings buttons in the right-side `.header-actions`
  cluster, the ThemeToggle, and the member-list popover toggle. All of
  those panels remain reachable via keyboard shortcuts (`Ctrl+K` for
  search, `Ctrl+L` for the channel directory, etc.), the Sidebar's
  `onOpenSettings` hook, and the existing keybindings registry — but
  there is no longer a button-row affordance in the chat-area header for
  pinning / artifacts / search / settings / theme toggling. If this
  affects the UX target for v0.4.2, those affordances will need to be
  re-added to ChatHeader.svelte or surfaced elsewhere; this fixup
  intentionally matches the brief's "delete the inline markup"
  instruction without re-implementing the toggles.
- [VERIFY-ii] Three e2e (Playwright) tests still reference the legacy
  `data-testid="chat-header"` selector
  (`web/e2e/round9-visual.spec.js`, `web/e2e/app-loads.spec.js`,
  `web/e2e/overnight-members-theme.spec.js`,
  `web/e2e/theme-responsive.spec.js`, `web/e2e/panels.spec.js`). These
  are not part of the vitest baseline this fixup verifies; they will
  need to be re-pointed at `chat-header-new` before the next e2e run.
  Out of scope per brief (test files not owned by this fixup).
- [VERIFY-iii] Two pre-existing vitest test files have store mocks
  predating Wave B's `getChannelRole`. The `?.()` defensive call on
  App.svelte's wire keeps them passing without modification; if those
  mocks are updated later to add `getChannelRole`, the `?.()` can be
  tightened to a direct call.

## 7. Scope confirmation

Files I OWN and wrote:
- `web/src/App.svelte` — flipped ChatView mount props (showChatHeader=true,
  currentUserRole wired via store.getChannelRole), deleted legacy inline
  `<header class="chat-header">` markup, removed orphan imports
  (`ThemeToggle`, lucide icons), removed orphan scoped CSS.
- `web/tests/chat-header-topic-edit.spec.js` — appended 4 App-level
  integration tests (section: "App.svelte — ChatHeader wire (v0.4.2
  Wave E.2 follow-up)").
- `.worklogs/v042-chatheader-fixup.md` — this file.

Files I MUST NOT touch (and did NOT):
- Any Python file.
- `web/src/components/ChatHeader.svelte`, `UnreadDivider.svelte`,
  `ChatView.svelte` — read-only; Wave E.2 just landed them.
- `web/src/lib/mqtt-store.svelte.js` — read-only.
- Any other component or test file beyond
  `chat-header-topic-edit.spec.js`.
- `CHANGELOG.md`, `pyproject.toml`, `web/package.json`, `USAGE.md`.

## 8. Verification gate results

- vitest: **971 passed, 0 failed** (baseline 967 + 4 new App-level tests)
- pnpm build: **green in 5.68s**
- svelte-autofixer: **0 issues** on App.svelte (3 suggestions remain, all
  on pre-existing $effect-based keyboard-shortcut code — not introduced
  by this fixup)
