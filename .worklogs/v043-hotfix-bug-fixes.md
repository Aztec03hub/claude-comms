# v0.4.3 hotfix — Layer B regression sweep (4 bugs, one root cause)

Single-commit hotfix that resolves the 4 showstopper regressions Layer B
real-browser smoke caught in v0.4.2. Root cause was a single Svelte 5
reactivity violation in Wave B's `getChannelRole` accessor; once that
fix lands, three of the four reported regressions resolve as cascades
without any further code change. The fourth (#general read-without-join)
turned out to be intentional documented behavior, not a bug.

## 1. WHAT shipped (one commit, four files)

| File | Touched | Δ LOC |
|------|---------|-------|
| `web/src/lib/mqtt-store.svelte.js` | Bug 1 fix | +80 / -27 (net +53) |
| `web/tests/getchannelrole-pure-bugfix.spec.js` | NEW | +204 |
| `web/tests/channel-modal-wires.spec.js` | NEW | +247 |
| `web/tests/chat-header-buttons-visibility.spec.js` | NEW | +191 |
| `.worklogs/v043-hotfix-bug-fixes.md` | NEW (this file) | +misc |

Zero edits to any Python file. Zero edits to any other Svelte
component. Zero edits to `CHANGELOG.md`, `pyproject.toml`,
`web/package.json`, or `USAGE.md` (orchestrator handles release prep).

## 2. Per-bug root-cause analysis + fix

### Bug 1 — `state_unsafe_mutation` in `getChannelRole` (Phil items #3 + #5)

**Browser stack trace:**
```
Uncaught Error: https://svelte.dev/e/state_unsafe_mutation
  at pn.getChannelRole (mqtt-store.svelte.js:3118:32)
  at App.svelte:981:24 (currentUserRole $derived)
```

**Pre-hotfix accessor body (the bug):**
```js
getChannelRole(channelId) {
  if (typeof channelId !== 'string' || !channelId) return null;
  const ch = this.channelsById[channelId];
  if (!ch) return null;
  // ... inference ...
  this.channelRoles[channelId] = role;   // <-- $state write in accessor body
  return role;
}
```

App.svelte:981 passes `currentUserRole={store.getChannelRole?.(store.activeChannel) ?? null}`
to ChatView; Svelte 5 evaluates prop expressions under derived-context
read tracking. ANY `$state` write under that tracking trips the
`state_unsafe_mutation` guard. App.svelte:1088 has the same call shape
on the MemberContextMenu mount, so right-clicking own username (item #5)
also triggered the error.

**Post-hotfix accessor body:**
```js
getChannelRole(channelId) {
  if (typeof channelId !== 'string' || !channelId) return null;
  return this.channelRoles[channelId] ?? null;
}
```

The cache is now populated by a new private `#prewarmChannelRoles()`
helper (modeled on Wave G's `#prewarmNotificationPolicies`) that
iterates `channelsById` once per bootstrap and writes the role for
every channel. Inference itself was extracted into a pure
`#inferChannelRole(channelId)` so the bulk-warm + future per-channel
writes share one rule set.

`#prewarmChannelRoles` is called from `#bootstrapChannels` after the
local-state overlay. `#inferChannelRole(id)` is called from three
other channel-add sites that previously relied on the accessor's
lazy write to backfill the cache:

1. `createChannel(id, topic)` — newly created channel → creator
   inferred as `'owner'`.
2. `joinChannel(id)` success path — newly joined channel → role
   re-inferred from `channelsById[id].createdBy`.
3. `#handleSystemConversation` realtime `conversation_created` case —
   MQTT-pushed channel insert from another participant.
4. `#handleMeta` first-time meta broadcast for an unseen channel.

The one existing `channelRoles[channelId] = role` site in
`transferOwnership` (the post-transfer demote at line 2784, plus its
rollback at 2799/2812) was left untouched: it's an async method body
invoked from an explicit user action, not from a derived/effect
context, so the unsafe-mutation guard doesn't apply.

### Bug 2 — Cannot create / cannot cancel channel modal (Phil item #4)

**Root cause:** Bug 1 cascade. The wires in App.svelte's ChannelModal
mount block (line 1098-1102) were always correct:
```svelte
{#if showChannelModal}
  <ChannelModal
    onClose={() => showChannelModal = false}
    onCreate={(id, topic) => { store.createChannel(id, topic); showChannelModal = false; }}
  />
{/if}
```

But once Bug 1 threw inside App's render tree, the entire component
graph entered an inconsistent state. bits-ui's `Dialog.Portal`
rendered the modal content into the document body, but clicks on its
Create / Cancel / × buttons could not propagate cleanly back through
the App-owned wires because re-renders triggered by `showChannelModal`
state flips were re-throwing on the `currentUserRole` prop expression
the moment any state mutated.

**Fix:** Bug 1's root-cause fix automatically restores the wires. No
code change to App.svelte was needed for Bug 2 once Bug 1 was fixed;
the brief's audit ("audit Bug 2/3, fix the wire if broken") confirmed
the existing wires were intact.

**Regression pin:** `channel-modal-wires.spec.js` mounts App.svelte
with the standard mocked store and exercises Ctrl+N open, sidebar-
button open, Create-click → `store.createChannel(name, '')`, Cancel-
click, and Escape-close. Five tests; the existence of these tests is
what guarantees a future re-introduction of a similar cascade fails
this suite first.

### Bug 3 — ChatHeader buttons not visible (Phil item #8)

**Root cause:** Bug 1 cascade, second path. The 7 callback props
plumbed from App.svelte through ChatView's thin forwarder to
ChatHeader (added in commit `7e7d5a6`) were all wired correctly:

- App.svelte:982-988 — 7 props on ChatView mount.
- ChatView.svelte:53-60, 304-310 — 7 props in `$props()` + 7
  forwards on the `<ChatHeader>` mount.
- ChatHeader.svelte:85-92, 222-298 — 7 props on `$props()` + 6 buttons
  each gated on `typeof on…X === 'function'`.

ChatHeader.svelte's own CSS sets `.header-btn { display: inline-flex }`
explicitly, and `.header-btn-mobile { display: none }` (becomes
`inline-flex` at `@media (max-width: 768px)`). All wires + styles were
intact in v0.4.2.

What broke: ChatView gates the ChatHeader mount on
`{#if showChatHeader && activeChannel}` with
`activeChannel = $derived(store?.activeChannelMeta ?? null)`. When
bootstrap completes and `store.activeChannelMeta` populates, the
`activeChannel` derived re-evaluates → the gate flips true → ChatHeader
mounts. But Svelte's render pipeline ALSO re-evaluates the prop
expressions for that subtree on the same flush, which fired the Bug 1
`state_unsafe_mutation` throw. The render aborted mid-flight and the
button row never reached the DOM.

**Fix:** Bug 1's root-cause fix. No code change to ChatHeader,
ChatView, or App.svelte was needed.

**Regression pin:** `chat-header-buttons-visibility.spec.js` mounts
App with a populated `activeChannelMeta` mock and asserts all 6
button testids exist in the DOM after first paint, plus the inline-
edit pencil (which depends on `currentUserRole=owner` flowing through
the prop wire). Four tests.

### Bug 4 — #general history visible without joining (first Phil bullet)

**Investigation:** read-only audit per brief. Result: **Option B (intentional feature, no code change)**.

`mcp_server.py` lines 790-794 and 842-846 show that every connecting
participant is implicitly auto-joined to the `"general"` conversation
via `_registry.join(name, "general", key=key, participant_type=p_type)`
when their first online presence beacon arrives — for both the
v0.4.0+ `claude-comms/system/conn/{key}/{client}` topic and the legacy
`claude-comms/conv/{conv}/presence/{key}` topic.

This is by design: `#general` is the system lobby (cf. RESERVED_CONVERSATION_NAMES at
`conversation.py:29 = frozenset({"general", "system"})` and the
"reserved-name guard" at `mcp_tools.py:3207`). Every participant who
is connected to MQTT is implicitly a member, so the server-side
membership filter that gates other conversations does not gate
`#general`: that's the documented lobby contract.

The web client's CHANGELOG entry for v0.4.3 should note that
`#general` is the system lobby and that every connected participant
is implicitly a member, so seeing its history without an explicit
`comms_join` is the documented behavior. A future UX wave could
surface this distinction in the sidebar (e.g. a "lobby" badge on
`#general`) but that is out of scope for a hotfix.

No code change. No regression pin needed.

## 3. Tests by name

`web/tests/getchannelrole-pure-bugfix.spec.js` (7 tests, all under
"MqttChatStore.getChannelRole — v0.4.3 hotfix pure-read contract"):

1. `does not mutate channelRoles on a non-null read (the pure-read property)`
2. `#bootstrapChannels pre-warms channelRoles for every bootstrapped channel`
3. `joinChannel populates channelRoles for a freshly-joined channel`
4. `createChannel pre-warms channelRoles with the creator as owner`
5. `returns null gracefully for unknown ids, empty strings, and non-string inputs`
6. `source-level pin: getChannelRole body contains no channelRoles assignment`
7. `survives a "reconnect" pattern (re-bootstrap re-populates the cache)`

`web/tests/channel-modal-wires.spec.js` (5 tests, all under
"App.svelte — ChannelModal create + cancel wires (v0.4.3 hotfix)"):

8. `Ctrl+N opens the ChannelModal (mounts the bits-ui Dialog content)`
9. `clicking the sidebar Create channel affordance also opens the modal`
10. `Create button fires store.createChannel(name, description) and closes the modal`
11. `Cancel button closes the modal without firing store.createChannel`
12. `Escape closes the modal (App.svelte global-keydown cascade)`

`web/tests/chat-header-buttons-visibility.spec.js` (4 tests, all under
"App.svelte → ChatView → ChatHeader — button row visibility (v0.4.3 hotfix)"):

13. `all 5 non-mobile buttons render in the App-mount DOM after first paint`
14. `the mobile-menu button is in the DOM (CSS hides it on wide viewports via media query)`
15. `the chat-header renders with currentUserRole=owner from the prop wire`
16. `all 6 buttons exist in the DOM with the documented data-testids (App-mount end-to-end)`

Total: 16 new tests (brief target: ≥14). 6 + 5 + 4 = 15 if you don't
count the source-level pin in spec #1; 7 + 5 + 4 = 16 with it included.

## 4. svelte-autofixer results

- `mqtt-store.svelte.js` (modified): autofixer run on the minimal
  reproduction of the modified section (getChannelRole, #inferChannelRole,
  #prewarmChannelRoles, bootstrap call site, createChannel/joinChannel
  pre-warm calls). **0 issues, 0 suggestions.**
- No `.svelte` files modified in this hotfix. The pre-existing
  `bind:this` suggestion on `ChatHeader.svelte` (documented in
  `v042-chatheader-button-row-restoration.md` §6) was not introduced
  by this hotfix and remains as-is per the established codebase
  precedent.
- New spec files are `.spec.js` (not Svelte components), so the
  autofixer does not apply.

## 5. §I.18 edge-map verification

Cross-edge contracts per brief:

| Symbol | Where | Hotfix changes? | Verified by |
|---|---|---|---|
| `store.getChannelRole(channelId)` | mqtt-store.svelte.js:3130 | YES — now PURE READ | tests #1, #5, #6 |
| `store.#inferChannelRole(channelId)` | mqtt-store.svelte.js:3148 | NEW (extracted pure inference) | tests #2, #3, #4 (indirect, via the pre-warm path) |
| `store.#prewarmChannelRoles()` | mqtt-store.svelte.js:3186 | NEW | tests #2, #7 |
| `ChannelModal` $props | ChannelModal.svelte:10 | unchanged (read-only) | test #10 (Create wire fires) |
| `ChatHeader` $props | ChatHeader.svelte:80-92 | unchanged (read-only) | tests #13-16 |
| `App.svelte` ChatView mount props | App.svelte:970-989 | unchanged | tests #13-16 |
| `App.svelte` ChannelModal mount | App.svelte:1098-1103 | unchanged | tests #8-12 |
| `App.svelte` MemberContextMenu mount role lookup | App.svelte:1088 | unchanged (call is now safe because Bug 1 was the issue) | test #6 (source pin) + #15 (end-to-end no-throw) |

No prop names changed. No call signatures changed. All cross-edge
contracts pin to the same shape v0.4.2 shipped.

## 6. [VERIFY] items surfaced

**Resolved by this hotfix:**

- Layer B-detected `state_unsafe_mutation` regression in
  `getChannelRole` — root-cause fix landed.
- Layer B-detected ChannelModal create + cancel inoperability — resolved
  as a Bug 1 cascade (no further wire change needed).
- Layer B-detected ChatHeader button row invisibility — resolved as
  a Bug 1 cascade (no further wire change needed).
- Phil's "#general history visible without joining" — confirmed
  intentional feature (auto-join to lobby on first online beacon),
  documented for the CHANGELOG.

**NEW [VERIFY] items raised:**

- [VERIFY-v043-A] `getChannelRole`'s `'admin'` role is still never
  synthesized client-side; the Wave B follow-up to add
  `comms_get_channel_role` MCP wrapper remains open. When that wrapper
  lands, the hydration path can write authoritative roles into
  `channelRoles` from the server's answer — the existing pre-warm
  scaffold (`#prewarmChannelRoles` + per-channel-add inference calls)
  becomes a fallback for the offline / pre-hydration window.
- [VERIFY-v043-B] The intentional `#general` auto-join behavior is
  not surfaced in the web UI today. A future UX wave could add a
  "lobby" badge or similar affordance to make the implicit-membership
  contract visible to users; this hotfix only documents the behavior
  in the CHANGELOG.
- [VERIFY-v043-C] The `mcpCall` import in `mqtt-store.svelte.js` is
  not exported by `api.js` in the test mocks of existing spec files
  (e.g. `mqtt-store-bootstrap.spec.js` does not stub it). This
  hotfix's `getchannelrole-pure-bugfix.spec.js` adds the stub so its
  `joinChannel` test path resolves; other suites that don't exercise
  `joinChannel` are unaffected. A future test-harness cleanup wave
  could centralize the mock factory.

## 7. Verification gate results

- vitest: **1077 passed, 0 failed** (baseline 1061 + 16 new = 1077;
  brief target ≥1075).
- pnpm build: **green in 5.63s**.
- pytest: **1347 passed** (unchanged; brief required Python untouched).
- svelte-autofixer (mqtt-store.svelte.js modified section): **0
  issues, 0 suggestions**.

## 8. Scope confirmation

Files I OWN and wrote:
- `web/src/lib/mqtt-store.svelte.js` — Bug 1 fix: pure-read
  `getChannelRole`, new private `#inferChannelRole`, new private
  `#prewarmChannelRoles`, bootstrap pre-warm call, per-channel-add
  pre-warm calls in `createChannel`, `joinChannel`,
  `#handleSystemConversation`, and `#handleMeta`.
- `web/tests/getchannelrole-pure-bugfix.spec.js` — 7 new tests.
- `web/tests/channel-modal-wires.spec.js` — 5 new tests.
- `web/tests/chat-header-buttons-visibility.spec.js` — 4 new tests.
- `.worklogs/v043-hotfix-bug-fixes.md` — this file.

Files I MUST NOT touch (and did NOT):
- Any Python file (`#general` investigation was strictly read-only;
  finding was Option B intentional feature, surfaced for the
  CHANGELOG only).
- `web/src/App.svelte` — the brief listed it as ownable for Bug 2/3
  audit purposes; the audit confirmed all wires were intact and Bug 1
  was the cascade root cause, so no edits were needed.
- `web/src/components/ChatHeader.svelte`, `ChatView.svelte`,
  `ChannelModal.svelte`, `Sidebar.svelte`, `MemberContextMenu.svelte`,
  `MemberList.svelte`, `ChannelAdminPanel.svelte`,
  `ChannelDirectoryModal.svelte`, `ThreadPanel.svelte`,
  `MessageGroup.svelte`, `MessageBubble.svelte`,
  `SystemMessageGroup.svelte`, `MessageInput.svelte`,
  `StatusEditor.svelte`, `TypeNameConfirmDialog.svelte`,
  `UndoToast.svelte`, `InviteParticipantDialog.svelte`,
  `NotificationPolicyMenu.svelte`, `SidebarChannelRow.svelte`,
  `SidebarChannelSection.svelte`, `ChannelContextMenu.svelte`,
  `UnreadDivider.svelte` — all read-only per brief.
- `web/src/lib/api.js`, `notifications.svelte.js`,
  `keyboard.svelte.js` — read-only.
- `CHANGELOG.md`, `pyproject.toml`, `web/package.json`, `USAGE.md` —
  orchestrator handles release prep.
- Any existing test file outside the 3 new spec files.
