<!--
  @component MessageBubble
  @description Renders a single chat message as a styled bubble with avatar, sender name, timestamp, inline mentions, link detection with previews, reactions bar, thread indicator, read receipts, and hover action buttons. Supports consecutive message grouping.
  @prop {object} message - The message object with id, sender, body, ts, reactions, thread_count, and read_by fields.
  @prop {boolean} consecutive - Whether this follows a message from the same sender (hides avatar/name).
  @prop {object} currentUser - The current user's profile for identifying own messages.
  @prop {object} participants - Map of participant keys to participant objects.
  @prop {Function} onOpenThread - Callback invoked with a message to open its thread.
  @prop {Function} onContextMenu - Callback invoked with { x, y, message } for the context menu.
  @prop {Function} onShowProfile - Callback invoked with a participant to show their profile card.
  @prop {Function} onReact - Callback invoked when adding a reaction to a message.
  @prop {Function} onMore - Callback for the "more actions" button.
  @prop {Function} [onRetry] - Callback invoked with `message.id` when the
    user clicks the Retry affordance on a `status === 'failed'` bubble.
    Optional (UX G-62) — older callers that don't wire this just won't
    show a Retry link, and the visual `!` indicator stays.
-->
<script>
  import Avatar from './Avatar.svelte';
  import CodeBlock from './CodeBlock.svelte';
  import MessageActions from './MessageActions.svelte';
  import ReactionBar from './ReactionBar.svelte';
  import ReadReceipt from './ReadReceipt.svelte';
  import LinkPreview from './LinkPreview.svelte';
  import { Lock, AlertCircle } from 'lucide-svelte';
  import { formatTime, parseMentions, getParticipantColor } from '../lib/utils.js';
  import { parseRich as parseRichText } from '../lib/rich-text-parser.js';

  // URL regex for detecting links in message text
  const LINK_REGEX = /https?:\/\/[^\s<>"')\]]+/g;

  /**
   * Parse message body into segments: text, mention, mention-self,
   * mention-other, link, codeblock, and inline-code. Uses the rich-text
   * parser first to extract code tokens (inline chips and triple-tick
   * blocks), then runs the existing mention and URL splitting only over
   * the remaining `text` tokens.
   *
   * Mention validation: a `@word` token is rendered as a pill ONLY when
   * `word` matches the name of an actual participant in the conversation
   * (case-insensitive). Otherwise it falls back to plain text — this avoids
   * the false-positive where literal phrases like "@mention" or "@example"
   * inside ordinary message text would be styled as if they were mentions.
   *
   * Mention classification (per plan §6.3 round-3-revised):
   *
   *   - If `message.mentions` is null/empty → resolved mentions stay as
   *     legacy `mention` (existing styling). Covers backwards compat for
   *     pre-cutover messages, body-prefix-only mentions, and whispers
   *     where the wire field carries no mentions list.
   *   - If `message.mentions` is non-null AND key ∈ mentions AND
   *     key === currentUser.key → `mention-self` (loud, amber chip,
   *     bubble border accent).
   *   - If `message.mentions` is non-null AND key ∈ mentions AND
   *     key ≠ currentUser.key → `mention-other` (quiet grey chip).
   *   - If `message.mentions` is non-null AND key ∉ mentions → legacy
   *     `mention`. Same backwards-compat slot.
   *
   * Sender-self special case: if `currentUser.key === message.sender.key`,
   * any segments classified as `mention-self` are downgraded back to
   * legacy `mention`. Don't loud-notify yourself about your own message.
   *
   * @param {string} body - raw message body
   * @param {Array<{name:string,key:string}>|object} participantsList - array or map of participants
   * @param {object} [msg] - the wire-format message ({ mentions, sender, ... })
   * @param {object} [viewer] - the viewer's profile ({ key, ... })
   */
  function parseBody(body, participantsList, msg, viewer) {
    // Step 1: rich-text parser produces text / inline-code / block-code /
    // unclosed-block tokens.
    const richTokens = parseRichText(body);

    // Build a case-insensitive map name→key for participant resolution.
    // The classification step needs a key (not just a name) because the
    // wire-format `mentions` array carries 8-hex keys, and the
    // sender-self special case compares keys. Accepts either an array
    // of {name,key} objects or a {key:{name,key}} map shape.
    const nameToKey = new Map();
    if (participantsList) {
      const iter = Array.isArray(participantsList)
        ? participantsList
        : Object.values(participantsList);
      for (const p of iter) {
        if (p && typeof p.name === 'string' && typeof p.key === 'string') {
          nameToKey.set(p.name.toLowerCase(), p.key);
        }
      }
    }

    // Pre-compute classification context (cheap, but keeps the inner
    // loop readable). `mentionsSet` is a Set for O(1) `has` lookup;
    // `mentionsActive` distinguishes "no mentions field at all" (legacy
    // / whisper / mentions-null) from "explicit empty mentions array"
    // (which behaves identically to null per §10 case 8).
    const wireMentions = msg && Array.isArray(msg.mentions) ? msg.mentions : null;
    // Whisper gate (per §10 Test #4 + §6.3 R2-C1): when `recipients` is
    // non-empty the bubble is a whisper, and self/other styling is
    // suppressed — body-side @name tokens render as legacy `.mention`
    // chip + whisper bubble. Self/other is a mention-only treatment.
    const isWhisper = !!(msg && Array.isArray(msg.recipients) && msg.recipients.length > 0);
    const mentionsActive = !!(wireMentions && wireMentions.length > 0) && !isWhisper;
    const mentionsSet = mentionsActive ? new Set(wireMentions) : null;
    const viewerKey = viewer && typeof viewer.key === 'string' ? viewer.key : null;
    const senderKey = msg && msg.sender && typeof msg.sender.key === 'string' ? msg.sender.key : null;
    // Sender-self special case (per §6.3 step 4): when the viewer is the
    // sender, downgrade any would-be `mention-self` segment to legacy
    // `.mention` (NOT `mention-other` — the spec is explicit). Don't
    // loud-notify yourself about your own message.
    const viewerIsSender = viewerKey !== null && senderKey !== null && viewerKey === senderKey;

    const result = [];
    for (const t of richTokens) {
      if (t.type === 'inline-code') {
        result.push({ type: 'inline-code', value: t.value });
        continue;
      }
      if (t.type === 'block-code' || t.type === 'unclosed-block') {
        // Existing CodeBlock component handles fenced rendering with shiki;
        // keep that pipeline for parity with the markdown-rendered surface.
        result.push({ type: 'codeblock', language: t.lang || '', code: t.value });
        continue;
      }
      if (t.type === 'bold' || t.type === 'italic' || t.type === 'strike') {
        // Emphasis tokens come from `parseRich` (read-side only). The inner
        // value is plain text (flat-only v1 — no nesting), so mentions/links
        // INSIDE *foo* / **bar** won't render as pills/links. That's a fair
        // tradeoff for v1; we can revisit with a recursive parse if Phil
        // hits a real case.
        result.push({ type: t.type, value: t.value });
        continue;
      }
      // text token: run mention + URL splitting (preserves prior behavior).
      const mentionSegments = parseMentions(t.value);
      for (const mseg of mentionSegments) {
        if (mseg.type === 'mention') {
          // Validate the @-prefixed value against the live participants set.
          // "@foo" → name "foo". Unknown names render as plain text.
          const candidateName = mseg.value.startsWith('@')
            ? mseg.value.slice(1).toLowerCase()
            : mseg.value.toLowerCase();
          const resolvedKey = nameToKey.get(candidateName);
          if (resolvedKey === undefined) {
            // Unknown participant — render as plain text (existing
            // behavior, prevents "@example" literal chips).
            result.push({ type: 'text', value: mseg.value });
            continue;
          }
          // Resolved to a real participant. Classify against the wire
          // `mentions` field to pick render branch.
          //
          // Display name without the leading "@" — the render branches
          // for mention-self/mention-other reconstruct the "@" so they
          // can apply chip styling to the whole token uniformly.
          const displayName = mseg.value.startsWith('@') ? mseg.value.slice(1) : mseg.value;
          if (mentionsActive && mentionsSet.has(resolvedKey)) {
            if (resolvedKey === viewerKey) {
              if (viewerIsSender) {
                // Sender-self special case (§6.3 step 4): viewer IS the
                // sender. Downgrade to legacy `.mention` — not loud,
                // and not "other" either. Don't loud-notify yourself.
                result.push(mseg);
              } else {
                // Self-mention. Loud styling. The bubble border accent
                // is computed from `bodySegments` after parseBody
                // returns.
                result.push({ type: 'mention-self', name: displayName, key: resolvedKey });
              }
            } else {
              // Other-mention. Quiet styling. Includes the case where
              // the sender is the viewer AND someone ELSE is also
              // mentioned — the loop only sees one segment per `@name`
              // token, and this branch handles the non-self ones.
              result.push({ type: 'mention-other', name: displayName, key: resolvedKey });
            }
          } else {
            // Legacy / unkeyed / whisper / mentions-inactive — keep the
            // existing chip styling. Backwards-compat slot, also covers
            // whisper-with-named-recipient per §6.3 R2-C1.
            result.push(mseg);
          }
          continue;
        }
        if (mseg.type !== 'text') {
          result.push(mseg);
          continue;
        }
        let lastIndex = 0;
        let match;
        LINK_REGEX.lastIndex = 0;
        while ((match = LINK_REGEX.exec(mseg.value)) !== null) {
          if (match.index > lastIndex) {
            result.push({ type: 'text', value: mseg.value.slice(lastIndex, match.index) });
          }
          result.push({ type: 'link', value: match[0] });
          lastIndex = match.index + match[0].length;
        }
        if (lastIndex < mseg.value.length) {
          result.push({ type: 'text', value: mseg.value.slice(lastIndex) });
        }
      }
    }

    // Coalesce adjacent text segments that result from invalid-mention
    // rewriting (e.g. "literal @mention here" becomes 3 text segments;
    // joining them keeps the rendered output identical to a single
    // text node and avoids stray inline boundaries the user could see
    // as a layout artifact). Same-type, same-attribute segments only.
    const coalesced = [];
    for (const seg of result) {
      const prev = coalesced[coalesced.length - 1];
      if (prev && prev.type === 'text' && seg.type === 'text') {
        prev.value += seg.value;
      } else {
        coalesced.push(seg);
      }
    }
    return coalesced;
  }

  let { message, consecutive = false, currentUser, participants, onOpenThread, onContextMenu, onShowProfile, onReact, onMore, onRetry } = $props();

  // UX G-62 status visualization. Derived booleans drive the bubble badges
  // (spinner / failed indicator + retry link). Messages without a `status`
  // field (anything that arrived via MQTT from another sender, or any
  // legacy local-echo message) are treated as fully delivered — `isSent`
  // collapses to a no-op. Only outgoing messages from this client carry
  // the status field today.
  let isSending = $derived(message.status === 'sending');
  let isFailed = $derived(message.status === 'failed');

  let isHuman = $derived(message.sender.type === 'human');
  let isMine = $derived(message.sender.key === currentUser?.key);
  let isTargeted = $derived(message.recipients && message.recipients.length > 0);
  let senderColor = $derived(getParticipantColor(message.sender.key));
  let bodySegments = $derived(parseBody(message.body, participants, message, currentUser));
  // True iff ANY rendered segment is `mention-self` — drives the bubble
  // border accent (`.has-self-mention`). The sender-self downgrade is
  // already applied in parseBody, so this naturally returns false for
  // the sender's own bubble and won't paint the loud border on it.
  let hasSelfMention = $derived(bodySegments.some(s => s.type === 'mention-self'));
  let hasCode = $derived(message.body.includes('```'));

  // Detect URLs in message body for link previews
  const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g;
  let detectedUrls = $derived.by(() => {
    const matches = message.body.match(URL_REGEX);
    if (!matches) return [];
    // Deduplicate and limit to 3 previews per message
    return [...new Set(matches)].slice(0, 3).map(url => {
      try {
        const parsed = new URL(url);
        return { url, domain: parsed.hostname.replace(/^www\./, '') };
      } catch {
        return null;
      }
    }).filter(Boolean);
  });

  function handleContext(e) {
    e.preventDefault();
    onContextMenu({ x: e.clientX, y: e.clientY, message });
  }

  function handleAvatarClick() {
    const p = participants[message.sender.key] || message.sender;
    onShowProfile(p);
  }
</script>

<div
  class="msg-row"
  class:claude={!isHuman}
  class:human={isHuman}
  class:consecutive
  class:has-code={hasCode}
  class:targeted={isTargeted}
  oncontextmenu={handleContext}
  data-testid="message-{message.id}"
  data-message-id={message.id}
  role="article"
  aria-label="Message from {message.sender.name}"
>
  {#if !consecutive}
    <Avatar
      name={message.sender.name}
      gradient={senderColor.gradient}
      onClick={handleAvatarClick}
    />
  {:else}
    <div class="avatar-spacer"></div>
  {/if}

  <div class="bubble-wrap">
    {#if !consecutive}
      <div class="sender-line">
        <span
          class="sender-name"
          style="color: {senderColor.textColor}"
          data-testid="message-sender-{message.sender.key}"
          onclick={handleAvatarClick}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleAvatarClick(); }}
          role="button"
          tabindex="0"
        >{message.sender.name}</span>
        <span class="msg-time">{formatTime(message.ts)}</span>
      </div>
    {/if}

    {#if isTargeted}
      <div class="targeted-label">
        <Lock size={10} />
        <span>Targeted message</span>
      </div>
    {/if}

    <div class="bubble" class:bubble-targeted={isTargeted} class:has-self-mention={hasSelfMention}>
      {#each bodySegments as seg, i (i)}
        {#if seg.type === 'mention'}
          <span class="mention">{seg.value}</span>
        {:else if seg.type === 'mention-self'}
          <span class="mention-chip-self">@{seg.name}</span>
        {:else if seg.type === 'mention-other'}
          <span class="mention-chip-other">@{seg.name}</span>
        {:else if seg.type === 'link'}
          <a class="inline-link" href={seg.value} target="_blank" rel="noopener noreferrer">{seg.value}</a>
        {:else if seg.type === 'codeblock'}
          <CodeBlock language={seg.language} code={seg.code} />
        {:else if seg.type === 'inline-code'}
          <span class="code-chip">{seg.value}</span>
        {:else if seg.type === 'bold'}
          <strong class="md-bold">{seg.value}</strong>
        {:else if seg.type === 'italic'}
          <em class="md-italic">{seg.value}</em>
        {:else if seg.type === 'strike'}
          <span class="md-strike">{seg.value}</span>
        {:else}
          {seg.value}
        {/if}
      {/each}
    </div>

    {#each detectedUrls as link (link.url)}
      <LinkPreview
        url={link.url}
        domain={link.domain}
        title={link.domain}
      />
    {/each}

    {#if message.reactions?.length}
      <ReactionBar
        reactions={message.reactions}
        onAddReaction={() => onReact?.(message)}
        onToggleReaction={(emoji) => onReact?.(message, emoji)}
      />
    {/if}

    {#if message.thread_reply_count}
      <div class="thread-indicator" class:has-unread={message.thread_unread_count > 0} onclick={() => onOpenThread(message)} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onOpenThread(message); }} role="button" tabindex="0" data-testid="thread-indicator">
        <span class="thread-count">{message.thread_reply_count} {message.thread_reply_count === 1 ? 'reply' : 'replies'}</span>
        {#if message.thread_last_author}
          <span class="thread-last-author">· last by @{message.thread_last_author}</span>
        {/if}
      </div>
    {/if}

    {#if isMine && message.read_by}
      <ReadReceipt count={message.read_by} />
    {/if}

    {#if isSending}
      <div class="msg-status msg-status-sending" data-testid="msg-status-sending" aria-label="Sending">
        <span class="spinner" aria-hidden="true"></span>
        <span class="msg-status-label">Sending…</span>
      </div>
    {:else if isFailed}
      <div class="msg-status msg-status-failed" data-testid="msg-status-failed">
        <AlertCircle size={12} aria-hidden="true" />
        <span class="msg-status-label">Failed to send</span>
        {#if onRetry}
          <button
            type="button"
            class="msg-retry"
            data-testid="msg-retry"
            onclick={() => onRetry(message.id)}
          >Retry</button>
        {/if}
      </div>
    {/if}
  </div>

  <MessageActions
    {message}
    onReply={() => onOpenThread(message)}
    onReact={() => onReact?.(message)}
    onMore={(e) => {
      const btn = e?.currentTarget || e?.target;
      if (btn) {
        const rect = btn.getBoundingClientRect();
        onContextMenu({ x: rect.left, y: rect.bottom + 4, message });
      } else {
        onContextMenu({ x: 0, y: 0, message });
      }
    }}
  />

  {#if consecutive}
    <span class="hover-time">{formatTime(message.ts, 'short')}</span>
  {/if}
</div>

<style>
  .msg-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    max-width: 72%;
    width: fit-content;
    min-width: 0;
    transition: background var(--transition-fast);
    padding: 5px 10px;
    border-radius: var(--radius);
    position: relative;
    animation: msgAppear 0.3s ease-out both;
  }

  .msg-row:hover { background: rgba(245,158,11,0.025); }
  .msg-row.human { align-self: flex-end; flex-direction: row-reverse; }
  .msg-row.has-code { max-width: 80%; }

  .msg-row + :global(.msg-row:not(.consecutive)) { margin-top: 12px; }

  .msg-row.consecutive.claude { padding-left: 52px; }
  .msg-row.consecutive.human { padding-right: 52px; }

  .msg-row.claude:hover::after {
    content: '';
    position: absolute;
    left: 0;
    top: 4px;
    bottom: 4px;
    width: 2px;
    border-radius: 2px;
    background: linear-gradient(180deg, transparent, rgba(52,211,153,0.3), transparent);
    animation: accentFade 0.3s ease;
  }

  .msg-row.human:hover::after {
    content: '';
    position: absolute;
    right: 0;
    top: 4px;
    bottom: 4px;
    width: 2px;
    border-radius: 2px;
    background: linear-gradient(180deg, transparent, rgba(245,158,11,0.3), transparent);
    animation: accentFade 0.3s ease;
  }

  .avatar-spacer {
    width: 34px;
    flex-shrink: 0;
    visibility: hidden;
  }

  .bubble-wrap {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .msg-row.human .bubble-wrap { align-items: flex-end; }

  .sender-line {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 0 4px;
  }

  .sender-name {
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    transition: var(--transition-fast);
    letter-spacing: -0.15px;
    text-shadow: 0 0 20px currentColor;
  }

  .sender-name:hover { filter: brightness(1.2); }

  .msg-time {
    font-size: 10.5px;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }

  .bubble {
    padding: 11px 16px;
    border-radius: var(--radius);
    font-size: 14px;
    line-height: 1.65;
    word-wrap: break-word;
    overflow-wrap: anywhere;
    position: relative;
    /* Allow flex/grid parents to constrain the bubble's width so a wide
       inner CodeBlock can't push the bubble past its container's max-width
       (Phil v2 bug: long unclosed code-block content overflowed the chat
       column). min-width:0 lets the bubble shrink below its content's
       intrinsic width; max-width:100% caps it to its flex parent. */
    min-width: 0;
    max-width: 100%;
  }

  .msg-row.claude .bubble {
    background: var(--bg-bubble-claude);
    border: 1px solid var(--border);
    border-radius: 4px 14px 14px 14px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.15);
  }

  .msg-row.human .bubble {
    background: var(--bg-bubble-human);
    border: 1px solid rgba(180,83,9,0.2);
    border-radius: 14px 4px 14px 14px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.15), inset 0 0 20px rgba(245,158,11,0.02);
  }

  .msg-row.consecutive.claude .bubble { border-top-left-radius: 4px; border-bottom-left-radius: 4px; }
  .msg-row.consecutive.human .bubble { border-top-right-radius: 4px; border-bottom-right-radius: 4px; }

  .mention {
    background: rgba(245,158,11,0.12);
    color: var(--ember-400);
    padding: 1px 7px;
    border-radius: 6px;
    font-weight: 600;
    font-size: 13px;
    box-shadow: 0 0 8px rgba(245,158,11,0.06);
    cursor: pointer;
    transition: var(--transition-fast);
    text-decoration: none;
  }

  .mention:hover {
    background: rgba(245,158,11,0.22);
    box-shadow: 0 0 12px rgba(245,158,11,0.12);
  }

  /* Self-mention chip — loud, amber, attention-grabbing. Fires only when
     the wire-format `mentions` array carries the viewer's own key AND
     the viewer is NOT the sender (sender-self special case downgrades
     to legacy `.mention` in parseBody). Tokens defined in app.css. */
  .mention-chip-self {
    background: var(--mention-self-bg);
    color: var(--mention-self-fg);
    padding: 1px 7px;
    border-radius: 6px;
    font-weight: 700;
    font-size: 13px;
    box-shadow: 0 0 10px rgba(245, 158, 11, 0.18);
    cursor: pointer;
    transition: var(--transition-fast);
    text-decoration: none;
  }

  .mention-chip-self:hover {
    filter: brightness(1.08);
    box-shadow: 0 0 14px rgba(245, 158, 11, 0.28);
  }

  /* Other-mention chip — quieter, neutral grey. Visible enough to read
     as a chip, dim enough to not compete for the viewer's attention
     (since this mention isn't FOR them). Tokens defined in app.css. */
  .mention-chip-other {
    background: var(--mention-other-bg);
    color: var(--mention-other-fg);
    padding: 1px 7px;
    border-radius: 6px;
    font-weight: 500;
    font-size: 13px;
    cursor: pointer;
    transition: var(--transition-fast);
    text-decoration: none;
  }

  .mention-chip-other:hover {
    filter: brightness(1.12);
  }

  /* Bubble border accent for self-mention. Lands on the bubble root
     (NOT msg-row) so it scopes to just the speech bubble, alongside the
     existing rounded corners. The 3px amber stripe is the visual peer
     of the loud self-chip — together they form the "this is for you"
     signal. Whisper styling (`.bubble-targeted`) is independent and
     stacks fine since it modifies border-style/color/background, not
     border-left-width. */
  .bubble.has-self-mention {
    border-left: 3px solid var(--mention-self-border);
  }

  .code-chip {
    font-family: var(--font-mono, 'SF Mono', Consolas, monospace);
    font-size: 0.92em;
    background: var(--code-chip-bg);
    color: var(--code-chip-fg);
    border: 1px solid var(--code-chip-border);
    border-radius: 6px;
    padding: 1px 6px;
    line-height: 1;
    display: inline-block;
    transform: translateY(0.5px);
    word-break: break-word;
  }

  /* Markdown emphasis tokens emitted by parseRich (read-side only).
     Bold widens glyph metrics; italic shears them. Both are fine in
     final-rendered chat bubbles since there's no caret to align here.
     The composer overlay never sees these tokens (it uses bare `parse`),
     so textarea↔overlay alignment is preserved. */
  .md-bold {
    font-weight: 700;
  }

  .md-italic {
    font-style: italic;
  }

  .md-strike {
    text-decoration: line-through;
    text-decoration-thickness: 1.5px;
    text-decoration-color: currentColor;
  }

  .inline-link {
    color: var(--ember-400);
    text-decoration: underline;
    text-decoration-color: rgba(245,158,11,0.3);
    text-underline-offset: 2px;
    word-break: break-all;
    transition: var(--transition-fast);
  }

  .inline-link:hover {
    text-decoration-color: var(--ember-400);
    filter: brightness(1.15);
  }

  .thread-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    margin-top: 4px;
    font-size: 11px;
    color: var(--text-muted);
    cursor: pointer;
    transition: var(--transition-fast);
    border-radius: 6px;
  }

  .thread-indicator:hover {
    background: var(--bg-surface);
    color: var(--ember-400);
  }

  .thread-count {
    font-weight: 600;
    color: var(--ember-400);
  }

  .thread-last-author {
    font-weight: 400;
    color: var(--text-muted);
    margin-left: 2px;
  }

  .thread-indicator.has-unread {
    background: rgba(245, 158, 11, 0.08);
    border-left: 2px solid var(--ember-400);
    padding-left: 6px;
  }

  .thread-indicator.has-unread .thread-count::after {
    content: " (new)";
    font-weight: 500;
    color: var(--ember-300, var(--ember-400));
    font-size: 10px;
  }

  /* Hover-time tooltip — appears centered ABOVE the bubble on hover.
     Per Phil: putting it overhead (not to the side) keeps the chat layout
     stable when a user click-drags across multiple bubbles to copy text;
     a side-anchored tooltip would interrupt the drag selection rectangle
     and block text selection on neighboring messages.

     Positioned absolutely against the .msg-row, anchored at the bubble's
     top edge with a small upward offset. `pointer-events: none` so the
     tooltip never intercepts the user's drag-select gesture. */
  .hover-time {
    position: absolute;
    bottom: calc(100% + 2px);
    left: 50%;
    transform: translateX(-50%);
    font-size: 10px;
    color: var(--text-faint);
    background: var(--bg-elevated);
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle, var(--border));
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.18);
    opacity: 0;
    transition: opacity var(--transition-fast);
    white-space: nowrap;
    pointer-events: none;
    z-index: 5;
  }

  /* Human bubbles align right, but the tooltip stays centered above the
     bubble — overriding the legacy left/right anchoring with simple
     transform-centering. */
  .msg-row.human .hover-time { left: 50%; right: auto; transform: translateX(-50%); }
  .msg-row:hover .hover-time { opacity: 1; }

  /* ── Targeted (whisper) messages ── */
  .targeted-label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    color: var(--text-faint);
    padding: 0 4px 2px;
    opacity: 0.7;
  }

  .bubble-targeted {
    border-style: dashed !important;
    border-color: rgba(148, 130, 100, 0.3) !important;
    background: rgba(148, 130, 100, 0.04) !important;
  }

  /* ── UX G-62: per-message delivery status ── */
  .msg-status {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 10.5px;
    padding: 2px 6px;
    margin-top: 2px;
    border-radius: var(--radius-sm, 6px);
    line-height: 1.4;
    font-variant-numeric: tabular-nums;
  }

  .msg-status-sending {
    color: var(--text-faint);
  }

  .msg-status-failed {
    color: #f87171;
    background: rgba(239, 68, 68, 0.07);
    border: 1px solid rgba(239, 68, 68, 0.25);
  }

  .msg-status-label {
    /* nothing — kept as a hook for theming */
  }

  /* Inline spinner for the 'sending' state — pure-CSS rotation so we don't
     drag in a runtime animation dependency. Sized to match the failed-
     state AlertCircle (12px) for visual parity. */
  .spinner {
    display: inline-block;
    width: 10px;
    height: 10px;
    border: 1.5px solid rgba(255, 255, 255, 0.18);
    border-top-color: var(--text-muted, #999);
    border-radius: 50%;
    animation: msg-status-spin 0.85s linear infinite;
  }

  @keyframes msg-status-spin {
    to { transform: rotate(360deg); }
  }

  .msg-retry {
    background: transparent;
    border: 0;
    padding: 0 4px;
    margin-left: 2px;
    color: #fbbf24;
    font-size: 10.5px;
    font-weight: 600;
    cursor: pointer;
    text-decoration: underline;
    text-decoration-color: rgba(251, 191, 36, 0.4);
  }

  .msg-retry:hover {
    color: #fcd34d;
    text-decoration-color: var(--ember-400, #fbbf24);
  }
</style>
