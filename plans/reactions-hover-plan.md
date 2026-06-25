# Reactions Hover/Tooltip + Detail Panel — Design Plan

**Status:** REVISED (post A/B adversarial review — 0 critical / 0 high / 0 medium)
**Author:** comms-dev-claude (architect)
**Reviewer:** A/B adversarial review (single-agent, both lenses), 2026-06-25
**Requested by:** Phil, 2026-06-25

> Review note: every code assumption below was verified against the actual source
> (file:line cited). The §9 open questions are all RESOLVED + locked in §10.

## 1. Goal / UX (Discord/Slack-style)

Let a user see **who reacted** to a message, per emoji, without cluttering the chat.

- **Hover a reaction pill** → a tooltip lists the people who used that emoji: the
  first `MAX_TOOLTIP_NAMES` names, and if there are more, a trailing `+N` overflow.
- The tooltip is **interactive** (hover-reveal, stays open on tooltip hover) and
  contains a **"See all"** affordance → opens a **reaction detail panel** for that
  message. The pill's own click is **unchanged** (it toggles your reaction — see §4.6).
- The reaction detail panel:
  - Left/top: the list of all emoji on the message, each with its count (and which is "yours").
  - Selecting an emoji shows, below/beside it, the **full list of users** who reacted with it.
  - Clicking a different emoji re-sorts/filters the user list to that emoji.
- The current user reads as **"You"** in any list.
- Counts and pills are visually unchanged except for the new hover + "See all" affordance.

## 2. Current state (what exists) — VERIFIED against code

- **Server already has who-reacted.** `tool_comms_reactions_get`
  (`src/claude_comms/mcp_tools.py:3096`) returns
  `{"conversation", "message_id", "reactions": {emoji: [actor_key, ...]}}`.
  `ReactionsStore` (`src/claude_comms/reactions.py:197`) keeps `emoji -> ordered set
  of actor_keys` (`_PerMessageState`, insertion order preserved — `reactions.py:152`).
  It also exposes `get_all()` (`reactions.py:252`) → `{message_id: {emoji:[actor_key]}}`
  for the whole conversation. Live reaction events on
  `claude-comms/conv/{conv}/reactions` carry `{message_id, emoji, actor_key, ts, op}`
  with `op` already resolved to terminal `add`/`remove` server-side
  (`reactions.py:116`, publish at `mcp_tools.py:3067`).
- **Client discards the actors.** The store's reaction handler
  `#handleRemoteReaction` (`web/src/lib/mqtt-store.svelte.js:5130`; self-echo guard at
  L5139) receives `actor_key` but only does `count++/count--`;
  `msg.reactions = [{emoji, count, active}]` (push at L5151). The optimistic local
  path `addReaction` (`mqtt-store.svelte.js:2557`) likewise tracks count/active only.
  No per-emoji user list anywhere.
- **No hydration.** Reaction events are published `retain=false`
  (`mcp_tools.py:3064` comment) and there is **no** `reactions_get` fetch in the web
  client (`#fetchHistory` at `mqtt-store.svelte.js:1009` fetches only `/api/messages`,
  which does **not** include reactions — message dicts carry no `reactions` field).
  So **reactions on historical messages do not survive a reload** today. This feature
  fixes it (§4.2).
- **`ReactionBar.svelte`** (`web/src/components/ReactionBar.svelte`) renders the pills
  (`emoji` + `count`, `active` highlight, `+` add button). Props: `reactions`,
  `onAddReaction`, `onToggleReaction`. The pill's `onclick` calls
  `onToggleReaction(emoji)` (L17) — **this toggle MUST be preserved** (see §4.6). This
  component is the host for the hover + "See all" affordance.
- **Name resolution source (corrected).** The name map is **`store.participants`**
  (`participants[key]?.name`, used e.g. at `mqtt-store.svelte.js:1430`), NOT a
  dedicated "member map". `channelMembers[conv][key]` holds only a **presence
  timestamp**, not a name — do not use it for name resolution. Fallback when a key is
  absent (reactor left the channel / not yet hydrated): render the raw 8-hex key.
