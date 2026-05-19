# v0.4.2 [VERIFY-WAVE-G-4-FOLLOWUP] — App.svelte sendNotification policy-gate forwarding

## 1. WHAT changed (one paragraph)

Wave G (commit `6e8c8c9`) landed the browser-Notification policy gate
infrastructure inside `web/src/lib/notifications.svelte.js`
(`shouldNotifyForPolicy` + `resolveNotificationPolicy` + the in-line
gate in `sendNotification`) but the lone `sendNotification` call site
in `App.svelte:515` still only passed `{body, tag}`, leaving the gate
without the channel/mentions/userKey/muted context needed to apply the
full Mentions-only suppression and the muted-bypass-on-mention rule.
This follow-up extends that call site to forward all four fields so
the browser-Notification surface decision logic matches the App-level
toast decision tree exactly (App.svelte:541-573).

## 2. File / LOC delta

| File | Change | LOC delta |
|------|--------|-----------|
| `web/src/App.svelte` | extend `sendNotification` call with `channel`, `mentions`, `userKey`, `muted`; add `chForNotify` lookup; comment block explaining the [VERIFY-WAVE-G-4-FOLLOWUP] mechanism | +13 / -1 |
| `web/tests/app-browser-notification-gate.spec.js` | NEW. 4 tests pinning the forwarding + end-to-end gate verdict across the four policy/muted/mention combinations | +273 NEW |
| `.worklogs/v042-app-sendnotification-fix.md` | NEW (this file) | +N NEW |

## 3. Before / after snippet

### Before (App.svelte:515-518, post-Wave-G)
```js
sendNotification(last.sender.name, {
  body: last.body.slice(0, 100),
  tag: last.id
});
```

The gate inside `notifications.svelte.js` saw no channel context, so
`resolveNotificationPolicy` fell back to the registered resolver
keyed on `undefined` (returning the default `{policy: 'All',
highlightWords: []}`) and `shouldNotifyForPolicy` saw `muted=false`
and `mentions=undefined`, meaning policy=Mentions ALWAYS suppressed
and the muted-bypass-on-mention rule never fired.

### After (App.svelte:515-531)
```js
// v0.4.2 [VERIFY-WAVE-G-4-FOLLOWUP] — forward channel + mentions +
// userKey + muted to sendNotification so the browser Notification
// policy gate in notifications.svelte.js (Wave G) sees full
// context and can apply Mentions-only suppression and the
// mention-bypasses-mute rule, mirroring the in-app toast logic
// below. The gate inside sendNotification resolves the active
// per-channel policy via the resolver Sidebar registered at
// mount time, so the call site only needs to forward raw context.
const chForNotify = store.channels.find(c => c.id === last.channel);
sendNotification(last.sender.name, {
  body: last.body.slice(0, 100),
  tag: last.id,
  channel: last.channel,
  mentions: last.mentions,
  userKey: store.userProfile.key,
  muted: !!(chForNotify && chForNotify.muted)
});
```

`chForNotify` is a local lookup distinct from `ch` used inside the
later toast `if (last.channel !== store.activeChannel || document.hidden)`
block so the existing toast-path code is unchanged. The two lookups
read the same `store.channels` snapshot in the same effect run so
they cannot diverge.

## 4. Tests by name

`web/tests/app-browser-notification-gate.spec.js` (4 NEW tests, all
under the describe block
`App.svelte - [VERIFY-WAVE-G-4-FOLLOWUP] sendNotification forwards channel/mentions/userKey/muted`):

1. `policy="Off" on channel: sendNotification args feed a gate verdict of suppress`
   - Asserts options.channel === 'general', options.mentions === ['me-key'],
     options.userKey === 'me-key', options.muted === false, and the gate's
     `shouldNotifyForPolicy({policy:'Off',...}, options)` returns false.
2. `policy="Mentions": @mention message triggers a fire verdict from the gate`
   - Asserts the mention list + userKey forward correctly and the gate
     returns true for the @mention.
3. `policy="All" + muted + non-mention: gate suppresses (legacy mute still wins for ordinary messages)`
   - Asserts options.muted === true forwarded correctly; gate returns false.
4. `policy="All" + muted + @mention: gate fires (mention bypasses mute, the Wave G bug fix)`
   - Asserts both muted=true AND mentions=['me-key'] forwarded; gate
     returns true (the bug-fix invariant).

Test design rationale: we mock `sendNotification` to capture the
options object, then hand the captured `(mentions, userKey, muted,
body)` tuple to the REAL `shouldNotifyForPolicy` to compute the
expected verdict. This decouples App-level forwarding (what this
file owns) from the gate's decision math (covered exhaustively by
`notifications-policy-gate.spec.js` with 12 tests). Pattern mirrors
`app-toast-mention-muted.spec.js` for the JSDOM polyfills + store
mock + seed-and-render harness.

## 5. Autofixer

`mcp__plugin_svelte_svelte__svelte-autofixer` was run on the App.svelte
notification-effect region (representative scoped snippet covering the
modified call site + surrounding `$effect`). Result:

```
{"issues":[], "suggestions": [
  "The stateful variable \"lastNotifiedId\" is assigned inside an
   $effect which is generally consider a malpractice. Consider using
   $derived if possible.",
  "You are calling a function inside an $effect. ... Ignore this
   suggestion if you are sure this function is not assigning any
   stateful variable or if you can't check if it does.",
  "You are calling the function `sendNotification` inside an $effect.
   ... [same boilerplate]",
  "You are calling a function inside an $effect. ... [same boilerplate]"
]}
```

`issues=[]`. Suggestions are all pre-existing patterns in the surrounding
`$effect` (these existed in Wave G's `6e8c8c9` baseline too):
`lastNotifiedId` assignment is a legitimate dedup-state pattern that
cannot be a `$derived` because it is reset-on-self-match, and
`sendNotification` is a deliberate side-effect call (it dispatches a
browser Notification) that is not derivable. No action.

## 6. Verification gates

| Gate | Pre | Post | Status |
|------|-----|------|--------|
| vitest count | 1057 | 1061 | met (+4, floor was ≥1061) |
| vitest failures | 0 | 0 | met |
| pnpm build | green | green | met |
| svelte-autofixer issues | n/a | 0 | met |
| pytest count | 1347 | 1347 (untouched) | met |
| ruff | clean | clean (no Python touched) | met |

## 7. Scope confirmation

**Files I OWN (touched):**
- `web/src/App.svelte`
- `web/tests/app-browser-notification-gate.spec.js` (NEW)
- `.worklogs/v042-app-sendnotification-fix.md` (NEW)

**Files I MUST NOT touch (verified untouched):**
- ANY Python file
- `web/src/lib/notifications.svelte.js`
- `web/src/components/ChatHeader.svelte`, `Sidebar.svelte`,
  `SidebarChannelRow.svelte`, `SidebarChannelSection.svelte`,
  `ChannelContextMenu.svelte`, `NotificationPolicyMenu.svelte`,
  or any other component
- `web/src/lib/mqtt-store.svelte.js`, `api.js`, `keyboard.svelte.js`
- `CHANGELOG.md`, `pyproject.toml`, `web/package.json`, `USAGE.md`
  (parallel release-prep work owns these)
- Any test file outside the new spec

`git status --porcelain` confirms only the three owned paths show in
the working tree.

## 8. Commit

```
fix(ui): App.svelte sendNotification passes channel/mentions/muted for full policy gate (v0.4.2 VERIFY-WAVE-G-4-FOLLOWUP)
```

Staged via explicit `git add` of the three owned paths; no `git add .`
or `-a`; no push, no tag.
