# @mention Autocomplete Revamp — Implementation Plan

**Status:** DRAFT (pre-review)
**Scope:** Replace the current blocking, ungroomed `@mention` dropdown with a non-blocking, ghost-suggesting, confirm-on-Tab autocomplete that visibly tracks targeting state.
**Goal:** Production-grade input UX that matches what users expect from Slack, Discord, GitHub, and Notion.

---

## Current state (audit)

`web/src/components/MessageInput.svelte` + `web/src/components/MentionDropdown.svelte`.

The current flow:

1. User types `@`
2. Regex `@([\w-]*)$` against `textBeforeCursor` triggers `showMentionDropdown = true`, sets `mentionQuery`
3. Dropdown renders a list of all participants in the channel (no online filter, no cap)
4. The dropdown captures keyboard focus — typing while it's open is awkward and frequently broken
5. On commit: `inputValue = beforeAt + '@' + name + ' ' + textAfterCursor` — note the **trailing space**
6. No metadata is preserved — the `@name` becomes plain text
7. The recipient resolution at send time relies on the server's name lookup against the channel members

**Symptoms Phil reported:**

- Dropdown shows all users, including offline
- Typing is blocked while dropdown is open (focus / event-capture issues)
- No best-match auto-highlight
- No max-results cap
- No ghost preview in the input
- No Tab-to-autocomplete
- Click works but arrow-key nav is iffy
- Auto-commit adds a trailing space → `@name ,` when user wants `@name,`
- No visual indication that a name has been "committed" as a target
- Backspacing into a committed `@name` doesn't re-trigger matching gracefully

---

## Design principles

1. **Non-blocking by default.** Typing always wins. The dropdown is a suggestion; never a modal.
2. **Confirmation is data, not just text.** Once a user commits a mention, we track its (start, end, key) range so we can render it specially and resolve recipients reliably even if the user adds punctuation around it.
3. **Reversible.** Every state transition (suggest → commit → edit → re-suggest) is fluid, no dead-ends.
4. **Visual feedback throughout.** The user always knows: "is this name currently committed as a target, or just typed text?"

---

## Architecture

### Layer 1 — Data model

`MessageInput.svelte` owns two pieces of reactive state (in addition to `inputValue`):

```js
// Confirmed mention tokens: each represents a (range, identity) pair
// The text under each range is the name; the key is the participant identity.
let mentionTokens = $state([]);  // Array<{ start, end, name, key }>
//   start: int, character index in inputValue where '@' is
//   end:   int, exclusive index where the name ends
//   name:  string, the display name committed
//   key:   string, the 8-hex participant key

// The currently-active suggestion context (if any)
let activeSuggestion = $state(null);
//   { atIndex: int,         // index of the '@' triggering this suggestion
//     query: string,        // text after @ up to cursor
//     candidates: [...],    // filtered, sorted, capped participant list
//     highlightIndex: int } // currently-highlighted candidate (default 0)
```

**Invariant:** every `@name` in `inputValue` either has a confirmed token covering it OR is a candidate for an active suggestion (if cursor is at its end).

### Layer 2 — Reactive parsing

A `$derived` watches `inputValue` + cursor position and computes:

- `mentionTokens` — pruned/updated based on text changes:
  - If a token's range is unchanged in text content → keep
  - If a token's range was deleted/overwritten → drop the token
  - If the user edited the name portion of a token (e.g., backspaced one char) → drop the token, re-trigger suggestion if cursor is at the end of an `@`-prefix
- `activeSuggestion` — set only if cursor is at the end of an `@…` prefix that isn't covered by a confirmed token

The active-suggestion candidate list filters/sorts:
1. **Online participants first** (`p.connections.length > 0`)
2. Then alpha by name
3. Filter by case-insensitive prefix match on the query (or fuzzy if query is non-empty)
4. **Cap at 7 visible**

### Layer 3 — Rendering (overlay pattern)

Native `<textarea>` does not support inline color spans, so we use the **overlay pattern** (industry standard — used by GitHub, Linear, Notion comments):

```
+--------------------------------------------------+
|  Overlay div (z-index: 0)                        |
|  - Mirrors textarea content character-for-char   |
|  - Renders confirmed mentions as colored spans   |
|  - Renders ghost-suggestion span at cursor       |
|  - position: absolute; pointer-events: none      |
+--------------------------------------------------+
+--------------------------------------------------+
|  Textarea (z-index: 1)                           |
|  - color: transparent                            |
|  - caret-color: var(--text-primary)              |
|  - background: transparent                       |
|  - Owns all input events, focus, undo, scroll    |
+--------------------------------------------------+
```