- **REST is the read transport.** Every existing client read is a same-origin REST
  GET (`#fetchHistory` L1011, `#fetchParticipants` L1056, `/api/conversations` L718,
  `/api/capabilities` L1580). `mcpCall` (`api.js:426`) is reserved for **mutations**
  that have no REST route (join/leave/update_name). GET reads are token-free
  (`api.js:isTokenFree`).
- **Trust boundary (verified).** The web UI adopts the daemon's **single configured
  identity** (`cli.py:644` note — "every browser on this origin is the daemon's
  owner"). `/api/messages` returns history via `get_channel_messages`
  (`mcp_server.py:237` → `MessageStore.get`, `broker.py:131`) with **no `_is_visible`
  whisper filter** — i.e. the web client already receives all messages incl. whispers.
  See §4.5 for why this bounds (rather than expands) the reactions trust boundary.

## 3. Gaps to close

1. Client reaction model must carry **per-emoji actor keys** (`users[]`), not just count.
2. A **batch hydration path** so historical/scrollback reactions (and their actors)
   load — via a new same-origin REST GET that wraps `ReactionsStore.get_all()`.
3. **Key → display-name** resolution for reaction actors (use `store.participants`;
   fall back to key; "You" for self), resolved at render time so name changes reflect.
4. **UI:** hover tooltip (truncated names + `+N`) on `ReactionBar`, and a
   **ReactionDetailsPanel** popover (portaled, top-layer).

## 4. Design

### 4.1 Data model (store)
Extend the per-message reaction entry from `{emoji, count, active}` to:
```
{ emoji, count, active, users: string[] /* actor_keys, server insertion order */ }
```
- **`users` is the source of truth.** `count === users.length` and
  `active === users.includes(selfKey)` are **recomputed** from `users` on every
  mutation (never set independently — prevents the count/active drift that two
  independent counters invite).
- Ordering: preserve the server's insertion order (first-reacted-first), matching
  `_PerMessageState`'s ordered set. No client-side reordering (deterministic; survives
  re-resolution of names). "You" is rendered in its natural position (see §10/Q5).
- **Live events** (`#handleRemoteReaction`, upgraded): on `add`, append `actor_key`
  to `users` if absent; on `remove`, drop it; then recompute `count` + `active`. The
  existing self-echo guard (ignore events where `actor_key === selfKey`, L5139) is
  **kept for the direct-apply path** because the optimistic local update already wrote
  self into `users`. (Asymmetry note: the hydration replay buffer in §4.2 does **not**
  ignore self — it must, because it rebuilds from the authoritative snapshot.)
- **Optimistic path** (`addReaction`, upgraded): on a user click, add/remove
  `selfKey` in `users` and recompute count/active (replacing the standalone
  count++/active= logic). The server re-broadcast for self is ignored (guard above),
  so the optimistic write is the live truth for self until a hydration snapshot
  supersedes it.

### 4.2 Hydration (historical reactions) — batch, snapshot + buffered replay

**Transport (Decision A — LOCKED):** a same-origin REST GET, **batched per channel**:
```
GET /api/reactions/{conversation}
  → { conversation, reactions: { <message_id>: { <emoji>: [actor_key, ...] } } }
```
backed by a new `get_conversation_reactions(conversation)` in `mcp_server.py` that calls
`_get_reactions_store(conversation).get_all()` — mirroring how `_api_messages` calls
`get_channel_messages` directly. It does **NOT** route through `tool_comms_reactions_get`
(that tool imposes per-key membership theater irrelevant to the single-origin daemon-owner
web client, and is per-message — wrong granularity). One GET per channel load (issued
alongside `#fetchHistory`), not N per-message calls (see §10/Q2 for the rejected
lazy-on-hover alternative).

**Reconciliation (race-correct — replaces the unsound "union + last-op-wins"):**
The naive "union the snapshot with the live model" is **incorrect** — a `remove` that
arrives during the in-flight fetch would be re-added by the union (and there are no
per-actor sequence numbers to make "last-op-wins" well-defined). Use **snapshot +
buffered replay**, which is provably correct given QoS-1 in-order delivery on the single
reactions topic (already subscribed via the `conv/+/reactions` wildcard at
`mqtt-store.svelte.js:4420`):

