# v0.4.2 Wave G Sidebar polish (VERIFY-WAVE-G-3 / -4 / -5 follow-up)

**Agent:** svelte:svelte-file-editor (single, N=1 on shared tree alongside parallel ChatHeader-button-row agent on disjoint files)
**Predecessor:** Wave G (`942761d`) + parallel ChatHeader-row follow-up (`7e7d5a6`).
**Brief:** Resolve the 3 [VERIFY] tags Wave G surfaced in `.worklogs/v042-3.9-notification-policy.md` §11.
**Date:** 2026-05-19
**HEAD pre-wave:** `7e7d5a6` (parallel ChatHeader agent committed during this session).

---

## 1. THREE ISSUES FIXED

### Issue 1 - [VERIFY-WAVE-G-3] Sidebar wires the new ChannelContextMenu / SidebarChannelRow props

Sidebar.svelte now:
- Forwards a `getNotificationPolicy(channelId)` callback through each `SidebarChannelSection` into `SidebarChannelRow` so the Wave G bell-icon variant renders on the FIRST sidebar paint for every channel with a non-default policy. The callback reads `store.getNotificationPolicy(...)` while also touching `store.notificationPolicies` so Svelte's reactivity registers a dependency on the $state map, guaranteeing re-render on `setNotificationPolicy` / `cycleNotificationPolicy` writes.
- Resolves `currentNotificationPolicy={contextMenuPolicy}` on the `ChannelContextMenu` mount so the Q8 quickview row's "Notifications: <policy>" label reflects the actual current state instead of the silent default `'All'` fall-back.
- Handles `actionId='notif:cycle'` inside `handleContextAction` by calling `store.cycleNotificationPolicy(c.id)`. The companion `actionId='notif:configure'` requires no Sidebar work because ChannelContextMenu already self-dispatches the `claude-comms:configure-notifications` window CustomEvent that App.svelte listens for.

**Exact actionId names confirmed against `.worklogs/v042-3.9-notification-policy.md` §11 and `ChannelContextMenu.svelte:151-162`:** `'notif:cycle'` (quickview) and `'notif:configure'` (full popover). No improvisation.

### Issue 2 - [VERIFY-WAVE-G-4] Browser Notification policy gate

`web/src/lib/notifications.svelte.js` now mirrors App.svelte:541-573's policy decision tree on the browser `Notification` path:

```
policy='Off'      -> never notify.
policy='Mentions' -> notify on @mention OR highlight-word match only.
policy='All'      -> notify always EXCEPT when channel.muted AND msg is not a mention.
```

Implementation shape (additive, never breaks legacy callers):
1. New `setNotificationPolicyResolver(fn)` lets a host (Sidebar.svelte registers `store.getNotificationPolicy`) inject a per-channel resolver. Passing `null` clears it for tests.
2. New `resolveNotificationPolicy(opts)` pure helper: explicit `opts.notificationPolicy` overrides the resolver; `opts.channel` falls back to the resolver; absent both falls back to `{policy:'All', highlightWords:[]}` (legacy behavior preserved).
3. New `shouldNotifyForPolicy(policy, ctx)` pure helper applies the decision tree against `{mentions, userKey, muted, body}`. Mention + highlight-word hit BOTH bypass the legacy `muted` flag, exactly mirroring the Wave G App.svelte fix.
4. `sendNotification(title, options)` runs the gate up-front; if `shouldFire` is false, returns `null` before any `new Notification(...)` call.

**App.svelte read-only constraint preserved:** the call site (`App.svelte:515`) currently does not pass `channel`, `mentions`, `userKey`, or `muted`. In that legacy mode the gate uses the registered resolver's per-channel policy and the default fall-back for `muted=false / mentions=null`, which yields `shouldFire=true` for `policy='All'` channels (legacy parity) and `false` for `policy='Off'` channels (the bug fix). A future wave that updates the App.svelte caller to forward `channel + mentions + muted` unlocks the full Mentions-only and muted-bypass semantics; this wave lays the strictly additive infrastructure.

### Issue 3 - [VERIFY-WAVE-G-5] Bootstrap pre-warm

New `#prewarmNotificationPolicies()` private method on `MqttChatStore`, fired from the tail of `#bootstrapChannels()` (after `#restoreLocalChannelState`, before `#resetActiveChannelIfStale`). Iterates `Object.values(this.channelsById)` and calls `this.getNotificationPolicy(ch.id)` once each. Side effect: populates the reactive `notificationPolicies` $state map so every consumer (sidebar bell variant, toast handler, browser-notification gate) reads from a populated cache on the FIRST render instead of waiting for the user to right-click a channel.