Both layers share identical font, padding, line-height, and scroll position. The textarea's computed text is invisible; the overlay shows the styled version.

**The dropdown** floats above the input as today, but with non-blocking changes (Layer 4).

### Layer 4 — Keyboard model (non-blocking)

The dropdown does **not** capture focus. The textarea always owns focus. The dropdown is a passive UI element keyed by `activeSuggestion`.

| Key | Behavior when `activeSuggestion` is active |
|---|---|
| Any printable char | Inserts into textarea normally; `query` updates; candidate list re-filters; `highlightIndex` resets to 0 |
| ↓ ArrowDown | Increments `highlightIndex` (clamped); textarea cursor unchanged |
| ↑ ArrowUp | Decrements `highlightIndex` (clamped) |
| **Tab** | Commits the highlighted candidate (see "commit semantics" below) |
| **Enter** | Same as Tab IF a candidate is highlighted; otherwise default newline behavior |
| Escape | Clears `activeSuggestion` (dismisses dropdown). Cursor unchanged. Re-typing `@` re-triggers. |
| Backspace | Normal text edit. Suggestion re-evaluates. |
| Click on candidate | Same as Tab on that candidate |

Critical: **none** of these block typing or other inputs. ArrowDown/ArrowUp do not move the textarea cursor while the dropdown is active — they only move the highlight. This is a deliberate trade (consistent with Slack/Discord). Use Esc + Arrow if you need to move the cursor in text.

### Layer 5 — Commit semantics

A commit happens via **explicit** or **implicit** triggers. Both produce the same end state.

#### Explicit triggers
- **Tab** with a highlighted candidate
- **Enter** with a highlighted candidate
- **Click** on a candidate in the dropdown

#### Implicit triggers (Tab is optional)

When the active suggestion's `query` is an **exact match** (case-insensitive) for a candidate's name, the system auto-commits without waiting for Tab. Three implicit triggers:

- **Word-terminator typed** (space, comma, period, semicolon, parens, `!`, `?`, `/`) immediately after an exact-match query → instant commit. The terminator becomes plain text after the token.
- **Idle debounce** — 200ms after the last keystroke with an exact match present → silent commit.
- **Cursor moves away** (arrow key, click elsewhere, focus blur) while an exact match is present → instant commit.

#### Visual coloring leads the formal commit by ~200ms

The overlay paints the matched range ember the moment exact-match is detected, even before the formal token is committed. This gives instant feedback. If the user types one more letter that breaks the match (e.g., `@claude-testa` when only `claude-test` exists), the color reverts and the dropdown re-evaluates. The formal token never gets committed in that case.

#### Send-time forced commit

Send handler runs `commitPendingIfMatch()` synchronously before building recipients. If there's a pending implicit match, it commits immediately (canceling the 200ms timer). What you see (ember-colored text) is what you send (routed mention).

#### Commit operation

When any trigger fires:

1. Identify the active `@…` range in `inputValue` from `activeSuggestion.atIndex` to the end of the partial query
2. Replace that range with `@{candidate.name}` (no trailing space, no period, no comma — just `@name`)
3. Add a new entry to `mentionTokens` for this range: `{ start: atIndex, end: atIndex + 1 + name.length, name, key }`
4. Move the cursor to immediately after the committed text
5. Clear `activeSuggestion` and the debounce timer

The user can now type a comma, space, period, anything — the token's range is fixed and stays correct.

#### Esc cancels pending implicit commit

Esc clears `activeSuggestion` AND the debounce timer. The text stays as plain text (no token created). Re-typing `@` re-triggers suggestion.

### Layer 6 — Re-targeting on edit

If the user backspaces or types into a confirmed token's range:

1. The character mutation is detected by the `$derived` parsing pass
2. The token is **invalidated and removed** from `mentionTokens`
3. If the cursor is at the end of an `@…` prefix after the edit, a new `activeSuggestion` spins up with the current partial as query
4. The dropdown reappears with re-filtered candidates
5. User can commit a new match (or different match) via Tab

This is the "non-blocking smooth re-targeting" Phil specified.

### Layer 7 — Send-time recipient resolution

When the user hits Send, `MessageInput.svelte`:

1. Walks `mentionTokens` to collect the keys of all confirmed mentions
2. Passes that key array as `recipients` in the `comms_send` MCP call
3. Strips the `@name` text from the body? **No.** Keep it in the body for human readability — the server will see the recipients and prefix accordingly. (Need to confirm: does the server's existing logic skip prefix-add if the body already contains `@name`? Check & adjust.)

If the user types `@name` but never commits via Tab (e.g., Escape'd the dropdown), no recipient is added. The text is just plain text. This is correct fallback behavior.

---

## UX behaviors enumerated (Phil's 11 asks, addressed)

| # | Phil's ask | Plan addresses it via |
|---|---|---|
| 1 | Filter by online status | Layer 2 candidate sort — online first, then alpha. (Decision: online + offline both shown, online first; we can refine to online-only if Phil prefers — see Open Question 1) |
| 2 | Non-blocking typing | Layer 4 keyboard model — textarea always owns focus, dropdown is passive |
| 3 | Auto-highlight best match | Layer 2 — `highlightIndex` defaults to 0 (first candidate after filter+sort) |
| 4 | Max number of suggestions | Layer 2 — cap at 7 |
| 5 | Ghost preview in input bar | Layer 3 overlay — `<span class="ghost-suggestion">` shows the unentered remainder of the highlighted candidate at the cursor position, faint italic styling |
| 6 | Tab to autocomplete (Tab is OPTIONAL) | Layer 4/5 — Tab commits explicitly. Implicit commit also triggers on word-terminator, 200ms debounce, or cursor-move-away when an exact match is present. Visual ember coloring leads the formal commit by ~200ms. |
| 7 | Click OR arrow keys | Layer 4 — both supported, click via dropdown's pointer events, arrows via textarea's keydown handler |
| 8 | Auto-complete shouldn't add trailing space | Layer 5 commit — replace range with exactly `@{name}`, no trailing whitespace |
| 9 | Ability to backspace into and edit a committed mention | Layer 6 — token invalidates on edit, suggestion re-spins |
| 10 | Different color for confirmed mentions | Layer 3 overlay — `<span class="mention-confirmed">` with ember accent or distinct color |
| 11 | Re-target on edit, smooth & non-blocking | Layer 6 — token invalidate + suggestion re-spin happens in the same `$derived` pass; no dialog, no blocking |

---

## Component breakdown

### Files to modify

- `web/src/components/MessageInput.svelte` — orchestrator; owns state + cursor tracking + key handlers + send
- `web/src/components/MentionDropdown.svelte` — pure presentational; receives `candidates`, `highlightIndex`, `onHover`, `onClick`; emits no keyboard events (handled by parent)

### Files to create

- `web/src/lib/mentions.js` — pure helper module (no runes), exports:
  - `parseMentions(text, mentionTokens, cursor)` → `{ mentionTokens (updated), activeSuggestion or null }`
  - `filterCandidates(participants, query, currentUserKey)` → sorted+capped candidate list
  - `commitMention(text, mentionTokens, atIndex, queryEnd, candidate)` → `{ text, mentionTokens, newCursor }`
  - All pure functions; deterministic; easy to unit test

- `web/src/components/MentionOverlay.svelte` (or inline in MessageInput) — the overlay div that mirrors textarea content with colored mention spans + ghost-suggestion span

### Tests added

- `web/tests/mentions.spec.js` — unit tests for `parseMentions`, `filterCandidates`, `commitMention`:
  - Insert `@cl` at end → triggers suggestion with `query="cl"`
  - Type `@claude-test` then Tab on highlighted match → token created, cursor at end, no trailing space
  - Backspace one char into committed token → token invalidated, suggestion re-spins with shorter query
  - Online participants ranked first
  - Cap at 7 candidates
  - Edit inside committed token (cursor in middle, type a letter) → token invalidated
  - User typing right after committed `@name` (e.g., `,`) → token preserved

- `web/tests/mention-input.spec.js` — component-level tests via @testing-library/svelte:
  - Tab commits highlighted suggestion, no trailing space
  - ArrowDown/Up moves highlight, doesn't move text cursor
  - Click on candidate commits it
  - Esc dismisses dropdown without committing
  - Send with committed token → `recipients` array contains the right key

---

## Edge cases & failure modes

1. **Multiple `@` in input** — only the one at the cursor (or being edited) becomes the active suggestion. Confirmed tokens elsewhere stay untouched.
2. **`@` followed by space (no name)** — no suggestion; user can type a name later or it stays as plain text.
3. **Name with hyphen / special chars** — current regex `[\w-]+` covers hyphens. We extend to also accept `.` since participant names allow them per the broader naming rules. We do NOT accept space — `@two words` is two separate tokens. (Slack handles this correctly.)
4. **Same name appears twice in input** — each `@name` is its own token. Confirming one doesn't affect the other.
5. **Participant goes offline mid-compose** — token already committed, key stored. Send still routes correctly. Dropdown re-filters live in Layer 2 if user opens a new suggestion.
6. **User edits inputValue programmatically** (e.g., paste) — `$derived` re-runs full token parse against the new text. Tokens whose ranges/text don't survive are dropped.
7. **Overlay/textarea drift** (line-wrap differences, scroll desync) — common gotcha. Mitigation: identical CSS box model (font, line-height, padding, border-box, white-space: pre-wrap, overflow). Sync `scrollTop` from textarea to overlay on scroll events.
8. **IME composition** (CJK input) — don't fire suggestion logic during `compositionstart`/`compositionupdate`; only on `compositionend`. Otherwise we'd thrash candidates while the user is mid-character.
9. **Mobile / touch** — Tab key isn't standard on phone keyboards. Allow tap on a candidate as the universal commit.
10. **Empty channel (no participants)** — dropdown shows empty state ("No members to mention").
11. **Self-mention** — by default, exclude the current user from candidates (typing `@phil` as Phil shouldn't suggest yourself). Phil can still type it manually if for some reason they want.

---

## Accessibility

- Dropdown gets `role="listbox"`, candidates `role="option"`, `aria-selected` on highlight
- Textarea exposes `aria-activedescendant` pointing to the highlighted candidate's id (lets screen readers announce the highlight without moving focus)
- Ghost-suggestion span gets `aria-hidden="true"` so screen readers don't read partial text
- Confirmed mention spans get `aria-label="mentioning {name}"`
- All keyboard behaviors documented in Layer 4 covered by axe-core scan

---

## Implementation order (single batch, ~45 min)

1. **`lib/mentions.js`** — pure helpers + unit tests
2. **`MentionOverlay.svelte`** (or overlay inline) — visual mirror with mention/ghost spans
3. **`MentionDropdown.svelte`** — strip its own keyboard handling, accept `highlightIndex` prop, emit `onHighlight` and `onCommit` events. Add `aria-` attributes and online indicator dots.
4. **`MessageInput.svelte`** — wire it all together: state, parsing effect, key handlers, commit logic, send-time recipient resolution
5. **Tests** — `mentions.spec.js` (logic) + `mention-input.spec.js` (component)
6. **Run `svelte-autofixer`** on every Svelte file until clean
7. **Build + test verification**

## Risks

- **Overlay drift on resize/zoom** — mitigated by shared CSS but a known fragility. We test at multiple viewport widths.
- **Token-survival heuristic on programmatic text changes** — paste, drag-drop, browser autofill could produce edge cases. We accept that pasted `@name` strings won't be auto-detected as tokens; user can re-trigger via cursor-at-prefix.
- **Tab conflict** — Tab is also the natural focus-shift key. While the dropdown is open, Tab commits; while it's closed, Tab moves focus normally. We must ensure the keydown handler only intercepts Tab when `activeSuggestion !== null`.

## Open questions

1. **Online-only or online-first?** My recommendation: **online-first, offline below** — let Phil mention an offline user if needed (e.g., when they come back, they see the targeted message). But online-only is also valid if Phil prefers strict pruning. **Default in plan: online-first (recommend), confirm or override.**
2. **Mention color** — recommend `var(--ember-300)` for confirmed tokens (matches the app's primary accent). Approve or pick something else.
3. **Ghost-suggestion styling** — recommend `color: var(--text-faint); font-style: italic`. Approve or pick.
4. **Cap of 7 candidates** — recommend 7. Could be 5 or 10. Approve or pick.
5. **Re-trigger on click in middle of confirmed token** — when user clicks the cursor into the middle of `@claude-test`, do we immediately invalidate the token (since they're "editing" by intent)? Or only invalidate on actual character mutation? **My recommendation: only on character mutation** — clicking the cursor in shouldn't break a token until the user actually types. Confirm or override.

---

## Out of scope (for this PR)

- Mention notifications (separate from mention rendering)
- Cross-conversation mentions (`@user` in channel A pointing to user not in channel A)
- Mention rendering in **received messages** (this plan only covers compose; received messages already render mentions in chat bubbles per existing logic)
- Voice command "say at-claude-test" — not happening