1. On channel activation, mark hydration **in-flight** for that channel and start a
   **buffer** that records every reaction event for the channel (in arrival order) —
   **including self events**. Events are STILL applied live to the model so the UI stays
   responsive.
2. Issue the one `GET /api/reactions/{conversation}`.
3. On response, for each `message_id` in the snapshot: **rebuild** that message's
   `users[]` from the snapshot (authoritative base), then **re-apply the buffered events
   for that message in arrival order** (`add` → ensure present, `remove` → ensure
   absent), then recompute `count`/`active`. Clear the buffer; mark hydration done.
4. After hydration, events apply directly (the upgraded §4.1 live path).

This loses no removes and resurrects no removed actors. Messages with **no** snapshot
entry keep their live-tracked `users[]` untouched. This same path fixes the pre-existing
"reactions vanish on reload" gap (§10/Q3).

**Buffer lifecycle / failure handling (no stuck buffer, no leak):** the buffer is keyed
per channel and bounded by the hydration window only.
- On GET **failure or timeout**: clear the in-flight flag, **discard the buffer**, and
  fall back to plain direct-apply (live events were already applied during buffering, so
  only the historical snapshot is missing — degrades gracefully to today's behavior). No
  retry storm; the next channel activation re-attempts.
- On **channel switch before the response lands**: the response is matched to its channel
  and any response for a channel that is no longer the in-flight target is ignored, and
  its buffer is dropped (per-channel keying prevents cross-channel contamination).
- The reconciliation only ever touches messages already present in `this.messages`;
  snapshot entries for unknown `message_id`s are ignored (bounds memory + work).

### 4.3 Name resolution
- `resolveReactor(actor_key) -> { name, isSelf }`:
  `name = store.participants[actor_key]?.name ?? actor_key`,
  `isSelf = actor_key === store.userProfile.key` → render "You".
- Resolution happens at **render time** (a `$derived`/inline lookup reactive to
  `store.participants`), so a reactor's later name change or late-arriving participant
  record updates the displayed list automatically.

### 4.4 UI
- **ReactionBar pill hover** → tooltip listing up to `MAX_TOOLTIP_NAMES` resolved names
  joined by `, `, then `+N` when `users.length > MAX_TOOLTIP_NAMES`. The tooltip is
  `role="tooltip"`, shown on pointer hover **and** keyboard focus of the pill, and is
  itself hoverable (so the user can move into it to click "See all"). It includes a
  **"See all"** control that opens the panel.
- **ReactionDetailsPanel** (new component): opened by "See all" (or, on touch, a
  long-press on the pill — see §4.6). Shows all emoji for the message as a selectable
  list (emoji + count + self-marker), a selected-emoji user list (resolved names; "You"
  in natural order), keyboard nav + focus trap + Esc to close + click-outside close.
  **Rendered top-layer via the `portal()` attachment** (`web/src/lib/portal.js`) so it
  escapes ancestor `backdrop-filter` stacking contexts (see §10/Q4), positioned from the
  pill's `getBoundingClientRect()` as a `position: fixed` element with z-index above the
  side panels (ContextMenu uses 200 — use ≥ 250). Do **not** reuse the bits-ui
  ContextMenu primitive (it is right-click-coordinate anchored, wrong interaction model).

### 4.5 API / back-end + visibility/trust boundary (LOCKED)
- New `build_reactions_route(get_conversation_reactions, cors=...)` in `cli.py`, mirroring
  `build_conversations_route`/`build_capabilities_route` (validate `conversation` with
  `validate_conv_id` → 400 on bad id; return `{conversation, reactions}`; CORS via the
  injected `_cors`). Registered in the shared `api_routes` list (`cli.py:1954`) so the
  same Route backs both the MCP/REST and web-port servers. Backing function
  `get_conversation_reactions` added to `mcp_server.py` next to `get_channel_messages`.
  No new MCP tool (the existing `comms_reactions_get` stays for agent callers).
- **Visibility / whisper analysis (resolves the security open question):** the reactions
  GET inherits **exactly** the trust boundary of `/api/messages`, no wider:
  - `/api/messages` already returns **all** messages (incl. whispers) to the
    single-origin daemon-owner web client with no `_is_visible` filter
    (`broker.py:131`; verified). The web client therefore already displays whisper
    bodies; "who reacted" to such a message is **strictly less sensitive** than the
    body it is already showing → **no net-new leak**.
  - The reactions GET is registered on the **same same-origin route list** as
    `/api/messages` (same exposure: loopback/same-origin/daemon-owner; token-free GET).
    It must **not** be added to any more-public surface, and must **not** be wired with
    broader auth than `/api/messages`.
  - The client only renders a `ReactionBar` for messages already in `this.messages`, so
    the who-reacted set is bounded by the already-rendered message set. No reaction data
    is surfaced for messages the client doesn't display.
  - **Explicitly out of scope (pre-existing):** `/api/messages` not applying
    `_is_visible` is a pre-existing property of the single-identity web model; fixing
    whisper redaction in the REST surface is a separate change and is **not** introduced
    or worsened by this feature. Flagged for the architect (low, §11).

### 4.6 Pill click vs panel open (collision — RESOLVED)
The pill's existing `onclick` toggles the reaction (`ReactionBar.svelte:17` →
`onToggleReaction`). The panel must **not** steal that click. Locked interaction model:
- **Pill click** = toggle your reaction (unchanged).
- **Open panel** = the tooltip's "See all" control (pointer + keyboard).
- **Touch / no-hover** = **long-press** the pill opens the panel (short tap still
  toggles). The tooltip's hover-reveal is unavailable on touch, so long-press is the
  panel entry point there.
