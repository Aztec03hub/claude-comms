# Reactions Hover/Tooltip — Edge / Module Map (architect → implementer)

Companion to `plans/reactions-hover-plan.md` (design, post A/B, 0 C/H/M). This is the
build map: modules, their edges/interfaces, data flow, sequencing, blast radius.

## Architect discernment on the open low/nit (from A/B worklog)
- **N1** `MAX_TOOLTIP_NAMES = 3` — keep 3.
- **N2** Overflow wording — use **`+N others`** (e.g. `Alice, Bob, Carol +12 others`), matching Phil's stated UX. (Plan's `+N` → `+N others`.)
- **N3** Per-message-window batch scoping for very large convs — **defer** (one GET per channel is fine at current scale; leave a `# future:` note, don't build).
- **N4** `/api/messages` whisper non-redaction — **out of scope** (pre-existing single-identity property; do not touch).
- **N5** Long-press threshold — **500ms** for the touch panel-open gesture.

## Modules + edges

### Backend (Python — additive, low risk)
- **M1 `src/claude_comms/mcp_server.py`** — ADD `get_conversation_reactions(conversation: str) -> dict[str, dict[str, list[str]]]` = `_get_reactions_store(conversation).get_all()`. Pure read. Sits next to `get_channel_messages`. → edge: consumed by M2 only.
- **M2 `src/claude_comms/cli.py`** — ADD `build_reactions_route(get_conversation_reactions, cors=...)` → `GET /api/reactions/{conversation}`: `validate_conv_id` (400 on bad id), return `{conversation, reactions}`, CORS via injected `_cors`. REGISTER in the shared `api_routes` list (~L1954) so both the REST (:9920) and web (:9921) servers serve it. → edges: depends on M1; same trust boundary as `/api/messages` (do NOT add broader auth; token-free GET).

### Client data layer (Svelte — via Svelte agent; MEDIUM risk: touches core reaction paths)
- **M3 `web/src/lib/api.js`** — ADD `getReactions(conversation)` = same-origin token-free REST GET of `/api/reactions/{conversation}` (mirror the `/api/messages` GET helper; it's a read, NOT mcpCall). → edge: called by M4 hydration.
- **M4 `web/src/lib/mqtt-store.svelte.js`** (.svelte.js → Svelte agent) — THE data core:
  - Reaction model entry gains `users: string[]` (server insertion order). **`count` and `active` become DERIVED** from `users` on every mutation (`count = users.length`, `active = users.includes(selfKey)`) — never set independently.
  - `addReaction` (optimistic, ~L2557): add/remove `selfKey` in `users`, recompute. Keep the existing publish.
  - `#handleRemoteReaction` (~L5130): maintain `users` from `{actor_key, op}`; KEEP the self-echo guard (~L5139) for this direct-apply path.
  - Hydration: `#fetchReactions(channel)` (calls M3) + per-channel **buffer + snapshot/buffered-replay** merge (plan §4.2 — apply live events to buffer AND model during fetch; on response rebuild `users[]` from snapshot then replay buffer in arrival order; the replay path does NOT skip self). Call it alongside `#fetchHistory` on channel activation. Buffer lifecycle: in-flight flag per channel; on GET failure/timeout → discard buffer + fall back to direct-apply; on channel switch → ignore stale response + drop buffer; only touch messages already in `this.messages`.
  - `resolveReactor(actor_key) -> {name, isSelf}`: `store.participants[key]?.name ?? key`; `isSelf = key === userProfile.key`. Used at render time (reactive to `participants`).
  → edges: M3 (fetch), `participants` (names), reactions topic sub (events), `#fetchHistory` (co-trigger). Produces the reactive `users[]` consumed by M5/M6.

### Client UI (Svelte — via Svelte agent; LOW–MED risk)
- **M5 `web/src/components/ReactionBar.svelte`** — accept `users` (+ a resolver or pre-resolved names) per reaction. Render interactive hover tooltip: up to 3 names + `+N others`; `role="tooltip"`, shown on pointer-hover AND keyboard-focus, itself hoverable, contains a **"See all"** control. **PRESERVE the pill `onclick` = `onToggleReaction(emoji)`** (regression-critical). Touch: **long-press 500ms** on pill opens the panel; short tap still toggles. Emit an `onOpenDetails(messageId, emoji?)` callback upward. → edges: reads M4 data; calls up to M7.
- **M6 `web/src/components/ReactionDetailsPanel.svelte`** (NEW) — portaled top-layer popover via `web/src/lib/portal.js`, `position: fixed` from anchor `getBoundingClientRect()`, `z-index ≥ 250` (ContextMenu = 200). Selectable emoji list (emoji + count + self-marker); selected-emoji user list (resolved names, "You" in natural order); keyboard nav + focus trap + Esc + click-outside close; if the selected emoji vanishes (last remover) select next or close. → edges: receives reactive `users[]` per emoji + resolver + anchor rect + open/close state from M7.
- **M7 wiring — `web/src/components/MessageBubble.svelte`** (and/or `MessageGroup.svelte` — find where ReactionBar is mounted): thread `users`/resolver into M5; own the panel open/close + selected-message/emoji state; render M6. → edge: connects M4 → M5/M6.

### Tests
- **M8 vitest**: store — `users` accumulate/dedup, count/active DERIVE, optimistic-self + ignored-echo, hydration snapshot+buffered-replay WITH a `remove` AND an `add` arriving mid-fetch (assert final membership), message-not-in-snapshot untouched, `resolveReactor` (self→"You", unknown→key, name-change reflected). ReactionBar — ≤3 names + `+N others`, a11y (focus shows tooltip, "See all" reachable), **pill-click-still-toggles regression guard**. Panel — emoji-switch, keyboard/Esc/click-outside, portaled z-index, selected-vanishes.
- **M9 pytest**: `build_reactions_route` 200 shape `{conversation, reactions:{mid:{emoji:[key]}}}` + 400 on bad conv id; `get_conversation_reactions` mirrors `get_all()`.

## Data flow
channel activate → M4 `#fetchHistory` + `#fetchReactions` (M3 → M2 → M1 `get_all()`) → snapshot+buffered-replay builds `users[]`; live reaction events keep `users[]` current → M5 renders pills + hover tooltip via `resolveReactor` → "See all" / long-press → M7 opens M6 → M6 reads the same reactive `users[]`.

## Build sequence
1. **M1 + M2 + M9** (backend REST) — independently verifiable via `curl /api/reactions/{conv}`.
2. **M3** (api helper).
3. **M4 + M8(store)** — the data layer; get this provably correct (hydration race tests) before UI.
4. **M5 + M7(bar wiring)** — tooltip.
5. **M6 + M7(panel wiring)** — panel.
6. **M8(component tests)**.
7. Gates: pytest + vitest + `pnpm build` + Svelte autofixer (SYNCHRONOUS) on every `.svelte`.

## Blast radius / risk
- Backend (M1/M2): purely additive route + fn — **low**.
- Store (M4): changes the reaction model + the two existing reaction paths (optimistic + remote) — **medium**; the regression guards (pill toggle works, count stays correct, live add/remove still render) are the safety net.
- ReactionBar (M5): additive tooltip/long-press, toggle preserved — **low-med**.
- New panel (M6): isolated — **low**.
- **Constraint:** ALL `.svelte`/`.svelte.js` edits go through the Svelte agent + synchronous autofixer (never a backgrounded autofixer).
