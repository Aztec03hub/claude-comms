# Svelte v0.3.2 pre-tag review

Reviewer: svelte-file-editor agent
Date: 2026-05-12
Scope: MemberList.svelte rewrite, App.svelte wiring, mqtt-store.svelte.js v0.3.2 deltas (channelMembers, activeMembers / onlineElsewhere derivations, getMemberConversations, #handlePresence conversation arg, #handleSystemConversation).

---

## 1. Verdict

**Yellow-light** — ship after addressing two should-fix items (filter null-safety + snapshot diff missing channelMembers fingerprint). Everything else is clean or deferrable.

---

## 2. Issues found

### `[should-fix]` `MemberList.svelte` filter callbacks crash on participants with undefined `name`

Lines 113–128. The three `$derived` filters dereference `m.name.toLowerCase()` without guard:

```js
active.filter((m) => m.name.toLowerCase().includes(searchQuery.toLowerCase()))
```

`name` is sourced from raw MQTT presence `msg.name` (mqtt-store.svelte.js:1586, :1656, :1680) — the broker can deliver a presence frame with `name: undefined` or `name: ""` (e.g. a malformed agent, an early frame before identity is set). The store's `activeMembers` / `onlineElsewhere` derivations already defend against this in their `.sort((a, b) => (a.name || '').localeCompare(b.name || ''))`. The filter doesn't.

Bug only manifests when (a) at least one such participant exists AND (b) the user opens the search bar. In that path, `TypeError: Cannot read properties of undefined (reading 'toLowerCase')` throws inside the derived, which Svelte will surface as an unhandled error and the panel goes blank.

**Recommendation** — change three sites:

```js
active.filter((m) => (m.name || '').toLowerCase().includes(searchQuery.toLowerCase()))
```

Same edit for `filteredOnlineElsewhere` and `filteredOffline`. 3 lines, 3 occurrences of `m.name.toLowerCase()` and one `m.name` in offline — all need the `|| ''` guard.

### `[should-fix]` `App.svelte` 500ms snapshot diff misses activity-shape and channelMembers churn

Lines 77–95. The fingerprint compares only `length` + flat list of connection keys per member:

```js
JSON.stringify(newActive.map((p) => Object.keys(p.connections || {})).flat())
```

Two real cases this misses:

1. **`getMemberConversations(key)` result changes without section change.** A participant in `onlineElsewhere` who is currently in #A joins #B. `channelMembers` mutates, but the participant's `connections` keys and section assignment don't change. The "in #X +N more" chip is stale — still says "in #A" until the next length-changing event flips the snapshot.

2. **Activity label changes do still render** because `getActivity(member)` reads `member.connections[k].activity.label` directly from the live deep-proxy (the snapshot array holds references to the same proxy objects, not snapshots). So that one's actually fine.

The chip staleness is the user-visible defect.

**Recommendation (preferred)** — drop the snapshot indirection entirely and bind `<MemberList active={store.activeMembers} ... />` directly. The store's three derivations are already `$derived.by()` — they push updates correctly and Svelte coalesces. The autofixer flagged `activeMembers`/`onlineElsewhereMembers`/`offlineMembers` as exactly the "assigning state inside $effect — use $derived instead" anti-pattern.

If that feels too invasive for a release-hour change, the minimal patch is: extend the fingerprint to include `store.channelMembers` mutation counter, e.g. `JSON.stringify(Object.keys(store.channelMembers[store.activeChannel] || {}))`. But the architectural fix is dropping the poll.

### `[nice-to-have]` Collapse button missing `aria-controls`

`MemberList.svelte:259`. The chevron button has `aria-expanded` but no `aria-controls`. Because the list is removed from DOM rather than `display: none`-hidden, the screen-reader UX is acceptable: SR announces "Offline (5), collapsed, button" which is fully navigable. WCAG doesn't strictly require `aria-controls` when the controlled content isn't in the accessibility tree. But it's a minor improvement:

```svelte
<button ... aria-expanded={offlineExpanded} aria-controls="member-list-offline">
  ...
</button>
{#if offlineExpanded}
  <div id="member-list-offline" class="members-list">
```

### `[nice-to-have]` `member-location` tooltip multi-line `\n` portability

`MemberList.svelte:194`. `title={tooltipText}` with `\n` separators: confirmed by spec that all evergreen browsers (Chrome/Edge/Firefox/Safari) preserve `\n` line breaks in `title` tooltips. Will render correctly. No change needed. Calling out for the record.

### `[nice-to-have]` `localStorage` access in `$state` initializer is fine for this app

`MemberList.svelte:35`. Reading `localStorage` at component init is only a concern for SSR/hydration. claude-comms is purely client-rendered (no SvelteKit, no SSR), so this is correct. The `typeof localStorage !== 'undefined'` guard is defensive overkill but harmless. No change needed.

---

## 3. What looks good

- **`channelMembers = $state({})` nested mutation pattern is correct.** Per Svelte 5 docs (`$state` deep-state section): top-level `$state({})` props are deeply proxied, so `this.channelMembers[conv][key] = ts` correctly triggers reactivity. No immutable spread required for this case. Phil's understanding is right.
- **`onlineRow` snippet** is idiomatic. Snippets in the same lexical scope can reference outer `typingUsers`, `getMemberConversations`, etc. Rendering from two `{#each}` blocks with different `showLocation` flags is exactly the documented composition pattern (matches the docs' `{#snippet figure(image)}` example).
- **`{@const}` inside the snippet** is fine — runs once per row per render. Performance is non-concerning for typical member-list cardinalities.
- **`$effect` for localStorage persistence in MemberList** is the right escape-hatch — synchronizing reactive state into a side-channel is exactly what `$effect` is for. Autofixer's generic warning ("calling a function inside $effect") is a false positive here; `localStorage.setItem` is a pure side-effect, not a state assignment.
- **`#handleSystemConversation`** uses immutable array reassignment for `conversation_topic_changed` and `conversation_deleted`. That's correct — for `$state` arrays Svelte tracks identity on reassignment AND per-element mutation, but doing immutable spread is the safer pattern for "map the array to a new shape." Good.
- **`#handlePresence(msg, conversation = null)` defaulting** is clean. Routing in `#handleMessage` correctly distinguishes global vs conv-scoped presence topics and passes the right `conversation` argument.
- **`#fetchParticipants` ghost-reaper loosening** — the new `Object.keys(connections).length === 0` gate is the correct fix for Issue A from the v0.3.1 follow-up brief. Multi-channel members will no longer get pruned when polling a single channel.
- **Three-section MemberList layout** with sort-by-name + section-conditional rendering is clean. The DOM-removal-on-collapse (rather than `display: none`) is good practice.

---

## 4. Improvements not actioned (future PR fodder)

- **Replace the 500ms snapshot poll entirely** with direct prop binding (`active={store.activeMembers}`). The poll exists as a workaround for an earlier reactivity bug that no longer applies given the v0.3.2 derivation refactor. Removing it would simplify App.svelte:64–95 down to ~5 lines and eliminate the diff-fingerprint maintenance burden.
- **Move `offlineExpanded` localStorage key to a shared constant** alongside the existing `claude-comms-user-name` and unread-markers keys in mqtt-store.svelte.js. Today the key string `'claude-comms.offlineExpanded'` is hardcoded in MemberList.svelte:37,42. Drift risk if conventions change.
- **`#handleSystemConversation` `conversation_deleted` falls back to `'general'`** unconditionally. If the user has no `general` channel (custom-deployed broker without seed channels), they end up on a non-existent channel. Defensive option: fall back to `this.channels[0]?.id ?? 'general'`.
- **`getMemberConversations` iterates all `channelMembers` keys** each call. For a server with hundreds of conversations this becomes O(N·M) over a render. Index reversal (per-key → channels map) would be O(1). Not urgent at current scale.
- **`channelMembers` never prunes.** Comment at line 92 acknowledges this. Long-running session + many channels = unbounded growth. Server-driven REST poll partially mitigates by overwriting on every poll, but stale conv entries (deleted channels) stick around until process restart. Worth a sweep next PR — probably hook into `conversation_deleted` to drop `channelMembers[name]`.

---

## 5. Svelte MCP tools consulted

- **`mcp__plugin_svelte_svelte__list-sections`** — to enumerate available docs (used to identify $state, $derived, $effect, snippet, @render, @const as the relevant set).
- **`mcp__plugin_svelte_svelte__get-documentation`** (1st call) — `$state`, `$derived`, `$effect`, `snippet`, `@render`, `@const`. Confirmed:
  - Deep proxy semantics: nested-property mutation on a top-level `$state` object IS reactive. Validates Phil's `channelMembers[c][k] = ts` pattern.
  - Snippet scope rules: snippets are visible in the same lexical scope and can reference outer values including from `{#each}`. Validates the `onlineRow` two-section usage.
  - `$derived` recalculates on dep change but skips downstream updates when the result is referentially identical — reinforces that section-array length changes are the trigger.
  - `$effect` "when not to use" section: "avoid using it to synchronise state... use `$derived` instead." Direct hit on the App.svelte snapshot anti-pattern.
- **`mcp__plugin_svelte_svelte__get-documentation`** (2nd call) — `svelte/snippet`, `svelte/@render`, `svelte/@const`. Confirmed `{@const}` allowed as immediate child of `{#snippet}`, and `{@const}` re-evaluation happens per render in the containing block.
- **`mcp__plugin_svelte_svelte__svelte-autofixer`** (1st call, MemberList.svelte) — reported 0 issues, 1 generic suggestion about `$effect`-with-function-call (false positive for `localStorage.setItem`).
- **`mcp__plugin_svelte_svelte__svelte-autofixer`** (2nd call, App.svelte trimmed) — reported 0 issues but 3 named warnings: `activeMembers`, `onlineElsewhereMembers`, `offlineMembers` assigned inside `$effect`. Directly corroborates the [should-fix] in §2.

---

## 6. TL;DR for the orchestrator

Two changes to land in the v0.3.2 commit before tagging:

1. **MemberList.svelte:113–128** — add `|| ''` guards to the three `m.name.toLowerCase()` filter expressions. ~3-line diff.
2. **App.svelte:77–95** — either (a) extend fingerprint to include `channelMembers` for the active channel, or (b) drop the snapshot and bind store derivations directly. (b) is architecturally cleaner but slightly more invasive; (a) is the 1-line patch.

Everything else can wait for a follow-up PR.
