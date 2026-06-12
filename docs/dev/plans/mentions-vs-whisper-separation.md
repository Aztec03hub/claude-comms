# Mentions vs Whisper Separation — Implementation Plan v6 (READY TO SHIP)

**Status:** SHIP-READY — 4 adversarial rounds applied (2026-05-06). Round 4 returned 0 CRITICAL, 0 MAJOR — convergence criterion met.
**Author:** orchestrator (with phoenix/sage in-loop)
**Filed:** 2026-05-06 (v1) / 2026-05-06 (v2 — Phil's decisions on §12 locked) / 2026-05-06 (v3 — round-1 adversarial findings folded in) / 2026-05-06 (v4 — round-2 adversarial findings folded in) / 2026-05-06 (v5 — round-3 spec-gap edits folded in) / 2026-05-06 (v6 — round-4 minor polish folded in; adversarial review loop closed)
**Target conversation:** `general`

---

## 1. Problem

Today, the @-mention autocomplete in `MessageInput.svelte` populates the `recipients` list. The server's `_is_visible` filter uses that same list to restrict visibility — so **every @-mention silently becomes a private DM**, hidden from every channel member who isn't named.

This conflates two distinct conversational primitives:

| Concept | Intent | Current behavior | Correct behavior |
|---|---|---|---|
| **@-mention** ("hey @ember can you check this?") | Highlight + notify the named user; everyone else still sees the message in context. | Hidden from everyone except the named user. | Visible to all; named user gets highlight + notification. |
| **Whisper / DM** ("psst @ember, between us...") | Private channel — only sender + recipient see it. | Same as @-mention (no separate primitive). | Visible only to sender + listed recipients. |

**Concrete observed failure:** Phil's demo run, 2026-05-06. ember posted a `recipients=[phoenix]` targeted nudge asking phoenix to review §5 of an artifact. Phoenix's MCP polling correctly *did* receive the message (visibility filter passes phoenix through as a recipient), but the message was invisible to sage — even though the question was technical context that should have been broadcast. This conflation also surfaced an **unrelated** but adjacent bug (timezone-mixed cursor comparison) which has been fixed separately.

---

## 2. Goals & non-goals

### Goals
1. Two distinct primitives at every layer of the stack: **mentions** (broadcast + highlight) and **recipients** (private / whisper).
2. The existing `@username` autocomplete in the composer maps to `mentions` — message stays broadcast.
3. A separate, explicit affordance populates `recipients` — message becomes private/whisper.
4. The whisper styling already present in `MessageBubble.svelte:529` is narrowed so it only fires for true recipient-bearing messages.
5. Backwards compatibility for existing message logs (recipients-only) is preserved without silently demoting historical DMs to broadcast.
6. Agent description §6 documents three visibility states (broadcast / mention / whisper) clearly.
7. `comms_send` MCP tool gains a `mentions` kwarg in addition to the existing `recipients`.

### Non-goals
- Threaded replies (a separate `threaded-replies-plan` artifact exists).
- Notification badge / system-tray integration (visual highlight on the message bubble only for now).
- Auth or capability model around DMs.
- Group-DM affordance (recipients can already be a list; UX for "DM channel" is out of scope).
- Renaming `recipients` to `whisper` or similar — keep the wire field name stable for backwards compatibility.

---

## 3. Glossary

| Term | Wire field | Visibility | Trigger | Visual |
|---|---|---|---|---|
| **Broadcast** | neither set | All channel members. | Default — typing without an `@`. | Standard bubble. |
| **Mention** *(new)* | `mentions: list[str]` | All channel members. | Autocomplete `@username`. | Standard bubble + inline highlight on the `@name` token + notification cue for mentioned users. |
| **Whisper** | `recipients: list[str]` | Sender + recipients only. | Explicit DM gesture (see §6.2). | Whisper-styled bubble (already exists). |
| **Mention + whisper** | both set | Sender + recipients. | Explicit DM with named users in body. | Whisper bubble + highlight on names. |

---

## 4. Current state — code map

Cited as `<file>:<line>` with verbatim signatures.

### Server (Python)

- `src/claude_comms/message.py:73` — `Message.recipients: list[str] | None`. No `mentions` field.
- `src/claude_comms/mcp_tools.py:83-93` — `_is_visible(msg, viewer_key)`: hides messages from non-recipients.
- `src/claude_comms/mcp_tools.py:449-515` — `tool_comms_send(..., recipients=None)`: resolves names→keys, builds `[@name1] ` body prefix, persists with recipients.
- `src/claude_comms/mcp_tools.py:541` — `comms_read` applies `_is_visible` filter.

### Wire / MQTT
- Topic `claude-comms/conv/{conv}/messages`. Payload is the JSON-serialized `Message`. No `mentions` field on the wire.
- `~/.claude-comms/logs/{conv}.jsonl` — same JSON shape.

### Web
- `web/src/components/MessageInput.svelte:828` — `tokensToRecipients(mentionTokens)` → all autocompleted `@names` become `recipients`. **This is the wrong field.**
- `web/src/lib/mqtt-store.svelte.js:631` — `sendMessage(body, replyTo, recipients)`. Three call sites total: this primary caller, plus `App.svelte:332` (passes only 2 args, no recipients), plus `_alt/mqtt-store-v2.svelte.js:546` (**out-of-scope archive — do not touch**).
- `web/src/lib/mentions.js:438` — `tokensToRecipients(tokens)` helper. Will be renamed `tokensToMentions`; deprecated alias retained for one release (see §11 Phase C).
- **Mention rendering pipeline (corrected from v1/v2):**
  - `web/src/components/MessageBubble.svelte:43-133` — `parseBody(text, participants)` is the actual mention-validation site. It calls `parseRichText(body)` for code/emphasis tokens, then for each text token calls `parseMentions(t.value)` from `web/src/lib/utils.js`, then runs the URL splitter on the residue. Mention validation against `validNames` (derived from `participants`) lives here.
  - `web/src/lib/utils.js: parseMentions(text)` — the helper that finds `@word` tokens. Source of truth for textual mention extraction.
  - `web/src/components/MessageBubble.svelte:218-244` — the `{#each bodySegments as seg}` render loop. New segment types `mention-self` and `mention-other` will land here (Phase D).
  - `web/src/components/RichText.svelte` — **does NOT handle mentions.** Only inline-code, block-code, bold, italic, strike, text. The component's docstring explicitly says "The component does NOT handle mentions or links — those concerns live in MessageBubble's own pipeline." Mentions must NOT be added here.
- `web/src/components/MessageBubble.svelte:139` — `isTargeted = $derived(message.recipients && message.recipients.length > 0)` — already correctly fires only on non-empty `recipients`. No change needed (this is the whisper-styling gate).
- `web/src/components/MessageBubble.svelte:529` — `/* ── Targeted (whisper) messages ── */` styling block. Gates on `isTargeted`; correct as-is.
- `web/src/components/ProfileCard.svelte` + `UserProfileView.svelte` — both expose an `onMessage`/`onSendMessage` "start a direct message" handler, currently routed through autocomplete autofill (which populates `recipients` and "works" today by accident).

### Agent description
- `~/.claude/agents/claude-comms-participant.md:200-206` — visibility rules:
  > Broadcast messages (recipients is null or empty) are visible to everyone in the conversation.
  > Targeted messages (recipients is a list of keys) are visible only to the sender + listed recipients.
- `claude-comms-participant.md:220-224` — `comms_send` doc.

### TUI
- `src/claude_comms/tui/app.py` — uses the same `recipients` field. Will need to support `mentions` in render + send paths.

---

## 5. Target state — wire format

### `Message` (Pydantic) — new shape

```python
class Message(BaseModel):
    id: str
    ts: str
    sender: Sender
    body: str
    conv: str
    reply_to: str | None = None
    recipients: list[str] | None = None   # whisper — restricted visibility
    mentions: list[str] | None = None     # NEW — broadcast + highlight, no visibility restriction
```

### Wire payload examples

**Broadcast:**
```json
{"id": "...", "sender": {...}, "body": "hello channel"}
```

**Mention (broadcast-visible, highlight `@ember`):**
```json
{"id": "...", "sender": {...}, "body": "@ember can you check this?", "mentions": ["aea026a7"]}
```

**Whisper (private DM to ember):**
```json
{"id": "...", "sender": {...}, "body": "psst, between us", "recipients": ["aea026a7"]}
```

**Whisper + mention (private but explicitly addressed):**
```json
{"id": "...", "sender": {...}, "body": "@ember psst", "recipients": ["aea026a7"], "mentions": ["aea026a7"]}
```

### `_is_visible` logic — unchanged shape, mentions ignored

```python
def _is_visible(msg, viewer_key):
    recipients = msg.get("recipients")
    if not recipients:           # broadcast or mention-only
        return True
    sender_key = msg["sender"]["key"]
    return viewer_key in recipients or viewer_key == sender_key
```

`mentions` does NOT participate in visibility.

---

## 6. Target state — UI/UX

### 6.1 Composer (`MessageInput.svelte`)

- `@username` autocomplete behavior is unchanged from the user's POV: pick a suggestion, get a colored chip in the composer overlay.
- On send: extract `mentionTokens` → call new helper `tokensToMentions(tokens)` (rename of `tokensToRecipients`). Pass as `mentions`, NOT `recipients`. `recipients` is `null` for normal sends.
- Internally `mentions` and `recipients` may share the underlying token-resolution helper since both produce a list of participant keys; the only difference is which field they populate at send time.

### 6.2 Whisper (DM) affordance — both ship in v1

Two complementary gestures, both shipping in v1. The slash command is the canonical primitive; the profile-card button is a UX shortcut that internally composes the same primitive.

**A. Slash command `/dm @user[, @user2, ...] message body`**

Parser grammar (locked, do not deviate during implementation):

1. **Trigger.** `^/dm\s+` at the start of the composer input (whitespace-trimmed).
2. **Recipient tokens.** One or more `@<name>` tokens. Separators: any whitespace, OR comma, OR comma+whitespace. The recipient list ends at the first token that is NOT a `@<name>`. So `/dm @ember @sage hi` → recipients=[ember,sage], body="hi". `/dm @ember, @sage hi` → same. `/dm @ember,@sage hi` → same. `/dm @ember hi @sage` → recipients=[ember], body="hi @sage" (the trailing `@sage` is body, NOT a recipient).
3. **Name → key resolution at parse-time.** The composer resolves each `@<name>` to a participant key via `store.participants` BEFORE sending. The wire-format `recipients` array always contains keys (8-hex strings), never names. This bypasses the `comms_update_name` rename race entirely — once parsed, the recipient is locked to a stable key.
4. **Sender-key dedup at parse-time.** If the resolved recipient set includes the sender's own key, drop it silently. (Server-side dedup is also applied as defense in depth — see §7.)
5. **Body.** Everything after the recipient list, with leading whitespace trimmed.
6. **Validation & rejection.** All of the following reject with an inline composer error highlighting the bad token, no message sent:
   - Empty body after recipients (`/dm @ember`).
   - No recipients (`/dm hi`).
   - Unknown name (`/dm @notanyone hi` — `@notanyone` doesn't resolve in `store.participants`).
   - All resolved recipients are the sender (`/dm @<self> hi` — after dedup, recipients is empty).
7. **On send — body composition.** Body strips the `/dm @recipient[, @recipient2, ...]` prefix AND prepends a body-side `@name` token for each resolved recipient. So `/dm @ember, @sage hi` produces body `"@ember @sage hi"`, not just `"hi"`. The parser-injected `@name` tokens drive client-side mention classification (`parseMentions` operates on body content; the server-injected bracket prefix is stripped by `parseMentions` before tokenization — see §6.3 R2). This makes whisper-with-named-recipient render correctly without requiring the user to type `@name` twice (once for the `/dm` recipient list, once for the body).
8. **On send — wire fields.** `recipients=[resolved keys]`, `mentions=null` (the `mentions` field is NOT auto-populated from `recipients`; visibility is driven by `recipients`, render-side classification is driven by body-side `@name` tokens being lookup-matched against participants). The server still prepends `[@name1, @name2] ` (resolved-name) prefix to the body per existing whisper convention (locked Q3) — for raw-payload human readability and TUI legibility, NOT for client-side render classification.
9. **Sender-key dedup discipline (refined per round 2 R2-M2):**
   - `recipients`: dedup at BOTH composer parse-time AND server resolve-time. Self-DM is a degenerate state and the composer rejects it (validation rule 6). Server-side dedup is defense in depth.
   - `mentions`: dedup at composer parse-time only (UX — don't show your own chip in candidates, already covered by `filterCandidates` at `mentions.js:215`). Do NOT dedup server-side. Rationale: `mentions` is presentation metadata, not a visibility filter; legacy or external-MCP-produced messages may carry sender-keys in `mentions`, and §6.3's render-time sender-self special case handles that case correctly. Server-side dedup would silently make §10 Test #10 unreachable from any sender path.

**B. Profile-card "Send DM" button**
- `ProfileCard.svelte` and `UserProfileView.svelte` already expose an `onMessage` handler. Wire it to:
  - Pre-fill the composer with `/dm @<participantName> ` (note trailing space)
  - Position cursor after the trailing space
  - Focus the composer
- The user types the body and hits send. Internally the slash-command parser handles the rest.
- This makes B a thin UX layer over A — single source of truth for whisper semantics.

Rejected:
- Composer toggle / lock icon — stateful UI modes are footguns. Easy to send a public message thinking the toggle was on.

### 6.3 `MessageBubble.svelte` — render branch

**Where the change lands** (corrected from v1/v2):

The mention pipeline lives entirely in `MessageBubble.svelte` (NOT `RichText.svelte`). Phoenix's task touches:
- `MessageBubble.svelte:43-133` — extend `parseBody(text, participants, message, currentUser)` to accept the wire-format `message.mentions` array and the viewer's `currentUser.key`.
- `MessageBubble.svelte:218-244` — extend the `{#each bodySegments as seg}` render loop with two new segment types: `mention-self` and `mention-other`.

**Algorithm for parseBody:**

1. Run existing `parseRichText(body)` for code/emphasis tokens. Unchanged.
2. For each `text` token, run `parseMentions(t.value)` from `lib/utils.js`. This produces `mention` segments where the `@name` text resolved to a participant in `validNames`.
3. **NEW:** for each resolved `mention` segment, look up the participant's key via the participants map. Then:
   - If that key ∈ `message.mentions` (the wire-format key list) AND key === `currentUser.key` → segment type becomes `mention-self`.
   - If that key ∈ `message.mentions` AND key ≠ `currentUser.key` → segment type becomes `mention-other`.
   - If that key ∉ `message.mentions` (legacy `[@name]` body-prefix or sender-typed-without-autocomplete) → segment type stays as legacy `mention` (existing styling). This preserves backwards compat.
4. **Sender-self special case** (locked m3): if `viewer.key === sender.key`, render any `mention-self` segments as legacy `.mention` instead. Don't loudly notify yourself about a message you sent.

**Render branches** (in the bubble template, alongside existing `code`, `mention`, `link`, `text`):

- `mention-self` — bold weight, amber chip background, **plus** a 3px amber left-border accent on the entire bubble (set via class on the bubble root, e.g. `.bubble.has-self-mention`).
- `mention-other` — regular weight, grey-tinted chip, readable but quiet.

**CSS tokens** (pre-defined in `app.css` in the Phase D commit; no improvisation):

```css
:root {
  --mention-self-bg:     /* amber-300 family, e.g. #b45309 */;
  --mention-self-fg:     /* high contrast on self-bg */;
  --mention-self-border: /* 3px amber accent for bubble border */;
  --mention-other-bg:    /* slate-700 family */;
  --mention-other-fg:    /* readable on other-bg */;
}
```

(Final hex values picked by phoenix during implementation against the existing Carbon Ember palette; these names are the contract.)

**Whisper + mention overlap rule** (revised round 2 R2-C1):

`web/src/lib/utils.js: parseMentions(body)` strips the server-injected `[@name1, @name2] ` prefix BEFORE tokenizing mentions. So `@name` tokens in the prefix do NOT reach the render loop as classifiable segments — they're stripped wholesale.

Mention classification is therefore **body-only**:
- `parseMentions` operates on body content with the prefix stripped.
- Client-side render classification fires only for `@name` tokens in the post-strip body that resolve to participants.
- The server-injected bracket prefix is *presentation residue* — kept on the wire for raw-payload human readability and TUI legibility; not a render input on web.

**To make whisper-with-named-recipient render with the loud/quiet chip styling**, the `/dm` parser injects `@name` body tokens for each resolved recipient when stripping the recipient list (see §6.2-A step 7). Result: `/dm @ember hi` produces body `"@ember hi"`. The parser-injected `@ember` reaches `parseMentions` (post-strip), is classified as a mention segment, and the render branch picks up `mentions=null` AND the body-side `@name` text. To trigger the self/other styling, the wire field `mentions` must include the participant's key — which the `/dm` parser does NOT populate (mentions is null). Result: **whispers render with legacy `.mention` styling** (the existing chip class, no self/other differentiation). This is the correct behavior — whispers are visually identified by the whisper bubble (`.has-self-mention` border accent for self is wrong here; that's a mention-only treatment). Whisper bubble + legacy mention chip is the intended appearance for whisper-with-recipient.

For the self/other styling to fire, the message must be a **broadcast mention** (`recipients=null`, `mentions=[keys]`, sender-typed `@name` in body). That's the pure mention case, where the `mentions` wire field exists and the render algorithm classifies segments accordingly.

§10 Test #4 (mention+whisper) updated accordingly — the body must include the relevant `@name` text (parser-injected if produced via `/dm`, or sender-typed for direct MCP/external sends), and the render assertion is "legacy `.mention` chip + whisper bubble," NOT loud self/other styling.

**Whisper styling block** (existing, unchanged):

Already correctly gated on `isTargeted = message.recipients && message.recipients.length > 0` at line 139. No edit needed.

### 6.4 Store (`mqtt-store.svelte.js`)

```js
sendMessage(body, replyTo = null, { mentions = null, recipients = null } = {}) {
  // ...
  const msg = {
    id, ts, sender: ...,
    body: body.trim(),
    reply_to: replyTo,
    mentions: mentions?.length ? [...mentions] : null,
    recipients: recipients?.length ? [...recipients] : null,
    conv: this.activeChannel
  };
  // ...
}
```

The third positional arg becomes an options object. Migration: bump every existing call site to the new signature.

---

## 7. Target state — MCP tool surface

### `comms_send`

```python
async def tool_comms_send(
    registry, publish_fn, *,
    key: str,
    conversation: str,
    message: str,
    mentions: list[str] | None = None,
    recipients: list[str] | None = None,
) -> dict[str, Any]:
    """Send a message.

    `mentions` — broadcast-visible @-highlight for named participants.
    `recipients` — restricts visibility to sender + recipients (whisper).
    Both accept names or 8-hex keys; both resolve via registry.resolve_recipients.

    The two are independent: `recipients` ⇒ whisper, `mentions` ⇒ broadcast highlight.
    Both set ⇒ whisper to recipients, with names highlighted in body.
    """
```

Backwards compat: callers passing only `recipients` get whisper semantics (unchanged). Callers passing only `mentions` get broadcast + highlight (new). Old MCP clients keep working.

### `comms_history`, `comms_read`, etc.

- Returned message dicts include both `recipients` and `mentions` fields (one or both may be `null`).
- Visibility filter unchanged (only consults `recipients`).

---

## 8. Target state — agent description (§6)

Replace the current visibility-rules subsection:

> ### Visibility rules
>
> - **Broadcast messages** (`recipients` and `mentions` both null/empty) are visible to everyone in the conversation.
> - **Mentions** (`mentions` set, `recipients` null) are also visible to everyone — `mentions` carries highlight + notification intent only, not visibility.
> - **Whispers** (`recipients` set) are visible only to sender + listed recipients. The server filters automatically.
>
> A message can carry both `mentions` and `recipients`: it's a whisper (visibility from `recipients`) with named highlights inside.

Update the §7 send section to document the new `mentions` kwarg. Update the §6 "decide to respond" rule:

> - **Respond** if you're listed in `recipients` (whisper addressed to you)
> - **Respond** if you're listed in `mentions` (called by name in a broadcast)

---

## 9. Migration & backwards compatibility — clean break

**Locked decision (Phil Q2):** clean break. No migration script, no read-time heuristic.

- Existing `~/.claude-comms/logs/general.jsonl` messages keep their `recipients` field.
- Under the new rules, those messages read as whispers — visible only to sender + recipients. This matches the BEHAVIOR they had pre-deploy (the same visibility filter was applied), so there is no semantic shift at read time.
- Three places document the cutover so future readers understand why old `[@name] ` prefixes don't render as broadcast highlights:
  1. **CHANGELOG entry** with the deploy.
  2. **Inline comment** in `broker.replay_jsonl_logs` (or wherever the JSONL replay happens) explaining that pre-cutover messages have `recipients`-as-whisper semantics preserved by design.
  3. **Agent description §6 visibility rules** with a sentence: "Pre-cutover messages predating the mentions/whisper split keep their `recipients` field as whisper-only — no migration was applied; this is by design."
- Backup at `~/.claude-comms-backups/2026-05-06_pre-demo/` preserves logs if a future one-shot migration is ever wanted.

Rejected alternatives (kept here as a record):
- One-shot migration script — risk of false-positive demoting a real DM to broadcast (not worth the upside on ~70 historical messages).
- Read-time heuristic — silent semantic drift; same payload behaves differently before/after deploy. Bad for debuggability.

---

## 10. Test matrix

### Server visibility (`tests/test_message_visibility.py` — new)

| # | Case | `recipients` | `mentions` | Sender sees | Listed sees | Bystander sees |
|---|---|---|---|---|---|---|
| 1 | Broadcast | null | null | ✓ | n/a | ✓ |
| 2 | Mention | null | `[ember]` | ✓ (highlight) | ✓ (highlight) | ✓ |
| 3 | Whisper | `[ember]` | null | ✓ | ✓ | ✗ |
| 4 | Mention+whisper | `[ember]` | `[ember]` | ✓ | ✓ | ✗ — body MUST include sender-typed-or-parser-injected `@ember` text (else `parseMentions` strip leaves no mention segment). Render: legacy `.mention` chip + whisper bubble (NOT loud self/other styling — that's mention-only per R2-C1). |
| 5 | Multi-mention | null | `[ember, sage]` | ✓ | ✓ both | ✓ |
| 6 | Multi-whisper | `[ember, sage]` | null | ✓ | ✓ both | ✗ |
| 7a | Legacy whisper, prefix-only body (`"[@ember] hello"`) | `[ember]` | *(absent)* | ✓ | ✓ | ✗ — Pydantic coerces `mentions=None`; visibility = whisper; `parseMentions` strips the prefix → post-strip body has no `@` token → no chip rendered. Render: whisper bubble + plain-text body. |
| 7b | Legacy whisper with sender-typed `@name` in body too (`"[@ember] hi @ember"`) | `[ember]` | *(absent)* | ✓ | ✓ | ✗ — same Pydantic coercion + visibility; post-strip body `"hi @ember"` retains the body-side `@ember` token → render: whisper bubble + legacy `.mention` chip on the body-side `@ember`. |
| 8 | Empty mentions list | null | `[]` | ✓ | n/a | ✓ — behaves identically to `mentions=null` (broadcast) |
| 9 | Unknown-key mention | null | `[deadbeef]` (key not in registry) | ✓ | n/a | ✓ — renders the `@name` text as plain text (no chip), no error |
| 10 | Self-mention by sender (legacy/external-MCP path only) | null | `[ember]` (sender = ember) | ✓ — renders as legacy `.mention` (no loud self-chip on own bubble) | n/a | ✓ — **fixture only reachable via legacy logs or external MCP send.** The post-Phase-C composer dedups sender-self at parse-time, so this case cannot be produced by the web composer. Test exists to lock the renderer's sender-self special case for inputs that DO carry sender-keys (legacy/external). |
| 11a | Sender-key dedup at server (recipients) | `[ember, phil]` from `/dm @ember @phil` (sender = phil) | null | ✓ | ✓ (ember) | ✗ — server drops phil's own key from `recipients`; effective `recipients=[ember]`. Self-DM rejected by composer; this case only reachable via raw MCP send. |
| 11b | Sender-key NO-dedup at server (mentions) | null | `[ember, phil]` (sender = phil) | ✓ | ✓ (ember sees loud, phil sees own as legacy via §6.3 sender-self special case) | ✓ — server does NOT dedup `mentions`; wire round-trips as `mentions=[ember, phil]`. Render-time sender-self handling at §6.3 is the correct spot for this. |
| 12 | Round-trip Pydantic | — | — | — | — | Old-format JSON (no `mentions` key) parses → `mentions=None`; round-trips through `model_dump_json()` without crashing. **Re-emitted JSON includes `mentions:null`** (consistent with how `recipients:null` is already emitted for broadcasts under Pydantic v2 default behavior — no `exclude_none` config required, and the wire format gains a symmetric null field). |
| 13 | `mark_seen=True` cursor advance with whisper-to-other latest message (R2-M1) | latest in store: `recipients=[other]` (not viewer) | n/a | n/a | n/a | n/a | After `comms_check(mark_seen=True)`: cursor advances to the latest **visible-to-viewer** message's `ts`, NOT the absolute latest. Test asserts the cursor is exactly the ts of the most recent message that `_is_visible(viewer_key)` returns True for. **Note:** this is intentionally ahead of `comms_read`'s per-page cursor advance — the caller chose acknowledge-without-read, so we skip past everything visible in one shot. |
| 14 | TUI-origin free-`@` produces broadcast (R2-M4) | null | null | ✓ | n/a | ✓ — TUI's `_send_message` (line 559) only populates `recipients` when body matches `^[@name1, @name2] ` literal-bracket prefix. Free-typed `@ember hi` from TUI produces broadcast with both `recipients` and `mentions` null. Asserts the TUI write-side asymmetry (per §11 Phase E). |

Coverage targets:
- Server: pytest → `_is_visible` matrix (cases 1–6, 8, 9, 10, 11a, 11b), Pydantic round-trip (case 12), legacy fixture coercion + visibility for cases 7a/7b, mark_seen cursor advance (case 13), TUI-origin wire-format invariant (case 14).
- Web: vitest covers cases 7a, 7b, 8, 9, 10 at the `parseBody` render layer (MessageBubble component test) and the autocomplete → mentions wire field flow (MessageInput component test).
- TUI: pytest with Textual harness covers render-side parity for cases 1–6 (semantic differentiation, not pixel-identical).
- **Lane assignment for cases 7a/7b (R4-mi3):** server pytest verifies Pydantic coercion (`mentions=None` from absent field) and visibility filter (whisper). Web vitest verifies post-strip body content and chip rendering. **Server tests do NOT assert chip rendering** — that's the renderer's concern.

### `/dm` slash-command parser (vitest, in `web/tests/dm-parser.spec.js` — new)

| # | Input | Expected wire fields |
|---|---|---|
| 1 | `/dm @ember hi` | recipients=[ember_key], mentions=null, body="hi" |
| 2 | `/dm @ember, @sage hi` | recipients=[ember_key, sage_key], mentions=null, body="hi" |
| 3 | `/dm @ember,@sage hi` | same as #2 |
| 4 | `/dm @ember hi @sage` | recipients=[ember_key], body="hi @sage" (trailing `@sage` is body) |
| 5 | `/dm @notanyone hi` | reject with inline error highlighting `@notanyone` |
| 6 | `/dm hi` | reject — no recipients |
| 7 | `/dm @<self> hi` (self-DM) | reject — after sender-key dedup, recipients is empty |
| 8 | `/dm @ember` | reject — empty body |
| 9 | Profile-card prefill `/dm @ember ` → user adds `@phil`+sender-self → final `/dm @ember @<self> hi` | recipients=[ember_key] (sender dropped per dedup), body="hi" |
| 10 | Profile-card prefill `/dm @ember ` → user deletes `/dm` prefix → `@ember hi` | broadcast with `mentions=[ember_key]` IF autocomplete had committed `@ember` as a chip; otherwise plain text |

---

## 11. Phase-by-phase shipping order

### Phase A — server model + `comms_send` signature + `comms_check` opt-in + visibility-filter defect-fix
- `message.py`: add `mentions: list[str] | None = None` field with hex-key validator. **(R4-mi5)** The validator mirrors the existing `_validate_recipients` at `message.py:95-105` — same per-key 8-lowercase-hex regex, same null-passes-through semantics, same `ValueError` raise on malformed entries. Suggest naming it `_validate_mentions` and applying via `@field_validator("mentions") @classmethod`.
- `mcp_tools.py`:
  - `tool_comms_send` accepts both `mentions` and `recipients` kwargs. **Resolves recipients via `resolve_recipients`** (existing); **resolves mentions via `resolve_for_mentions`** (new variant — see R2-M3 below). Builds the `[@name1, @name2] ` body prefix from **resolved recipients ONLY** when `recipients` is non-empty (locked Q3 + R2). Mentions-only sends NEVER get a server-injected prefix — the `mentions` wire field carries highlight intent, the prefix is reserved as the visibility marker for whispers.
  - **Sender-key dedup discipline (refined R2-M2):** after `resolve_recipients`:
    - For `recipients`: drop the sender's own key. Defense in depth (composer also drops at parse-time). Self-DM is degenerate.
    - For `mentions`: do NOT dedup server-side. `mentions` is presentation metadata, not a visibility filter; legacy or external-MCP-produced messages may legitimately carry sender-keys, and §6.3's render-time sender-self special case handles this. Server-side dedup would silently make §10 Test #10 unreachable for non-composer paths.
  - **Hex8 validation for `mentions` (R2-M3, locked round 3):** add a **dedicated `resolve_for_mentions(self, mentions: list[str]) -> list[str]`** method on `ParticipantRegistry`. It does name-resolution (same as `resolve_recipients`) PLUS hex8-key validation against `self._participants` — drop unknowns. **Do NOT modify `resolve_recipients`.** The recipients path's lenient hex8 pass-through is intentional and tested behavior we're not perturbing in this plan. Locking the variant approach prevents the recipients-path side-effect that the in-place modification would have introduced. Five-line new method; defense in depth on the mentions path only. **Scope (R4-mi1):** `resolve_for_mentions` validates against the global registry (`self._participants`), not per-conversation membership — symmetric with `resolve_recipients`. A user who's left this conversation but is still globally registered remains a valid mention target.
  - `_is_visible` unchanged. Visibility is driven exclusively by `recipients`.
  - **NEW (Q4 9.G.2):** `tool_comms_check` gains a `mark_seen: bool = False` kwarg. When `mark_seen=True`, after computing the unread set, advance the registry cursor for each scanned conversation to the **latest VISIBLE-TO-VIEWER message's `ts`** (apply `_is_visible(viewer_key)` to determine "visible"). **Note** (round 3 R3-MI2): this is intentionally ahead of `comms_read`'s per-page cursor advance — `comms_read` advances to the last formatted/paginated/truncated message in its return; `mark_seen=True` advances to the latest visible message regardless of pagination. The semantic is "acknowledge-and-skip-everything-visible" since the caller chose not to read content. Default `False` preserves the peek-only contract. **Ordering (R4-mi2):** the response carries the **pre-advance** `total_unread` count so the caller sees what they acknowledged; cursor advance is a side-effect AFTER the response dict is built and BEFORE return. Concretely: `filter → compute count → build response → advance cursor → return response`.
  - **Co-shipped defect-fix (R2-M1):** `tool_comms_check` itself currently counts INVISIBLE messages in `total_unread` (no `_is_visible` filter applied at line 621). Fold a defect-fix into Phase A: apply `_is_visible(viewer_key)` to the unread computation in `comms_check`, so `total_unread` reflects only messages the viewer can actually see. Keeps `comms_check` and `comms_read` semantics consistent.
- `mcp_server.py`: `comms_send` MCP tool schema gains `mentions: list[str] | None = None`. `comms_check` MCP tool schema gains `mark_seen: bool = False`. **Update the `comms_send` docstring (currently `mcp_server.py:656`)** to document both `mentions` and `recipients` semantics with the broadcast-vs-whisper distinction, e.g.: *"Send a message. `mentions` = broadcast highlight intent (visible to all, named users get notification cue). `recipients` = private whisper (visible only to sender + listed recipients). Both accept names or 8-hex keys."*
- Server tests in `tests/test_message_visibility.py` covering the §10 matrix.

### Phase B — agent description
- §6 visibility rules rewritten (three states): broadcast / mention / whisper. Plus the cutover note: "Pre-cutover messages predating the mentions/whisper split keep their `recipients` field as whisper-only — no migration was applied; this is by design."
- §7 send signature updated to document the `mentions` kwarg.
- **§5 polling-loop rule (Q4 9.G.3):**
  > When `comms_check` reports `total_unread > 0`, you have two choices:
  > - **You want the message content** → call `comms_read` (cursor advances on read).
  > - **You've decided based on `latest` and don't need to respond** → call `comms_check(mark_seen=True)` to acknowledge without reading.
  >
  > Never enter the next sleep with `total_unread > 0` unresolved — that's the duplicate-decision trap. With `mentions` now broadcast-visible, the visible-message volume per agent is materially higher than under the old recipients-only rules; failing to advance the cursor amplifies the failure mode this plan exists to fix.
- Reload-trigger: agents spawned from this point use the new rules.

### Phase C — store + composer + DM affordances

**`mqtt-store.svelte.js: sendMessage` signature change.** Three callers exist; only two are touched:

| Caller | File:line | Args today | Action |
|---|---|---|---|
| Composer send | `MessageInput.svelte:829` | `(inputValue, null, recipients?)` | Update to options-object: `(inputValue, null, { mentions, recipients })`. |
| Threaded reply | `App.svelte:332` | `(body, threadParent.id)` | No-op. The new options object has `{} = {}` defaults; positional args still work. |
| Archived alt | `_alt/mqtt-store-v2.svelte.js:546` | `(body, replyTo = null)` | **Out-of-scope. Do not touch.** This is an archived/experimental branch. |

**ATOMICITY CONSTRAINT (R2-C2 — DEALBREAKER fix):** The `mqtt-store.svelte.js: sendMessage` signature change AND the `MessageInput.svelte:829` call-site update MUST land in the SAME commit. No partial-deploy state is permitted. The reason is a JavaScript silent-degradation hazard:
- If store ships first (new options object) and composer is still positional: composer passes `recipientsArray` as the third arg, the store destructures `{ mentions, recipients } = recipientsArray` (an array), which yields `mentions=undefined, recipients=undefined`. **Whisper silently demoted to broadcast — public message published instead of private.**
- If composer ships first (new options object) and store still expects positional: store reads the options object as the `recipients` parameter, then `recipients && recipients.length > 0` evaluates `length` on the object — `undefined` — so the check fails and `recipients=null` is published. **Same silent demotion.**

This invariant must be enforced at the commit level. Any test fixtures or downstream importers using the old positional shape need atomic updates in the same commit. CI must reject partial diffs.

**Composer changes** (`MessageInput.svelte`):

- Autocomplete-committed `mentionTokens` populate the `mentions` wire field via `tokensToMentions(tokens)` (renamed from `tokensToRecipients`).
- Sender's own key dropped from `mentions` at parse-time before send.
- Backwards compat: `tokensToRecipients` is kept as a deprecated alias for one release: `export const tokensToRecipients = tokensToMentions; // @deprecated — alias for one release; will be removed.` Update test imports atomically.

**`/dm` slash-command parser** — implements §6.2-A grammar:

- Trigger `^/dm\s+`.
- Recipient tokens: `@<name>` separated by whitespace, comma, or comma+whitespace. List ends at first non-`@<name>` token.
- Each name resolves via `store.participants` to a participant key at parse-time; wire `recipients` always carries keys, never names.
- Sender's own key dropped at parse-time (sender-self-DM rejected, see validation).
- Validation rejections (inline composer error, no send): empty body, no recipients, unknown name, all-recipients-are-self.
- On send: `recipients=[resolved keys]`, `mentions=null`, body has the `/dm @recipients...` prefix stripped.

**Profile-card "Send DM" button** (`ProfileCard.svelte`, `UserProfileView.svelte`):

**Prefill mechanism (R2-C3 fix):** Replace the current `document.querySelector('[data-testid="message-input"]')` + `input.value =` + synthetic-input-event approach in `App.svelte:434-444` and `:374-384`. That approach is fragile (selector coupling, doesn't update Svelte state cleanly, doesn't auto-commit autocomplete tokens). Instead use a store-mediated event:
- Add `composerPrefill = $state(null)` to `mqtt-store.svelte.js` (or a dedicated `composer.svelte.js` store).
- `ProfileCard.onMessage(p)` and `UserProfileView.onSendMessage(p)` set `store.composerPrefill = '/dm @<p.name> '` (trailing space).
- `MessageInput.svelte` watches `store.composerPrefill` via `$effect` — when set, it programmatically sets `inputValue`, positions the cursor, focuses the textarea, and clears `store.composerPrefill = null`. No DOM querying; no synthetic events.

**Behavior on send:**
- User types body after the prefill, hits send. The send path (Phase C-1 below) detects the `/dm ` prefix and routes through the slash-command parser. The `/dm` parser is the single source of truth for whisper resolution.
- Edge: user edits the prefill (adds/removes recipients, deletes the `/dm` prefix). Parser handles it identically to hand-typed input. Tests cover this (§10 `/dm` cases 9, 10).

**Phase C-1 — `MessageInput.sendMessage()` parse-order pseudocode (R2-C3 fix):**

The plan must specify exactly how `sendMessage()` decides between the slash-command path and the autocomplete path. Implement:

```js
// Imports needed at top of MessageInput.svelte (R4-mi4):
import { parseDM } from '$lib/dm-parser.js';     // new file (R3-MI3)
import { tokensToMentions } from '$lib/mentions.js';  // renamed from tokensToRecipients

function sendMessage() {
  // Pre-conditions (existing): commit pending block-mode, force-commit pending exact-match.

  if (inputValue.trim().startsWith('/dm ')) {
    const parsed = parseDM(inputValue, store.participants, store.userProfile.key);
    //   parseDM returns { recipients: string[], body: string, error: string | null }
    //   Implementation lives in NEW file `web/src/lib/dm-parser.js` (locked round 3 R3-MI3).
    //   Rationale: `web/src/lib/mentions.js` is already 17KB and owns the autocomplete
    //   state machine; merging slash-command parsing into it couples two orthogonal grammars.
    //   New file is single-responsibility and easier to test in isolation.
    //   See §6.2-A for grammar + validation rules.
    if (parsed.error) {
      composerError = parsed.error;  // surfaces inline in the composer
      return;
    }
    store.sendMessage(parsed.body, null, { recipients: parsed.recipients, mentions: null });
    resetComposer();
    return;
  }

  // Default path: autocomplete-driven mentions
  const mentions = tokensToMentions(mentionTokens);
  store.sendMessage(inputValue, null, {
    mentions: mentions.length > 0 ? mentions : null,
    recipients: null,
  });
  resetComposer();
}
```

Key invariants:
1. `/dm` parsing happens BEFORE `tokensToMentions`. The two paths are mutually exclusive — a `/dm` send never carries `mentions`.
2. The parser is a pure function (no side effects); `composerError` is the only place inline errors surface.
3. `store.participants` is the source of truth for name→key resolution at parse-time.
4. `store.userProfile.key` is passed for sender-key dedup at parse-time (per §6.2-A bullet 9).

### Phase D — web render

**Edits land in `MessageBubble.svelte` only. `RichText.svelte` is NOT touched.**

- Extend `parseBody(text, participants, message, currentUser)` per §6.3 algorithm:
  - Existing `parseRichText` + `parseMentions` pipeline runs unchanged.
  - For each resolved `mention` segment, look up the key via participants map.
  - If key ∈ `message.mentions` AND key === `currentUser.key` → segment becomes `mention-self`.
  - If key ∈ `message.mentions` AND key ≠ `currentUser.key` → segment becomes `mention-other`.
  - If key ∉ `message.mentions` → legacy `mention` (unchanged styling). Preserves backwards compat for old `[@name]` body prefixes.
  - **Sender-self special case:** if `viewer.key === sender.key`, render any `mention-self` segments as legacy `mention` instead. No loud self-chip on your own bubble.
- Add new render branches in the `{#each bodySegments as seg}` loop for `mention-self` and `mention-other`.
- `mention-self` styling triggers a `.has-self-mention` class on the bubble root (gated on whether ANY segment in this bubble is `mention-self`). That class drives the 3px amber left-border accent.
- Add CSS tokens to `app.css` in this commit (token names locked in §6.3): `--mention-self-bg`, `--mention-self-fg`, `--mention-self-border`, `--mention-other-bg`, `--mention-other-fg`. Phoenix picks the actual hex against the Carbon Ember palette.
- Whisper styling block (line 529, gated on `isTargeted`) — unchanged. Already correctly gates on non-empty `recipients`.

### Phase E — TUI render parity (read-only for mentions in v1)

**Scope:** TUI **read** path renders `mentions` field with semantic differentiation. TUI **write** path stays as-is — TUI cannot produce `mentions`-only messages in v1. The existing `[@name]` body-prefix path in TUI continues to produce whispers (recipients-set), unchanged.

This asymmetry is intentional and documented in:
- The agent description §7 (TUI mention-write is out-of-scope for v1).
- The CHANGELOG.
- Phase F's TUI test scope (read-side only).

A future v2 may add a TUI `/dm` parser AND a free-`@name` → `mentions` extractor; this plan doesn't ship them.

**Read-side edits** (`src/claude_comms/tui/app.py`):

- Render `mentions` highlight using terminal-friendly styling: bold + amber color for self-mention (where `viewer.key ∈ message.mentions` AND key === current user's key), dim color for other-mentions.
- Reverse-video left margin (or a single-character `▎` glyph) on the bubble line for self-mention (terminal equivalent of the 3px amber border accent).
- Sender-self special case: same rule as web — if viewer is the sender, render self-mentions as legacy mention (no loud terminal styling).
- Whisper render in TUI already exists; verify it gates on `recipients` only and is independent of the new `mentions` field.

**Render parity criterion:** semantic, not pixel. Self-mentions visually distinct from other-mentions, broadcasts distinct from whispers, legacy mentions still readable. Use Textual's existing color/style primitives — no need to invent new widgets.

### Phase F — tests (split into 3 sage lanes)

Each sage lane is its own commit with its own build/test gate. The lane spawn prompts must explicitly name the stack and the test files so framework discovery doesn't burn agent context.

**Phase F1 — sage-server (pytest):**
- Stack: pytest. Test file: `tests/test_message_visibility.py` (new).
- Coverage: §10 server visibility matrix cases 1–6, 8, 9, 10, 11, 12 (12 cases).
- Co-ships with Phase A.

**Phase F2 — sage-web (vitest):**
- Stack: vitest with @testing-library/svelte + jsdom.
- Test files: `web/tests/dm-parser.spec.js` (new — `/dm` grammar cases 1–10), `web/tests/message-input-mentions.spec.js` (new — autocomplete → mentions wire field), `web/tests/message-bubble-mentions.spec.js` (new — render branch for self/other/legacy/sender-self/unknown-key).
- Co-ships with Phases C and D.

**Phase F3 — sage-tui (pytest with Textual harness):**
- Stack: pytest with Textual's testing utilities. Test file: `tests/test_tui.py` (extend existing).
- Coverage: TUI render parity smoke for §10 cases 1–6 (semantic differentiation only — assert distinct text/style attributes, not pixel match).
- Co-ships with Phase E.

### Phase G — folded into Phases A + B (Q4 belt-and-suspenders fix)

**Locked decision:** ship 9.G.2 server-side opt-in AND 9.G.3 agent-description rule together. Belt + suspenders. Rationale captured in §12 Q4 row.

- **Server side (folded into Phase A):** `tool_comms_check` gains a `mark_seen: bool = False` kwarg. When `True`, advance the registry cursor for each scanned conversation to the latest `ts`. Default `False` preserves the existing peek-only contract for callers that haven't been updated.
- **Agent description (folded into Phase B):** §5 polling-loop rule that says: if `comms_check` reports `total_unread > 0`, either call `comms_read` (which advances cursor as side-effect of fetching content) OR call `comms_check(mark_seen=True)` to acknowledge without reading. Never enter the next sleep with unresolved unread.

Why both: agent-discipline rules in this project have repeatedly drifted (status discipline §11.6 strengthened twice; §13 exit procedure strengthened twice; §6.5 sole-output protocol added because the original self-elect rule failed). With `mentions` becoming broadcast-visible, the per-poll visible-message volume amplifies the cursor-non-advance failure mode. Server-side enforcement is one parameter and ~5 lines of Python; rule alone has a poor track record.

Rejected: Option 9.G.1 (truncate `latest` body) — blunt instrument, breaks legitimate peek for short messages. Pure 9.G.3 — too brittle alone given history.

---

## 12. Locked decisions (Phil's call, 2026-05-06)

| # | Question | Decision |
|---|---|---|
| Q1 | DM affordance | **Both** `/dm @user message` slash command **and** profile-card "Send DM" button. Profile-card is a UX layer over the slash command — single source of truth. |
| Q2 | Migration | **Clean break** — no migration script, no read-time heuristic. Old messages keep `recipients` semantic; CHANGELOG documents the cutover. |
| Q3 | `[@name]` body prefix for mentions-only | **No.** Prefix is reserved for whispers (`recipients`-set). Mentions-only relies on the wire-format `mentions` field + render-side highlight. |
| Q4 | `comms_check` cursor advance | **Belt + suspenders** (Options 9.G.2 + 9.G.3). Server-side `comms_check(mark_seen=True)` opt-in (default False, preserves peek contract) PLUS §5 polling-loop rule directing agents to use `mark_seen=True` when acknowledging without reading. Updated 2026-05-06 from v2 (rule-only) after adversarial round 1 surfaced the volume-amplification risk caused by mentions becoming broadcast. |
| Q5 | Self-mention vs other-mention render | **Differentiate.** Self-mention loud (bold + amber chip + 3px amber bubble border accent). Other-mention quiet (regular weight + grey-tinted chip). |
| Q6 | TUI scope | **In v1.** Render parity at semantic level (legible, differentiated) — not pixel-identical. |

---

## 13. Delegation sketch

Reassigned in v3 (round 1) to keep cognitive lanes coherent and stay inside the parallel-agent caps documented in `feedback_parallel_agent_limits.md`:

- **ember (lead)** — Phase A (server model + MCP tool, including `comms_check(mark_seen=True)` opt-in + sender-key dedup) + Phase B (agent description, including §5 polling-loop rule with explicit `mark_seen=True` guidance). Owns the canonical wire format and the rule set. Single Python lane; tight coherence between wire format, server semantics, and the rules that teach agents to use them.
- **phoenix** — Phase C → Phase D → Phase E, **serialized** (see §14 Rollout). Web composer + DM affordances, then web render, then TUI render parity. The same UX problem (semantic differentiation across surfaces) in three frameworks; cognitively collocated.
- **sage** — Phase F, **split into 3 lanes** (F1 sage-server, F2 sage-web, F3 sage-tui). Each lane has its own commit + build/test gate. Lane spawn prompts must explicitly name the stack and the test files (per round 1 R3) so the sage agent doesn't waste context on framework discovery:
  - **sage-server (pytest):** `tests/test_message_visibility.py`. Co-ships with Phase A.
  - **sage-web (vitest + Svelte testing-library):** `web/tests/dm-parser.spec.js`, `web/tests/message-input-mentions.spec.js`, `web/tests/message-bubble-mentions.spec.js`. Co-ships with Phases C and D.
  - **sage-tui (pytest with Textual harness):** extend `tests/test_tui.py`. Co-ships with Phase E.

No phase is unowned. Phase G is folded into Phases A (server-side `mark_seen`) and B (agent-description rule).

---

## 14. Rollout

**Serialized** to keep phoenix's lane focused and stay within the parallel-agent caps. Each batch has a build/test gate before the next batch is dispatched (per `feedback_batch_verification.md`).

1. **Batch 1 — Phase A + Phase B + sage-server (F1)** — landed together.
   - ember: server model + MCP tool changes + `comms_check(mark_seen=True)` opt-in + sender-key dedup.
   - ember: agent description §5 polling-loop rule with `mark_seen=True` guidance + §6 visibility rules + cutover note.
   - sage-server: §10 server visibility matrix tests.
   - **Gate:** all pytest green; visibility matrix 100% coverage.
2. **Batch 2 — Phase C + sage-web composer (F2 partial)** — phoenix's first commit.
   - phoenix: `mqtt-store.svelte.js: sendMessage` signature + `MessageInput.svelte` autocomplete → mentions wire field + `/dm` slash-command parser + profile-card button wiring.
   - sage-web: `dm-parser.spec.js` + `message-input-mentions.spec.js`.
   - **Gate:** vitest green; bundle build clean.
3. **Batch 3 — Phase D + sage-web render (F2 remainder)** — phoenix's second commit.
   - phoenix: `MessageBubble.svelte` extended with self-vs-other render branches + CSS tokens in `app.css`.
   - sage-web: `message-bubble-mentions.spec.js`.
   - **Gate:** vitest green; bundle build clean; visual smoke of self/other differentiation in browser.
4. **Batch 4 — Phase E + sage-tui (F3)** — phoenix's third commit.
   - phoenix: `tui/app.py` mention render with semantic differentiation.
   - sage-tui: TUI render parity smoke tests.
   - **Gate:** pytest green; manual TUI smoke from terminal.
5. **Final gate.** End-to-end check: web ⇄ TUI cross-surface message render parity for §10 cases 1–6. CHANGELOG entry. Documentation cutover note in `broker.replay_jsonl_logs`.

No feature flag needed — backwards compatibility is structural (additive field, additive kwarg). Old clients keep working; new clients exercise the new path.

**Parallelism profile.** Per `feedback_parallel_agent_limits.md` (max 5 implementation agents): batches 1 and 2 each have 2 active lanes (ember+sage-server, phoenix+sage-web). Batches 3 and 4 also each have 2 active lanes. We never exceed 2 simultaneous implementation agents on this plan, leaving headroom for orchestrator overhead.

---

## 15. Risk register

| Risk | Mitigation |
|---|---|
| User types `@username` expecting privacy → message goes broadcast. | Phase B agent description + UI tooltip on autocomplete chip clarifying "broadcast highlight." Slash command `/dm` is the explicit private path. |
| Existing user code or agents that assume `recipients` ⇒ "@-mention" semantics break post-deploy. | Backwards compat is preserved (`recipients` still hides). The break is conceptual — `recipients` for autocomplete is explicitly wrong and we want it to break. Document in CHANGELOG. |
| Slash command `/dm` collides with future slash commands. | Reserve a `/` namespace; `/dm` becomes the canonical first member. Consider `/help`, `/leave`, `/me` as siblings down the road. The TUI already uses `/discover` and `/artifact` independently; no shared registry yet, no conflict in v1. |
| Mentions field on every message bloats the wire. | `null` when unused — no overhead. |
| Volume amplification: with `mentions` broadcast, every channel member sees more messages → more re-decision loops on cursor non-advance. | Q4 belt + suspenders: server-side `mark_seen=True` opt-in (Phase A) AND agent-description rule (Phase B). Server-side enforcement is structural; rule alone has poor track record. |
| TUI mention-write asymmetry confuses users. | Explicitly documented in agent description, CHANGELOG, and §11 Phase E scope. TUI users with `[@name]` body prefix continue to produce whispers (existing behavior); v2 may add TUI `/dm` parser. |
| TUI free-`@` cross-surface inconsistency for agents (R2-M4). | Agent description §6 "Respond if listed in `mentions`" rule fires only for web/MCP-originated messages. TUI-originated `@ember` produces `mentions=null`, so ember-the-agent will NOT trigger the mention-rule on a TUI-typed `@ember`. §10 case 14 locks this behavior. Agent description §6 needs an explicit note: "Mentions field is empty for TUI-originated messages in v1; rely on body-text matching as a fallback if you want to catch TUI mentions to your name." Risk acknowledged; v2 closes the gap. |
| Cross-deploy `total_unread` count drop for already-running agents (R3-MI4). | Phase A's `comms_check` visibility-filter defect-fix changes `total_unread` to count only visible messages. An agent running across the deploy boundary will see a same-call result drop (possibly to 0) where invisible whispers were previously counted. This is the INTENDED post-fix state and matches `comms_read`'s actual visibility model. Agents that were sleeping due to non-zero `total_unread` from invisible whispers will correctly resume idle behavior. CHANGELOG documents the change explicitly. No mitigation needed beyond the doc — existing agents either re-validate via `comms_read` (already discipline) or sleep peacefully (correct outcome). |
| `comms_update_name` race during `/dm` resolution. | Composer resolves names → keys at parse-time via `store.participants`. Wire `recipients` array always carries keys. Renames after parse are irrelevant. |
| Sender's own key in `recipients` or `mentions` (defensive integrity). | Dropped at BOTH parse-time (composer) AND server-time (`tool_comms_send`). Sender always sees own messages via `_is_visible`'s sender-key check; explicit listing is dead bytes. |

---

## 16. Open issues to flag during execution

- **Body prefix duplication** — resolved in §12 Q3 (no prefix for mentions-only). Render path resolves overlap automatically: when a whisper has both `recipients` (server-prefix) and inline `@name` (sender-typed body) referencing the same participant, both `@name` tokens get the self/other styling driven by `mentions` field. No special-case dedup.
- **Self-mentions on sender's own bubble** — explicit rule in §6.3: if `viewer.key === sender.key`, render `mention-self` segments as legacy `mention` (no loud chip on own bubble). Tested in §10 case 10.
- **Mention deduplication** — if `mentions=[ember, ember]` arrives at the server, the existing `resolve_recipients` dedup applies (treats input as a set). Same path serves both `recipients` and `mentions` resolution.
- **Slash-command namespace coexistence** — the web composer adds `/dm`; the TUI already handles `/discover` and `/artifact`. There is no shared slash-command registry in v1. The web `/dm` does not require a TUI counterpart (TUI mention-write is out of scope per §11 Phase E). Future plans should either add a registry or explicitly partition the namespaces by surface.
- **Mention render overlap with whisper prefix** — when both `recipients` set AND `mentions` set, the render path is unified: `parseMentions` finds every `@name` token (in prefix or body), the `mentions` field drives self/other classification regardless of source. Documented in §6.3.

---

## 17. Definition of done

**Wire format & server:**
- `Message.mentions: list[str] | None` field added with hex-key validator.
- `tool_comms_send` accepts both `mentions` and `recipients` kwargs.
- Server resolves recipients via `resolve_recipients`; resolves mentions via `resolve_for_mentions` (new variant; hex8-validates against registry per R2-M3, locked round 3). `resolve_recipients` is unchanged.
- Sender-key dedup applied to `recipients` at server resolve-time (defense in depth); NOT applied to `mentions` server-side (locked round 2 R2-M2 + round 3 confirmation).
- Server prepends `[@name1, @name2] ` body prefix ONLY when `recipients` is set; never for mentions-only.
- `_is_visible` unchanged — visibility driven exclusively by `recipients`.
- `tool_comms_check` accepts `mark_seen: bool = False`; advances cursor when `True`.

**Web composer & store:**
- `mqtt-store.svelte.js: sendMessage` migrates to options-object signature `{ mentions, recipients }`. All three callers verified (one updated, one no-op via defaults, one out-of-scope).
- `MessageInput.svelte` autocomplete-committed mentions populate the `mentions` wire field via `tokensToMentions`. Sender-key dedup at parse-time.
- `tokensToRecipients` retained as deprecated alias for one release.
- `/dm @user[, @user2, ...] body` slash command parser implements the §6.2-A grammar exactly. All §10 `/dm` parser cases pass.
- Profile-card "Send DM" button pre-fills the composer with `/dm @<name> ` and focuses cursor.

**Web render:**
- `MessageBubble.svelte:parseBody` extended per §6.3 algorithm. NO edits to `RichText.svelte`.
- Three render branches: `mention-self` (bold + amber + bubble border accent), `mention-other` (quiet grey), legacy `mention` (existing styling for backwards compat / unkeyed mentions).
- Sender-self special case: own self-mentions render as legacy `mention` (no loud chip on own bubble).
- CSS tokens `--mention-self-bg/-fg/-border`, `--mention-other-bg/-fg` defined in `app.css`.
- Whisper styling block (line 529, gated on `isTargeted`) unchanged.

**TUI render:**
- `tui/app.py` renders mentions with semantic differentiation: bold + amber for self-mention, dim for other-mention, reverse-video left margin (or `▎`) for self-mention bubble. Sender-self special case applied.
- TUI mention-WRITE explicitly out of scope for v1 — existing `[@name]` body prefix continues producing whispers.
- Whisper render in TUI gates on `recipients` only, independent of `mentions`.

**Agent description:**
- §6 visibility rules rewritten to teach the three-state model (broadcast / mention / whisper) plus the cutover note for pre-cutover messages.
- §7 send signature updated to document the `mentions` kwarg.
- §5 polling-loop rule added: `comms_check` with `total_unread > 0` requires either `comms_read` or `comms_check(mark_seen=True)` before next sleep. Volume-amplification rationale captured.

**Tests (split per Phase F):**
- F1 sage-server: §10 server visibility matrix cases 1–6, 8, 9, 10, 11, 12 in `tests/test_message_visibility.py`. Pydantic round-trip for legacy fixture (case 7).
- F2 sage-web: `dm-parser.spec.js` (§10 `/dm` cases 1–10), `message-input-mentions.spec.js`, `message-bubble-mentions.spec.js`.
- F3 sage-tui: `tests/test_tui.py` extended for §10 cases 1–6 render parity.

**Documentation:**
- CHANGELOG entry covering: new visibility model, `/dm` slash command, profile-card button, self-vs-other mention render, `mark_seen` opt-in, sender-key dedup discipline (recipients only, NOT mentions), `comms_check` visibility-filter defect-fix, hex8-validation for `mentions`, TUI write-side asymmetry, the explicit note that pre-existing logs retain `recipients`-as-whisper semantics (no migration applied), **plus (R4-mi6) a behavioral note: external MCP `comms_send` callers passing `recipients=[sender_key]` (sole-recipient self-DM) now receive a "None of the specified recipients could be resolved" error — was silently a no-op self-DM; multi-recipient lists including the sender's key continue to succeed with the sender dropped.**
- Inline comment in `broker.replay_jsonl_logs` (or equivalent) explaining the cutover.
- Agent description §6 cutover sentence + TUI cross-surface asymmetry note.
- MCP tool docstring at `mcp_server.py:656` updated to document both `mentions` and `recipients` semantics with the broadcast-vs-whisper distinction (R2-m4).

**Invariant tests (R2-m2):**
- Sender-self visibility invariant: a message with `recipients=[other]` (sender NOT explicitly listed) is visible to sender via `_is_visible`'s sender-key check. Locks the assumption that `_is_visible` always lets the sender through, so future `_is_visible` changes (e.g., mute lists) don't silently break the sender-key dedup invariant.

**Rollout gates:**
- Each batch (1–4 in §14) passes its own build/test gate before the next batch dispatches.
- Final cross-surface smoke: web ⇄ TUI parity for §10 cases 1–6.

---

## 18. Changelog

### Adversarial Review Round 1 — 2026-05-06

Plan v2 → v3. 21 numbered findings raised by Adversarial Claude across 4 DEALBREAKER, 1 CRITICAL non-dealbreaker, 7 MAJOR, 8 MINOR, 5 rebuttal-unlocked. All accepted with the noted modifications. Phil's call on Q4 escalation: belt-and-suspenders (9.G.2 server-side opt-in + 9.G.3 rule).

**DEALBREAKERS resolved (block-of-changes before kickoff):**
- **C1.** §4 + §6.3 + §11 Phase D rewritten. Mention render lives in `MessageBubble.svelte:parseBody` calling `parseMentions` from `lib/utils.js`, NOT in `RichText.svelte`. Phoenix's lane redirected to the correct file. New segment types `mention-self`/`mention-other` added to `MessageBubble.svelte:218-244` render loop.
- **C2.** Sender-key dedup specified at BOTH composer parse-time AND server `tool_comms_send` resolve-time. Defense in depth.
- **C3.** §11 Phase C enumerates all three callers of `mqtt-store.svelte.js: sendMessage`: composer (touched), App.svelte threaded reply (no-op via defaults), `_alt/mqtt-store-v2.svelte.js` (out-of-scope archive).
- **C4.** §11 Phase A corrected. Server `[@name]` body prefix is built from RESOLVED RECIPIENTS ONLY when `recipients` is non-empty. Mentions-only sends never get a server-injected prefix. Reconciles with §17 DoD and §12 Q3.

**CRITICAL non-dealbreaker resolved:**
- **C5.** §6.2 + §11 Phase C: `/dm` parser resolves `@name` → key at parse-time via `store.participants`. Wire `recipients` always carries keys, never names. Bypasses `comms_update_name` rename race entirely.

**MAJOR fixes:**
- **M1.** §6.2-A grammar locked (whitespace OR comma OR comma+whitespace separates recipient tokens; tokens end at first non-`@<name>`). 10 specific `/dm` parser test cases added to §10.
- **M2 / R1.** Q4 re-opened and resolved with belt-and-suspenders (9.G.2 + 9.G.3). Server-side `mark_seen=True` opt-in folded into Phase A. §5 polling-loop rule with explicit `mark_seen` guidance folded into Phase B.
- **M3.** §11 Phase E scope clarified — TUI is read-only for `mentions` in v1. Existing `[@name]` body-prefix path stays whisper-producing. Documented in agent description, CHANGELOG, and §15 risk register.
- **M4.** Phase F split into 3 sage lanes (sage-server pytest, sage-web vitest, sage-tui Textual harness). Each with its own commit + build/test gate. Lane spawn prompts must explicitly name stack + test files.
- **M5.** Phase E (TUI render) reassigned from ember to phoenix. Web render and TUI render are the same problem in different frameworks; cognitively collocated.
- **M6.** §10 test matrix row 7: legacy whisper (no `mentions` field at all) → Pydantic coerces to `None`, visibility = whisper, render = legacy `.mention` chip + dashed bubble.
- **M7.** §10 test matrix row 9: `mentions=[unknown_key]` → renders `@name` as plain text, no error.

**MINOR refinements:**
- **m1.** CSS tokens pre-defined in §6.3 + §11 Phase D: `--mention-self-bg/-fg/-border`, `--mention-other-bg/-fg`.
- **m2.** §10 row 8: empty `mentions=[]` behaves identically to `mentions=null`.
- **m3.** §6.3 sender-self special case: if `viewer.key === sender.key`, render `mention-self` segments as legacy `mention` (no loud chip on own bubble). Tested in §10 case 10.
- **m4.** §10 case 7 covers the old-format fixture render.
- **m5.** `tokensToRecipients` retained as deprecated alias for one release; tests updated atomically (§11 Phase C).
- **m6.** §9 enriched with three documentation surfaces for the cutover (CHANGELOG, inline comment in `broker.replay_jsonl_logs`, agent description §6 sentence).
- **m7.** No-op confirmation: `MessageBubble.svelte:139 isTargeted` already correctly gates whisper styling.
- **m8.** Subsumed by C2 (sender-key dedup at server).

**Rebuttal-unlocked points:**
- **R1.** Q4 → 9.G.2 + 9.G.3 (resolved with M2).
- **R2.** §6.3 + §16: render path is unified when both `recipients` (with prefix) and `mentions` are set. `parseMentions` finds every `@name`; `mentions` field drives self/other classification regardless of source. No special-case dedup.
- **R3.** §13 delegation: each sage lane spawn prompt must explicitly name the stack and the test files to avoid framework-discovery context burn.
- **R4.** §14 Rollout serialized: phoenix's C → D → E land sequentially with build/test gates between each, instead of parallel.
- **R5.** §16 + §15: slash-command namespace coexistence note. Web `/dm`, TUI `/discover` and `/artifact` are independent in v1; no shared registry yet, no conflict.

**Status:** REVIEWED. Plan is implementable. Adversarial round 2 pending.

### Adversarial Review Round 2 — 2026-05-06

Plan v3 → v4. 11 numbered findings raised by Adversarial Claude across 3 DEALBREAKER, 4 MAJOR, 4 MINOR. All accepted. The plan is converging (round 1: 21 findings → round 2: 11 findings) but round 2 found genuinely new issues round 1 missed — primarily code-vs-spec drift, migration-ordering atomicity, and unspecified component handoffs.

**DEALBREAKERS resolved:**
- **R2-C1.** §6.3 R2 lock rewritten. `parseMentions` (utils.js:74-103) strips the `[@name]` server-prefix BEFORE tokenizing — round 1's "render path is unified" claim was false. Mention classification is now explicitly **body-only**. The `/dm` parser injects `@name` body tokens for each resolved recipient when stripping the recipient list (§6.2-A step 7), so `/dm @ember hi` produces body `"@ember hi"`. §10 Test #4 corrected to require body-side `@ember` text and to render legacy `.mention` chip + whisper bubble (NOT loud self/other styling — that's mention-only).
- **R2-C2.** §11 Phase C atomicity constraint added: store signature change AND MessageInput call-site update MUST land in the same commit. JavaScript silently destructures arrays into option-objects, demoting whispers to broadcasts on partial deploys. Hard invariant; CI rejects partial diffs.
- **R2-C3.** §11 Phase C-1 added — explicit pseudocode for `MessageInput.sendMessage()` showing parse order: `/dm`-detection BEFORE `tokensToMentions`. Profile-card prefill mechanism rewritten — replaces fragile `document.querySelector` + `input.value =` with a store-mediated `composerPrefill` field watched by `MessageInput.svelte` via `$effect`.

**MAJOR fixes:**
- **R2-M1.** `comms_check(mark_seen=True)` cursor advance specified as visible-to-viewer only (matching `comms_read`). Co-shipped defect-fix folded in: `comms_check` itself currently counts INVISIBLE messages in `total_unread` (no `_is_visible` filter) — Phase A applies the filter for consistency. New §10 case 13 locks the behavior.
- **R2-M2.** Sender-key dedup discipline refined. `recipients`: dedup at composer + server (defense in depth). `mentions`: dedup at composer only (UX); do NOT dedup server-side. Server-side `mentions` dedup was making §10 Test #10 (legacy/external-MCP path) unreachable. Test #10 caption updated to clarify the legacy-path scope. Test #11 split into 11a (recipients dedup invariant) + 11b (mentions NO-dedup invariant).
- **R2-M3.** `resolve_recipients` extended to validate hex8 keys against `_participants` for the `mentions` resolution path. Drops stale keys, prevents future-collision agent-trigger bugs. Five-line addition to Phase A.
- **R2-M4.** TUI cross-surface asymmetry surfaced as risk register entry + new §10 case 14. Agent description §6 needs an explicit note that `mentions` field is empty for TUI-originated messages in v1.

**MINOR refinements:**
- **R2-m1.** Use anchor-based references (function names + first-line text) where feasible. Line numbers drift the moment Phase D lands.
- **R2-m2.** Sender-self visibility invariant test added to DoD: `recipients=[other]` (sender NOT in list) visible to sender via `_is_visible` sender-key check.
- **R2-m3.** §10 Test #11 split into 11a + 11b (separate wire-format invariant from visibility assertion).
- **R2-m4.** MCP tool docstring at `mcp_server.py:656` updated as part of Phase A to document broadcast-vs-whisper distinction.

**Status:** REVIEWED. Plan is implementable. Adversarial round 3 pending — will verify the new edits don't contradict each other and that no new issues unlock from the round-2 fixes.

### Adversarial Review Round 3 — 2026-05-06

Plan v4 → v5. Round 3 was the tightest yet: **0 CRITICAL, 2 MAJOR, 4 MINOR.** The plan is fundamentally sound; round 3 surfaced specification-gap issues, not architecture defects. All accepted with mechanical edits below. Round 3's verification against actual code confirmed every plan claim from rounds 1+2 is now accurate.

**MAJOR fixes:**
- **R3-MA1.** §10 Test #12 wire-format invariant clarified. Pydantic v2 default `model_dump_json()` includes None-valued fields. Today's wire format already emits `"recipients":null` for broadcasts; adding `mentions: list[str] | None = None` will symmetrically emit `"mentions":null`. The test caption is updated to reflect this — no `exclude_none` config required, and the "without adding mentions field" assertion is dropped. Symmetric null-fields are consistent with existing wire shape.
- **R3-MA2.** §11 Phase A R2-M3 hex8 validation locked to a **dedicated `resolve_for_mentions` variant**. `resolve_recipients` is NOT modified — its lenient hex8 pass-through is intentional and tested. The round 2 plan left "or a dedicated resolve_for_mentions variant" as an unresolved alternative; round 3 locks the variant approach. Avoids unintended side-effects on the recipients path. Phase A bullet 1 + §17 DoD updated to reflect "recipients via resolve_recipients; mentions via resolve_for_mentions."

**MINOR fixes:**
- **R3-MI1.** §10 Test #7 split into 7a (prefix-only legacy whisper, no body-side `@name`, no chip rendered) and 7b (legacy whisper with body-side `@name`, chip rendered). Resolves the unspecified-fixture-body ambiguity.
- **R3-MI2.** §11 Phase A `mark_seen=True` cursor advance spec + §10 Test #13 caption updated. Dropped the misleading "matches `comms_read`'s cursor-update semantics" phrase. Clarified: `mark_seen=True` advances to the latest visible-to-viewer message (acknowledge-and-skip), intentionally ahead of `comms_read`'s per-page advance.
- **R3-MI3.** `parseDM` location locked to **new file `web/src/lib/dm-parser.js`** (not `mentions.js`). Single-responsibility, easier to test, avoids coupling autocomplete and slash-command grammars.
- **R3-MI4.** §15 risk register entry added for cross-deploy `total_unread` count drop (Phase A's `comms_check` visibility-filter defect-fix changes counts for already-running agents — intended state, documented in CHANGELOG).

**Round 3's verification confirmed against actual code:**
- `web/src/lib/utils.js:74-103` parseMentions strip behavior — confirmed.
- `web/src/components/MessageBubble.svelte:43,141,218` parseBody pipeline — confirmed locations match plan.
- `src/claude_comms/mcp_tools.py:233-252` resolve_recipients lenient hex8 pass-through — confirmed.
- `src/claude_comms/mcp_tools.py:597-637` comms_check missing `_is_visible` — confirmed (R2-M1 is real defect-fix).
- `src/claude_comms/mcp_tools.py:583-587` comms_read cursor-advance per-page — confirmed (R3-MI2 phrasing nit accurate).
- `src/claude_comms/tui/app.py:559-571` TUI bracket-prefix-only resolve_mentions — confirmed.
- `web/src/App.svelte:374-384,434-444` profile-card querySelector prefill — confirmed.

**Convergence trend:** Round 1 = 21 findings → Round 2 = 11 findings → Round 3 = 6 findings (0 critical/dealbreaker). Smooth descent.

**Status:** REVIEWED. Round 4 pending per Phil's stated bar ("until NO critical and NO major"). Round 3 found 2 majors which are now folded in; round 4 verifies they don't re-introduce issues.

### Adversarial Review Round 4 — 2026-05-06 (FINAL ROUND)

Plan v5 → v6. Round 4 verdict: **0 CRITICAL, 0 MAJOR, 6 MINOR.** Phil's binary criterion ("no critical AND no major") **MET.** Plan is ship-ready. Adversarial review loop CLOSED.

Round 4's mandate was twofold: (1) verify round-3 fixes are correct, (2) hunt for any residual critical/major issues. Findings: all round-3 fixes verified correct against actual code; no critical or major issues exist. The 6 minor findings are mechanical clarifications, all folded into v6:

**Minor polish folded in:**
- **R4-mi1.** §11 Phase A `resolve_for_mentions` scope clarification — validates against global registry, NOT per-conversation membership; symmetric with `resolve_recipients`. Forestalls future divergent "fix."
- **R4-mi2.** §11 Phase A `mark_seen=True` ordering locked — response carries pre-advance `total_unread`; cursor advance is a side-effect after response built. Caller sees what they acknowledged.
- **R4-mi3.** §10 Coverage block — explicit lane split for Test #7a/7b (server pytest covers Pydantic coercion + visibility; web vitest covers render).
- **R4-mi4.** §11 Phase C-1 pseudocode — added import statements (`parseDM` from `$lib/dm-parser.js`, `tokensToMentions` from `$lib/mentions.js`).
- **R4-mi5.** §11 Phase A — explicit reference: `mentions` validator mirrors `_validate_recipients` at `message.py:95-105`.
- **R4-mi6.** §17 DoD CHANGELOG list — added behavioral note for external MCP `recipients=[sender_key]` self-DM error (was silent no-op).

**Cross-round coherence verification (round 4 mandate):** I systematically diffed all R1+R2+R3 edits for contradictions. None found. The plan's iteration produced a self-consistent specification:
- Sender-key dedup: composer + server for `recipients`; composer-only for `mentions` (R1-C2 + R2-M2 + R3 confirmation aligned)
- Body-prefix policy: server prefix only when `recipients` non-empty; mentions-only never prefixed (R1-C4 + R2-C1 aligned)
- Hex8 validation: `resolve_for_mentions` is new and additive; `resolve_recipients` unchanged (R2-M3 + R3-MA2 aligned)
- `comms_check`: defect-fix (R2-M1) + opt-in `mark_seen` (Q4) + cross-deploy doc (R3-MI4) cleanly co-shipped

**Final convergence trend:**
| Round | Critical/Dealbreaker | Major | Minor | Total |
|---|---|---|---|---|
| 1 | 5 (4 dealbreaker + 1 critical) | 7 | 13 (incl. rebuttal) | 25 |
| 2 | 3 | 4 | 4 | 11 |
| 3 | 0 | 2 | 4 | 6 |
| 4 | **0** | **0** | 6 | 6 |

**Status: SHIP-READY.** No further adversarial rounds warranted. Implementation can proceed per §11 phase ordering and §13 delegation. The 6 minor edits in v6 are clarifications, not behavior changes. Round 5 would yield only sub-minor wording polish — beyond the natural floor of adversarial review at this depth.
