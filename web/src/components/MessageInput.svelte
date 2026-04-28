<!--
  @component MessageInput
  @description The main message composition area: textarea, formatting
    toolbar (bold/italic/code helpers), code snippet insertion, file
    attachment button, emoji picker trigger, @mention autocomplete with
    overlay-rendered confirmed mentions + ghost suggestions, typing
    indicator display, character counter (warns at 9000, max 10000), and
    send button.

    The @mention layer is built per `plans/mention-autocomplete-revamp.md`:
      - `lib/mentions.js` owns the pure parse/filter/commit helpers
      - this component is the orchestrator: state, cursor tracking, key
        handlers, debounced implicit-commit, recipient resolution at send
      - `MentionDropdown.svelte` is presentational; we feed it the
        candidate list and highlight index

  @prop {object} store - The ChatStore instance for sending messages, typing notifications, and participant data.
  @prop {string} channelName - The current channel name shown in the input placeholder.
  @prop {Array} typingUsers - Array of user objects currently typing in this channel.
  @prop {Function} onOpenEmoji - Callback invoked to open the emoji picker.
-->
<script>
  import MentionDropdown from './MentionDropdown.svelte';
  import { Type, Code, Paperclip, Smile, SendHorizontal } from 'lucide-svelte';
  import {
    parseMentions,
    filterCandidates,
    findExactMatch,
    commitMention,
    renderSegments,
    tokensToRecipients,
    isWordTerminator,
  } from '../lib/mentions.js';

  let { store, channelName, typingUsers = [], onOpenEmoji } = $props();

  const MAX_MESSAGE_LENGTH = 10000;
  const CHAR_WARN_THRESHOLD = 9000;
  /** Idle delay before an exact-match suggestion is silently committed. */
  const IMPLICIT_COMMIT_DEBOUNCE_MS = 200;

  // ── Reactive state ───────────────────────────────────────────────────
  let inputValue = $state('');
  let showFormatHelp = $state(false);
  let attachNotice = $state('');
  let inputEl = $state(null);
  let fileInputEl = $state(null);

  /** @type {Array<{start:number,end:number,name:string,key:string}>} */
  let mentionTokens = $state([]);
  /** @type {{atIndex:number,query:string}|null} */
  let activeSuggestion = $state(null);
  let highlightIndex = $state(0);
  let isComposing = $state(false);

  // Non-reactive cursor tracking — we read these in the input handler to
  // diff old↔new state for parseMentions. Kept off the reactivity graph
  // because they update on every keystroke and don't need to drive UI.
  let prevText = '';
  let prevCursor = 0;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let pendingCommitTimer = null;

  let charCount = $derived(inputValue.length);
  let showCharCounter = $derived(charCount >= CHAR_WARN_THRESHOLD);
  let overLimit = $derived(charCount > MAX_MESSAGE_LENGTH);

  // Candidate list: filtered, sorted, capped per `lib/mentions.js`.
  let candidates = $derived(
    activeSuggestion
      ? filterCandidates(store.participants, activeSuggestion.query, store.userProfile.key)
      : [],
  );

  // The candidate currently highlighted in the dropdown. Defensive against
  // out-of-range indices (e.g. when the candidate list shrinks under the
  // user's feet).
  let highlightedCandidate = $derived(
    candidates.length > 0
      ? candidates[Math.min(Math.max(highlightIndex, 0), candidates.length - 1)]
      : null,
  );

  // Exact-match candidate for the active query — drives implicit commit
  // and the ember-pending overlay coloring.
  let exactMatch = $derived(
    activeSuggestion ? findExactMatch(activeSuggestion.query, candidates) : null,
  );

  // Overlay segments for the mirrored layer.
  let overlaySegments = $derived(
    renderSegments(inputValue, mentionTokens, activeSuggestion, highlightedCandidate, exactMatch),
  );

  let showMentionDropdown = $derived(activeSuggestion !== null);

  // ── Effects ──────────────────────────────────────────────────────────

  // Debounce: when an exact match is present, schedule a silent commit
  // after IMPLICIT_COMMIT_DEBOUNCE_MS of no further keystrokes. The
  // effect's dependencies (inputValue, exactMatch, activeSuggestion)
  // re-fire teardown → setup whenever the user types, which is exactly
  // the cancel + reschedule shape we want. Mirrors the canonical Svelte 5
  // teardown pattern (see $effect docs, Effect teardown example).
  $effect(() => {
    // Read inputValue so the effect re-runs on every edit. Tokens or
    // suggestion changes already imply re-runs via exactMatch /
    // activeSuggestion.
    inputValue;

    if (!(exactMatch && activeSuggestion)) return;
    const captured = { match: exactMatch, suggestion: { ...activeSuggestion } };
    const timer = setTimeout(() => {
      // Re-validate: only commit if the suggestion + match are still the
      // same shape. Otherwise the user has typed past the match.
      if (
        activeSuggestion
        && activeSuggestion.atIndex === captured.suggestion.atIndex
        && activeSuggestion.query.toLowerCase() === captured.match.name.toLowerCase()
      ) {
        commitCandidate(captured.match);
      }
    }, IMPLICIT_COMMIT_DEBOUNCE_MS);
    pendingCommitTimer = timer;
    return () => {
      clearTimeout(timer);
      if (pendingCommitTimer === timer) pendingCommitTimer = null;
    };
  });

  // (Note: the "best match" is always candidates[0] thanks to the sort
  // order in `filterCandidates` — online-first, alpha. We keep
  // highlightIndex as a free state variable so arrow navigation works
  // across re-derivations; `highlightedCandidate` clamps it. When the
  // list shrinks under a stale highlight, the clamp picks a safe item.
  // Resetting back to 0 on every list change would defeat hover, so we
  // only clamp here.)

  // Sync overlay scroll with textarea scroll so long messages line up.
  function handleScroll() {
    const overlay = inputEl?.parentElement?.querySelector('.input-overlay');
    if (overlay && inputEl) {
      overlay.scrollTop = inputEl.scrollTop;
    }
  }

  // ── Parsing ──────────────────────────────────────────────────────────

  /**
   * Run the mention parser using the current textarea state. Updates
   * mentionTokens + activeSuggestion. Skipped during IME composition so
   * we don't thrash candidates while the user is mid-character.
   */
  function reparseMentions() {
    if (isComposing) return;
    const newText = inputValue;
    const newCursor = inputEl ? inputEl.selectionStart : newText.length;
    const r = parseMentions(newText, mentionTokens, prevText, prevCursor, newCursor);
    mentionTokens = r.tokens;
    activeSuggestion = r.activeSuggestion;
    prevText = newText;
    prevCursor = newCursor;
  }

  function handleInput(e) {
    inputValue = e.target.value;
    autoResize(e.target);
    store.notifyTyping();
    reparseMentions();
  }

  function handleSelect() {
    // selectionchange-equivalent for the textarea: cursor moved without
    // a text edit. If we were holding a pending exact match and the
    // cursor moved out of the prefix range, commit immediately.
    if (!inputEl) return;
    const cursor = inputEl.selectionStart;
    if (exactMatch && activeSuggestion) {
      const prefixEnd = activeSuggestion.atIndex + 1 + activeSuggestion.query.length;
      if (cursor < activeSuggestion.atIndex || cursor > prefixEnd) {
        commitCandidate(exactMatch);
        return;
      }
    }
    // Otherwise just refresh `prevCursor` so the next edit's diff is
    // anchored correctly.
    prevCursor = cursor;
  }

  function handleCompositionStart() {
    isComposing = true;
  }

  function handleCompositionEnd() {
    isComposing = false;
    reparseMentions();
  }

  // ── Commit operations ────────────────────────────────────────────────

  /**
   * Commit a specific candidate at the current active suggestion.
   * @param {{name:string,key:string}} candidate
   */
  function commitCandidate(candidate) {
    if (!activeSuggestion) return;
    const atIndex = activeSuggestion.atIndex;
    const queryEnd = atIndex + 1 + activeSuggestion.query.length;
    const r = commitMention(inputValue, mentionTokens, atIndex, queryEnd, candidate);
    inputValue = r.text;
    mentionTokens = r.tokens;
    activeSuggestion = null;
    if (pendingCommitTimer) {
      clearTimeout(pendingCommitTimer);
      pendingCommitTimer = null;
    }
    prevText = inputValue;
    prevCursor = r.newCursor;
    // Restore cursor + focus on the next tick so the textarea is updated
    // before we move the caret.
    queueMicrotask(() => {
      if (inputEl) {
        inputEl.focus();
        inputEl.setSelectionRange(r.newCursor, r.newCursor);
      }
    });
  }

  /**
   * If a pending exact-match commit is queued, fire it synchronously and
   * cancel the timer. Used by send-time forced commit.
   */
  function commitPendingIfMatch() {
    if (pendingCommitTimer) {
      clearTimeout(pendingCommitTimer);
      pendingCommitTimer = null;
    }
    if (exactMatch && activeSuggestion) {
      commitCandidate(exactMatch);
    }
  }

  // ── Keyboard ─────────────────────────────────────────────────────────

  function handleKeydown(e) {
    // Word-terminator → instant commit if exact match is queued. Must
    // happen BEFORE the character is inserted so the terminator lands
    // cleanly after the committed token.
    if (
      e.key.length === 1
      && isWordTerminator(e.key)
      && exactMatch
      && activeSuggestion
      && !isComposing
    ) {
      commitCandidate(exactMatch);
      // Let the default insert proceed; reparseMentions() will fire on
      // the input event that follows.
      return;
    }

    if (activeSuggestion) {
      if (e.key === 'Tab') {
        e.preventDefault();
        if (highlightedCandidate) commitCandidate(highlightedCandidate);
        return;
      }
      if (e.key === 'Enter') {
        // Enter commits the highlighted candidate IF the dropdown is
        // showing real candidates; otherwise falls through to send/newline.
        if (highlightedCandidate && !e.shiftKey) {
          e.preventDefault();
          commitCandidate(highlightedCandidate);
          return;
        }
      }
      if (e.key === 'ArrowDown') {
        if (candidates.length > 0) {
          e.preventDefault();
          highlightIndex = (highlightIndex + 1) % candidates.length;
        }
        return;
      }
      if (e.key === 'ArrowUp') {
        if (candidates.length > 0) {
          e.preventDefault();
          highlightIndex = (highlightIndex - 1 + candidates.length) % candidates.length;
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        activeSuggestion = null;
        if (pendingCommitTimer) {
          clearTimeout(pendingCommitTimer);
          pendingCommitTimer = null;
        }
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
    // Shift+Enter inserts a newline (default textarea behavior).
  }

  /** Auto-resize textarea to fit content, capped at 6 lines (~144px). */
  function autoResize(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 144) + 'px';
  }

  // ── Send ─────────────────────────────────────────────────────────────

  function sendMessage() {
    // Force-commit any pending exact-match before reading recipients so
    // what the user sees is what we send.
    commitPendingIfMatch();

    if (!inputValue.trim()) return;
    if (inputValue.length > MAX_MESSAGE_LENGTH) return;

    const recipients = tokensToRecipients(mentionTokens);
    store.sendMessage(inputValue, null, recipients.length > 0 ? recipients : null);

    inputValue = '';
    mentionTokens = [];
    activeSuggestion = null;
    highlightIndex = 0;
    prevText = '';
    prevCursor = 0;
    if (pendingCommitTimer) {
      clearTimeout(pendingCommitTimer);
      pendingCommitTimer = null;
    }
    if (inputEl) {
      inputEl.style.height = 'auto';
    }
  }

  function handleAttachClick() {
    fileInputEl?.click();
  }

  function handleFileSelected(e) {
    const file = e.target.files?.[0];
    if (file) {
      attachNotice = `File sharing coming soon`;
      setTimeout(() => {
        attachNotice = '';
      }, 3000);
    }
    // Reset so the same file can be re-selected
    e.target.value = '';
  }

  function toggleFormatHelp() {
    showFormatHelp = !showFormatHelp;
  }

  function insertSnippet() {
    const template = '```language\n// code here\n```';
    const cursorPos = inputEl?.selectionStart ?? inputValue.length;
    const before = inputValue.slice(0, cursorPos);
    const after = inputValue.slice(cursorPos);
    inputValue = before + template + after;
    showFormatHelp = false;
    prevText = inputValue;
    // Tokens with start >= cursorPos must shift by template.length.
    mentionTokens = mentionTokens.map((t) =>
      t.start >= cursorPos
        ? { ...t, start: t.start + template.length, end: t.end + template.length }
        : { ...t },
    );
    setTimeout(() => {
      inputEl?.focus();
      const newPos = cursorPos + template.length;
      inputEl?.setSelectionRange(newPos, newPos);
      prevCursor = newPos;
    }, 0);
  }

  // Dropdown event handlers — pure callbacks for the presentational child.
  function handleDropdownHover(i) {
    highlightIndex = i;
  }
  function handleDropdownCommit(candidate) {
    commitCandidate(candidate);
  }
</script>

<div class="input-area">
  {#if typingUsers.length > 0}
    <div class="typing-indicator" data-testid="typing-indicator">
      <div class="typing-wave"><span></span><span></span><span></span><span></span><span></span></div>
      <span>
        {#if typingUsers.length === 1}
          {typingUsers[0].name} is typing...
        {:else if typingUsers.length === 2}
          {typingUsers[0].name} and {typingUsers[1].name} are typing...
        {:else}
          Several people are typing...
        {/if}
      </span>
    </div>
  {/if}

  <div class="input-toolbar">
    <div class="toolbar-btn-wrap">
      <button class="input-toolbar-btn" onclick={toggleFormatHelp} data-testid="input-format">
        <Type size={12} />
        Format
      </button>
      {#if showFormatHelp}
        <div class="format-help" data-testid="format-help">
          <code>**bold**</code>&nbsp;&nbsp;<code>*italic*</code>&nbsp;&nbsp;<code>`code`</code>&nbsp;&nbsp;<code>```code block```</code>
        </div>
      {/if}
    </div>
    <div class="input-toolbar-divider"></div>
    <button class="input-toolbar-btn" onclick={insertSnippet} data-testid="input-snippet">
      <Code size={12} />
      Snippet
    </button>
  </div>

  <div class="input-wrap">
    <div class="textarea-wrap">
      <div class="input-overlay" aria-hidden="true">
        {#each overlaySegments as seg, i (i)}
          {#if seg.type === 'mention-confirmed'}
            <span class="mention-confirmed">{seg.text}</span>
          {:else if seg.type === 'mention-pending'}
            <span class="mention-pending">{seg.text}</span>
          {:else if seg.type === 'ghost'}
            <span class="ghost-suggestion">{seg.text}</span>
          {:else}
            {seg.text}
          {/if}
        {/each}
        {#if inputValue.endsWith('\n')}<span class="overlay-trailing-newline"> </span>{/if}
      </div>
      <textarea
        bind:this={inputEl}
        rows="1"
        placeholder="Message #{channelName}..."
        bind:value={inputValue}
        oninput={handleInput}
        onkeydown={handleKeydown}
        onkeyup={handleSelect}
        onclick={handleSelect}
        onscroll={handleScroll}
        oncompositionstart={handleCompositionStart}
        oncompositionend={handleCompositionEnd}
        aria-controls={showMentionDropdown ? 'mention-listbox' : undefined}
        aria-activedescendant={showMentionDropdown && highlightedCandidate
          ? 'mention-listbox-opt-' + highlightedCandidate.key
          : undefined}
        aria-autocomplete="list"
        data-testid="message-input"
      ></textarea>
    </div>
    <div class="input-bottom-row">
      <div class="input-actions">
        <input
          bind:this={fileInputEl}
          type="file"
          class="hidden-file-input"
          onchange={handleFileSelected}
          data-testid="input-file-hidden"
        />
        <button class="btn-icon" title="Attach file" onclick={handleAttachClick} data-testid="input-attach">
          <Paperclip size={16} />
        </button>
        <button class="btn-icon" title="Add emoji" onclick={onOpenEmoji} data-testid="input-emoji">
          <Smile size={16} />
        </button>
      </div>
      <button class="btn-send" title="Send message" onclick={sendMessage} data-testid="send-button">
        <SendHorizontal size={16} />
      </button>
    </div>
  </div>

  {#if showCharCounter}
    <div class="char-counter" class:over-limit={overLimit} data-testid="char-counter">
      {charCount.toLocaleString()}/{MAX_MESSAGE_LENGTH.toLocaleString()}
      {#if overLimit}
        <span class="limit-warning">— message too long</span>
      {/if}
    </div>
  {/if}

  {#if attachNotice}
    <div class="attach-notice" data-testid="attach-notice">{attachNotice}</div>
  {/if}

  {#if showMentionDropdown}
    <MentionDropdown
      {candidates}
      {highlightIndex}
      onHover={handleDropdownHover}
      onCommit={handleDropdownCommit}
      listboxId="mention-listbox"
    />
  {/if}
</div>

<style>
  .input-area {
    padding: 12px 22px 18px;
    border-top: 1px solid var(--border);
    background: linear-gradient(180deg, var(--bg-base) 0%, #0e0e10 100%);
    position: relative;
    z-index: 2;
  }

  .typing-indicator {
    font-size: 11.5px;
    color: var(--text-muted);
    padding: 0 4px 7px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .typing-wave {
    display: flex;
    align-items: end;
    gap: 2px;
    height: 14px;
  }

  .typing-wave span {
    width: 3px;
    border-radius: 2px;
    background: var(--ember-500);
    animation: waveBar 1.2s ease-in-out infinite;
  }

  .typing-wave span:nth-child(1) { height: 6px; animation-delay: 0s; }
  .typing-wave span:nth-child(2) { height: 10px; animation-delay: 0.1s; }
  .typing-wave span:nth-child(3) { height: 14px; animation-delay: 0.2s; }
  .typing-wave span:nth-child(4) { height: 8px; animation-delay: 0.3s; }
  .typing-wave span:nth-child(5) { height: 4px; animation-delay: 0.4s; }

  .input-toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 4px 6px;
  }

  .input-toolbar-btn {
    padding: 3px 8px;
    border-radius: var(--radius-xs);
    background: none;
    border: none;
    color: var(--text-faint);
    cursor: pointer;
    font-size: 11px;
    font-weight: 500;
    transition: var(--transition-fast);
    display: flex;
    align-items: center;
    gap: 4px;
    font-family: inherit;
  }

  .input-toolbar-btn:hover {
    color: var(--text-secondary);
    background: var(--bg-surface);
  }

  .input-toolbar-divider {
    width: 1px;
    height: 14px;
    background: var(--border);
  }

  .toolbar-btn-wrap {
    position: relative;
  }

  .format-help {
    position: absolute;
    bottom: 100%;
    left: 0;
    margin-bottom: 6px;
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    font-size: 11px;
    color: var(--text-secondary);
    white-space: nowrap;
    z-index: 20;
  }

  .format-help code {
    background: var(--bg-surface);
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 11px;
    color: var(--ember-300);
  }

  .hidden-file-input {
    display: none;
  }

  .char-counter {
    font-size: 11px;
    color: var(--text-faint);
    text-align: right;
    padding: 3px 6px 0;
    font-variant-numeric: tabular-nums;
  }

  .char-counter.over-limit {
    color: #ef4444;
    font-weight: 600;
  }

  .limit-warning {
    font-weight: 400;
  }

  .attach-notice {
    font-size: 11.5px;
    color: var(--text-muted);
    padding: 4px 4px 0;
  }

  .input-wrap {
    display: flex;
    flex-direction: column;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px 12px 4px;
    transition: var(--transition-med);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  }

  .input-bottom-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-top: 4px;
  }

  .input-wrap:focus-within {
    border-color: rgba(245, 158, 11, 0.25);
    box-shadow: 0 0 0 3px var(--border-glow), 0 0 24px rgba(245, 158, 11, 0.04), 0 2px 8px rgba(0, 0, 0, 0.15);
  }

  /* The textarea + overlay sit in a positioned wrapper. Both share the
     same box model so the overlay's spans line up exactly under the
     textarea's text. */
  .textarea-wrap {
    position: relative;
    width: 100%;
  }

  .input-overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    overflow: hidden;
    padding: 4px 0;
    font-size: 14px;
    font-family: inherit;
    line-height: 1.5;
    color: var(--text-primary);
    z-index: 1;
  }

  .input-overlay .mention-confirmed {
    color: var(--ember-300);
    font-weight: 500;
  }

  .input-overlay .mention-pending {
    color: var(--ember-300);
    font-weight: 500;
  }

  .input-overlay .ghost-suggestion {
    color: var(--text-faint);
    font-style: italic;
    opacity: 0.7;
  }

  .input-wrap textarea {
    width: 100%;
    background: none;
    border: none;
    outline: none !important;
    box-shadow: none !important;
    color: transparent;
    caret-color: var(--text-primary);
    font-size: 14px;
    padding: 4px 0;
    font-family: inherit;
    resize: none;
    overflow-y: auto;
    line-height: 1.5;
    min-height: 36px;
    max-height: 180px;
    position: relative;
    z-index: 2;
  }

  .input-wrap textarea:focus-visible {
    outline: none !important;
    box-shadow: none !important;
  }

  .input-wrap textarea::placeholder {
    color: var(--text-faint);
  }

  /* Native selection highlight needs to remain visible despite the
     transparent text color. Use the browser's selection background and
     keep selected text legible. */
  .input-wrap textarea::selection {
    background: rgba(245, 158, 11, 0.32);
    color: var(--text-primary);
  }

  .input-actions {
    display: flex;
    gap: 2px;
  }

  .btn-icon {
    width: 34px;
    height: 34px;
    border-radius: var(--radius-sm);
    border: none;
    background: none;
    color: var(--text-faint);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    transition: var(--transition-fast);
  }

  .btn-icon:hover {
    background: var(--bg-elevated);
    color: var(--text-secondary);
  }

  .btn-send {
    width: 38px;
    height: 38px;
    border-radius: var(--radius-sm);
    border: none;
    background: linear-gradient(135deg, var(--ember-600), var(--ember-400));
    color: #0a0a0c;
    cursor: pointer;
    font-size: 16px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: var(--transition-med);
    box-shadow: 0 2px 10px rgba(245, 158, 11, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.15);
    position: relative;
    overflow: hidden;
  }

  .btn-send:hover {
    filter: brightness(1.1);
    box-shadow: 0 2px 16px rgba(245, 158, 11, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.15);
    transform: translateY(-1px);
  }

  .btn-send::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(135deg, transparent 40%, rgba(255, 255, 255, 0.2) 50%, transparent 60%);
    transform: translateX(-100%);
    transition: none;
  }

  .btn-send:hover::after {
    animation: sendShine 0.6s ease;
  }

  @media (max-width: 480px) {
    .input-area {
      padding: 8px 10px 12px;
    }

    .input-toolbar {
      display: none;
    }

    .input-wrap {
      padding: 2px 4px 2px 10px;
    }
  }
</style>