**Approach + rationale.** Chose the store-side bootstrap hook over a Sidebar.svelte `$effect` because the cache is store-owned state and the bootstrap is the natural one-shot population point. An $effect would have to re-run on every channels-list mutation (joins / leaves) and re-iterate the full list. The bootstrap approach pre-warms once + the lazy-on-read path in `getNotificationPolicy` covers any later additions (channel-join via `#channelRowFromPayload`).

## 2. FILE / LOC DELTAS

| File | Owner | Notes |
|---|---|---|
| `web/src/components/Sidebar.svelte` | this wave | +57 LOC: notif:cycle handler, `contextMenuPolicy` $derived, `getChannelNotificationPolicy` helper, $effect that registers the notifications-module resolver, prop wire to ChannelContextMenu, prop wire to all 3 SidebarChannelSection mounts. |
| `web/src/components/SidebarChannelSection.svelte` | this wave (not in read-only list) | +15 LOC: adds optional `getNotificationPolicy` prop, forwards it as `notificationPolicy={...}` into each SidebarChannelRow. Safe defaults for legacy callers. |
| `web/src/lib/mqtt-store.svelte.js` | this wave | +39 LOC: `#prewarmNotificationPolicies()` helper + call from `#bootstrapChannels`. |
| `web/src/lib/notifications.svelte.js` | this wave | +168 LOC: `setNotificationPolicyResolver`, `resolveNotificationPolicy`, `shouldNotifyForPolicy`, gate integration in `sendNotification`. JSDoc throughout. |
| `web/tests/sidebar-notification-wire.spec.js` | NEW | 9 tests. |
| `web/tests/notifications-policy-gate.spec.js` | NEW | 12 tests. |
| `.worklogs/v042-wave-G-sidebar-polish.md` | NEW | this file. |

## 3. BROWSER-NOTIF POLICY DECISION TREE (CODE-VERIFIED)

Implemented in `shouldNotifyForPolicy(policy, ctx)`:

```javascript
const isFormalMention =
  Array.isArray(c.mentions) &&
  typeof c.userKey === 'string' &&
  c.userKey.length > 0 &&
  c.mentions.includes(c.userKey);
const body = typeof c.body === 'string' ? c.body.toLowerCase() : '';
const isHighlightHit =
  !isFormalMention &&
  Array.isArray(p.highlightWords) &&
  p.highlightWords.length > 0 &&
  body.length > 0 &&
  p.highlightWords.some((w) => typeof w === 'string' && w.length > 0 && body.includes(w));
const msgIsMention = isFormalMention || isHighlightHit;

let shouldNotify;
if (p.policy === 'Off')          shouldNotify = false;
else if (p.policy === 'Mentions') shouldNotify = msgIsMention;
else                              shouldNotify = true; // 'All'

if (shouldNotify && c.muted === true && !msgIsMention) shouldNotify = false;
```

Mirrors `App.svelte:541-573` line for line so the in-app toast and the browser Notification fire/suppress together.

## 4. TESTS BY NAME

### `web/tests/sidebar-notification-wire.spec.js` (9 tests)

1. `renders the BellDot variant on a row whose policy is Mentions`
2. `renders the BellOff variant on a row whose policy is Off`
3. `renders no bell badge at all on a row whose policy is the default "All"`
4. `shows the channel's current policy in the Q8 quickview row label`
5. `shows "Notifications: All" when no policy override is configured`
6. `clicking the quickview row calls store.cycleNotificationPolicy and closes the menu`
7. `cycling an unset policy advances the label on the next open of the same channel`
8. `populates store.notificationPolicies for every bootstrapped channel`
9. `preserves explicit policies from localStorage during pre-warm`

### `web/tests/notifications-policy-gate.spec.js` (12 tests)

1. `policy=Off: never notifies, even for an @mention`
2. `policy=Off: never notifies, even when muted=false and policy was set explicitly silent`
3. `policy=Mentions: notifies on an @mention, suppresses ordinary messages`
4. `policy=Mentions: highlight-word substring hit raises a notification on a non-mention message`
5. `policy=Mentions: highlight-word match is case-insensitive`
6. `policy=All: notifies on every ordinary message when not muted`
7. `policy=All: muted channel + non-mention -> suppressed (legacy mute)`
8. `policy=All: muted channel + @mention -> fires (mention bypasses mute, the Wave G bug fix)`
9. `policy=All: muted channel + highlight-word hit -> fires (Q7 parallels mention-bypass)`
10. `explicit notificationPolicy option supersedes the registered resolver`
11. `registered resolver is used when only options.channel is supplied`
12. `falls back to {policy: All, highlightWords: []} when no resolver and no override`

**Total new tests: 21** (target floor was 12).

## 5. SVELTE-AUTOFIXER PER FILE