- Keyboard: pill is focusable (shows tooltip on focus); a secondary key (e.g. the
  tooltip "See all" button reachable by Tab, or Shift+Enter on the pill) opens the panel
  while plain Enter/Space toggles.

## 5. Components / files (preview — full edge/module map is a separate step)
- `web/src/lib/mqtt-store.svelte.js` — `users[]` in the reaction model; upgrade
  `addReaction` (optimistic self) + `#handleRemoteReaction` (live `users[]` maintain,
  recompute count/active); add per-channel hydration buffer + `#fetchReactions(channel)`
  batch GET + snapshot/replay merge (called alongside `#fetchHistory`); `resolveReactor`
  helper.
- `web/src/components/ReactionBar.svelte` — interactive hover tooltip + "See all" +
  long-press; pass `users`/resolver through.
- `web/src/components/ReactionDetailsPanel.svelte` — NEW portaled popover.
- `web/src/lib/api.js` — `getReactions(conversation)` (REST GET helper).
- `src/claude_comms/mcp_server.py` — `get_conversation_reactions(conversation)` backing fn.
- `src/claude_comms/cli.py` — `build_reactions_route` + registration in `api_routes`.
- Tests: vitest (store `users[]` accumulate/dedup, count/active derive, hydration
  snapshot+buffered-replay incl. a remove arriving mid-fetch, name resolution, tooltip
  truncation, panel emoji-switch/keyboard/Esc); pytest (`build_reactions_route` 200 shape
  + 400 on bad conv id; `get_conversation_reactions` returns `get_all()` shape).

## 6. Edge cases
- Many reactors (50+) → tooltip truncates to `MAX_TOOLTIP_NAMES` + `+N`; panel scrolls.
- Reactor's display name changes after reacting → resolved at render time (§4.3).
- Self reaction → "You" in natural insertion order.
- Reaction add/remove **while** tooltip/panel open → live update the open view (the model
  is reactive; the panel reads the same `users[]`).
- Offline / departed reactor → still listed (they did react); name falls back to 8-hex
  key when `store.participants` has no entry. No presence dependency.
- Emoji the current user can't render → shown as-is.
- Empty after last removal → pill disappears (existing behavior); close the panel/tooltip
  if its currently-selected emoji vanished (select the next emoji, or close if none left).
- **Hydration race**: snapshot + buffered replay (§4.2) — a `remove` arriving mid-fetch is
  correctly applied; a removed actor is never resurrected.
- No-hover devices → long-press opens panel; short tap still toggles (§4.6).