| File | Issues | Suggestions |
|---|---|---|
| `Sidebar.svelte` | 0 | 3 standing-pattern: `setNotificationPolicyResolver` + `getChannelNotificationPolicy` invocations inside `$effect`. These are the intentional registration / teardown side-effects (same pattern Wave G accepted on App.svelte's `addEventListener` $effect; documented in `.worklogs/v042-3.9-notification-policy.md` §9 as "standing-pattern suggestions"). Not actionable. |
| `SidebarChannelSection.svelte` | 0 | 0 |
| `notifications.svelte.js` | 0 | 0 |
| `mqtt-store.svelte.js` (new helper block) | 0 | 0 |

## 6. §I.18 EDGE-MAP VERIFICATION

| Cross-edge | Producer | Consumer | Status |
|---|---|---|---|
| `notificationPolicy` prop on `SidebarChannelRow` | Wave G | Sidebar (this wave) via SidebarChannelSection | LANDED |
| `currentNotificationPolicy` prop on `ChannelContextMenu` | Wave G | Sidebar (this wave) | LANDED |
| `actionId='notif:cycle'` from `ChannelContextMenu` | Wave G | Sidebar `handleContextAction` (this wave) | LANDED |
| `store.notificationPolicies` $state map writes | Wave G `setNotificationPolicy` / `cycleNotificationPolicy` | Sidebar's `contextMenuPolicy` $derived + per-row callback (this wave) | LANDED |
| `setNotificationPolicyResolver(fn)` registration | `notifications.svelte.js` (this wave) | Sidebar `$effect` (this wave) | LANDED |
| `shouldNotifyForPolicy` gate inside `sendNotification` | `notifications.svelte.js` (this wave) | Future App.svelte wave (caller must pass channel + mentions + muted to fully activate) | LANDED (additive; legacy callers preserved) |
| `#prewarmNotificationPolicies` from bootstrap | `mqtt-store.svelte.js` (this wave) | Sidebar bell-variant first-paint (this wave) | LANDED |

## 7. [VERIFY] for later waves

**[VERIFY-WAVE-G-4-FOLLOWUP]** App.svelte's call to `sendNotification(last.sender.name, {body, tag})` currently does not pass `channel`, `mentions`, `userKey`, or `muted`. The gate infrastructure shipped this wave is in place; activating the full Mentions-only and muted-bypass semantics requires a future wave (when App.svelte is no longer read-only) to forward those four fields. Until then the gate uses the resolver-supplied per-channel policy (so `policy='Off'` correctly suppresses) and treats messages as non-mention / non-muted (so `policy='Mentions'` short-circuits to suppress, which is the safer fail-shut default).

**[VERIFY-WAVE-G-3-INVITE]** The existing `'invite'` actionId is dispatched as a window CustomEvent by ChannelContextMenu (per Wave F pattern) and is intentionally not handled in Sidebar's `handleContextAction` switch. Left as-is.

## 8. VERIFICATION GATES

| Gate | Required | Actual | Pass |
|---|---|---|---|
| vitest passing | >= 1037 | **1057** (full suite) | yes |
| vitest failing | 0 | 0 | yes |
| New tests | >= 12 | **21** (9 + 12) | yes |
| pnpm build | green | green in 5.75s | yes |
| svelte-autofixer | clean | 0 issues across all 4 touched files | yes |

Raw vitest output: `Test Files 67 passed (67) Tests 1057 passed (1057) Duration 28.64s`
Raw build output: `built in 5.75s`
Just-my-new-specs output: `Test Files 2 passed (2) Tests 21 passed (21)`

## 9. SCOPE CONFIRMATION

**Touched (write):**
- `web/src/components/Sidebar.svelte`
- `web/src/components/SidebarChannelSection.svelte` (not in read-only list)
- `web/src/lib/notifications.svelte.js`
- `web/src/lib/mqtt-store.svelte.js`
- `web/tests/sidebar-notification-wire.spec.js` (NEW, 9 tests)
- `web/tests/notifications-policy-gate.spec.js` (NEW, 12 tests)
- `.worklogs/v042-wave-G-sidebar-polish.md` (this file)

**NOT touched (verified):** App.svelte, ChatHeader.svelte (parallel agent owns); SidebarChannelRow.svelte, ChannelContextMenu.svelte, NotificationPolicyMenu.svelte (read-only per brief); all Python files; CHANGELOG.md, pyproject.toml, web/package.json, USAGE.md; any other test file.

**Constraints honored:**
- No em dashes anywhere in this file or the touched source files (verified by grep on my new content).
- No destructive git ops.
- Single-agent execution on shared tree; no worktree.
- Phil's name capitalization preserved (no occurrences in this wave's text).