## 7. Out of scope
- Changing how reactions are added (EmojiPicker) or stored server-side.
- Reaction analytics, animated reactions, custom/uploaded emoji.
- Real-time presence dots inside the reaction list.
- Whisper redaction in `/api/messages`/`/api/reactions` (pre-existing single-identity
  model property — §4.5, §11).

## 8. Testing
- Store: add/remove accumulates `users`, dedup, count/active **derive** from users;
  optimistic self write + ignored self echo; hydration merge — snapshot rebuild,
  buffered-replay with a `remove` and an `add` arriving mid-fetch (assert correct final
  membership), message-not-in-snapshot left untouched.
- Name resolution: self→"You", unknown key→raw key, name-change reflected after
  `participants` update.
- ReactionBar tooltip: ≤MAX names inline, `+N` past MAX, a11y (focus shows tooltip,
  tooltip hoverable, "See all" reachable). Pill click still toggles (regression guard).
- Panel: emoji select switches user list, keyboard nav, Esc/click-outside close,
  portaled above panels (z-index regression), selected-emoji-vanishes handling.
- REST route: 200 shape `{conversation, reactions:{mid:{emoji:[key]}}}`, bad conv id →
  400; `get_conversation_reactions` mirrors `get_all()`.

## 9. Open questions (for A/B review) — ALL RESOLVED in §10
1. Decision A (REST) vs B (mcpCall) for hydration.
2. Hydrate eagerly-on-view (batch) vs lazily-on-hover.
3. Is the "reactions vanish on reload" fix in-scope here?
4. Which existing popover/portal primitive for the panel.
5. `MAX_TOOLTIP_NAMES` value + "You" ordering.

## 10. Resolved decisions (locked)
1. **Decision A — REST GET, batched.** Every existing client read is a same-origin
   token-free REST GET; `mcpCall` is reserved for mutations without a REST route. A
   `GET /api/reactions/{conversation}` (wrapping `get_all()`) is the idiomatic, cacheable,
   single-origin fit. mcpCall (Decision B) is rejected: wrong granularity (per-message),
   heavier transport, and it'd be the only read going through `/mcp`.
2. **Eager batch, one GET per channel load.** Lazy-on-hover is rejected: it adds latency
   to the first hover AND you need the data at render time anyway to show correct counts
   on reloaded scrollback. Per-message N-calls is rejected on request volume (≈50/load).
   One batch GET alongside `#fetchHistory` is both correct and cheap.
3. **In scope.** "Reactions vanish on reload" is a prerequisite for who-reacted on
   scrollback and is fixed for free by the batch hydration (§4.2). No separate change.
4. **`portal()` attachment** (`web/src/lib/portal.js`, the v0.4.4 stacking-context fix)
   + manual `getBoundingClientRect` positioning + `position:fixed; z-index ≥ 250`. Not
   the bits-ui ContextMenu (right-click-anchored).
5. **`MAX_TOOLTIP_NAMES = 3`** (compact Discord-style tooltip; full list in the panel —
   exact integer is tunable, see §11). **"You" ordering = natural server insertion order**
   (first-reacted-first), rendered as "You" in place — deterministic, matches the
   server's ordered set, no reshuffle on name (re)resolution.

## 11. Open low/nit items (architect's discernment — not blocking)
- **N1:** `MAX_TOOLTIP_NAMES = 3` is a taste call; 3–5 all reasonable. Tune to design.
- **N2:** Tooltip overflow wording: `+N` (compact) vs `and N others` (verbose). Locked to
  `+N`; swap if design prefers prose.
- **N3:** `get_all()` returns reactions for the whole conversation; for very large
  conversations consider scoping the batch to the loaded message-id window (the store is
  already capped + snapshotted, so this is an optimization, not a correctness issue).
- **N4:** Pre-existing: `/api/messages` (and thus `/api/reactions`) do not apply
  `_is_visible` whisper redaction under the single-identity web model. Out of scope here;
  worth a dedicated decision if multi-user web auth is ever added (`cli.py:644` FUTURE note).
- **N5:** Long-press timing/threshold for the touch panel-open gesture is unspecified
  (≈500ms typical) — pin during implementation.
