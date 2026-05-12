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
    tokensToMentions,
    isWordTerminator,
  } from '../lib/mentions.js';
  import { parseDM } from '../lib/dm-parser.js';
  import { parseReply } from '../lib/reply-parser.js';
  import { composeOverlaySegments } from '../lib/compose-overlay-segments.js';
  import { inlineChipAtCaret } from '../lib/rich-text-parser.js';

  let { store, channelName, typingUsers = [], onOpenEmoji } = $props();

  const MAX_MESSAGE_LENGTH = 10000;
  const CHAR_WARN_THRESHOLD = 9000;
  /** Idle delay before an exact-match suggestion is silently committed. */
  const IMPLICIT_COMMIT_DEBOUNCE_MS = 200;

  // ── Reactive state ───────────────────────────────────────────────────
  let inputValue = $state('');
  let showFormatHelp = $state(false);
  let attachNotice = $state('');
  /**
   * Transient feedback string surfaced after the "Convert to artifact" CTA
   * (G-28 over-limit handling). v0.3.3 stub: the full artifact-create flow
   * doesn't exist yet, so the CTA copies the composer contents to clipboard
   * and shows this string for ~3s. Reuses the same visual treatment as
   * `attachNotice` so we don't introduce a parallel toast surface inside the
   * input area. The proper App-level toast pickup also fires via a
   * `requestToast` CustomEvent (see convertToArtifact).
   */
  let convertNotice = $state('');
  let inputEl = $state(null);
  let fileInputEl = $state(null);
  /**
   * The container element for this composer. We dispatch the
   * `requestToast` CustomEvent from here so a future App-level listener can
   * intercept it without coupling MessageInput to the App toast list shape.
   * Bound via `bind:this` on the outer .input-area div.
   */
  let rootEl = $state(null);
  /**
   * Inline composer error string (e.g. /dm parser rejection). Surfaces
   * below the textarea when non-null. Auto-clears on the next user input
   * event so the user can fix and resend without an explicit dismiss.
   * @type {string | null}
   */
  let composerError = $state(null);

  /** @type {Array<{start:number,end:number,name:string,key:string}>} */
  let mentionTokens = $state([]);
  /** @type {{atIndex:number,query:string}|null} */
  let activeSuggestion = $state(null);
  let highlightIndex = $state(0);
  let isComposing = $state(false);

  // ── Block-entry state (v2 per backtick-highlighting-plan §5.1 / §5.1.1) ─
  //
  // When a triple-backtick fence is opened (either via Trigger A — a complete
  // ```...``` pair already present at caret — or Trigger B — the early-trigger
  // gesture: ``` on its own line then Shift+Enter or Space), the composer
  // swaps focus to a dedicated block textarea below the inline one. Body
  // characters live in `blockMode.body` (NOT in `inputValue`); on send we
  // synthesize the closed ```lang\nbody\n``` and splice into inline at
  // `fenceLineStart`.
  //
  // Esc-exits restore the pre-entry source for Trigger B (gesture undone) or
  // collapse to inline-mode-with-body-preserved for Trigger A.
  /** @type {null | { trigger: 'A'|'B', fenceLineStart: number, langTag: string|null, body: string, preEntryInputValue: string, preEntryCaret: number }} */
  let blockMode = $state(null);
  let blockEl = $state(null);

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

  // Overlay segments for the mirrored layer. Composes BOTH the rich-text
  // (backtick) parser output AND the mention-overlay output into a single
  // segment list. Inside code chips/blocks, mentions render verbatim
  // (Phil's spec: code is verbatim; no nested formatting).
  let overlaySegments = $derived(
    composeOverlaySegments(
      inputValue,
      mentionTokens,
      activeSuggestion,
      highlightedCandidate,
      exactMatch,
    ),
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

  // Composer-prefill watcher (plan §11 Phase C, R2-C3 fix). When
  // ProfileCard / UserProfileView wants to start a DM, it sets
  // `store.composerPrefill = '/dm @<name> '`. We pick that up here, splice
  // into the textarea, focus + position cursor at end, then clear the
  // store-side field so the same value can be re-fired (e.g. when the user
  // closes and re-opens the same profile card without typing).
  //
  // Replaces the prior `document.querySelector` + synthetic input-event
  // path in App.svelte (lines 374-384, 434-444) which didn't update Svelte
  // state cleanly and bypassed the autocomplete pipeline.
  $effect(() => {
    // Tolerate `undefined` (test stores that don't declare the field) and
    // `null` (the cleared idle state). Only fire when a non-empty string
    // arrives.
    const text = store.composerPrefill;
    if (typeof text !== 'string') return;
    inputValue = text;
    // Clear immediately so subsequent identical assignments still re-fire
    // this effect (the runes proxy compares `null` ≠ next non-null value).
    store.composerPrefill = null;
    // Re-anchor diff state so the next keystroke parses cleanly.
    prevText = text;
    prevCursor = text.length;
    composerError = null;
    // Focus + caret-at-end on the next microtask after Svelte flushes the
    // value binding into the DOM.
    queueMicrotask(() => {
      if (inputEl) {
        inputEl.focus();
        inputEl.setSelectionRange(text.length, text.length);
        autoResize(inputEl);
        ensureCaretVisible(inputEl);
      }
    });
  });

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
    ensureCaretVisible(e.target);
    // Auto-clear any inline composer error on the next keystroke so the
    // user can correct and retry without a separate dismiss action.
    if (composerError !== null) composerError = null;
    store.notifyTyping();
    reparseMentions();
  }

  // ── Block-entry helpers ──────────────────────────────────────────────

  /**
   * Detect whether the current caret line in the inline textarea matches the
   * Trigger B precondition (§5.1.1):
   *   - Caret is on a line whose contents are EXACTLY ``` plus optional
   *     language tag (after trimming trailing whitespace).
   *   - That line is at start-of-source OR preceded by a newline.
   *
   * Returns `{ lineStart, lineEnd, langTag }` if the precondition holds, else
   * `null`. `lineEnd` is the offset just before the trailing newline (or end
   * of source if no trailing newline).
   *
   * @param {string} source
   * @param {number} caret
   * @returns {{lineStart:number, lineEnd:number, langTag:string|null} | null}
   */
  function detectTriggerBLine(source, caret) {
    if (typeof source !== 'string' || caret < 0 || caret > source.length) return null;
    // Find line start: walk back to start-of-source or previous '\n'.
    let lineStart = caret;
    while (lineStart > 0 && source.charCodeAt(lineStart - 1) !== 0x0a) lineStart--;
    // Line must start at beginning of source OR after a \n. Both already
    // satisfied by the walk-back above.
    // Find line end: walk forward to next '\n' or EOF.
    let lineEnd = caret;
    while (lineEnd < source.length && source.charCodeAt(lineEnd) !== 0x0a) lineEnd++;

    const lineContent = source.slice(lineStart, lineEnd);
    // Must start with exactly three backticks (no more, no less in the prefix).
    // Allow trailing whitespace which we trim.
    if (lineContent.length < 3) return null;
    if (
      lineContent.charCodeAt(0) !== 0x60 ||
      lineContent.charCodeAt(1) !== 0x60 ||
      lineContent.charCodeAt(2) !== 0x60
    ) return null;
    // 4th character (if present) must NOT be a backtick — otherwise this is
    // 4+ ticks which is not a valid fence per the v3 spec.
    if (lineContent.length >= 4 && lineContent.charCodeAt(3) === 0x60) return null;

    // After the fence, optional language tag. The lang tag must be a simple
    // identifier-like token — letters/digits/-/+/_ — followed only by
    // whitespace until line end. Anything else (e.g. `` ``` foo bar ``)
    // disqualifies (§5.1.1 edge case: extra chars beyond fence + lang tag).
    const rest = lineContent.slice(3);
    const trimmed = rest.replace(/\s+$/, ''); // trim trailing whitespace
    if (trimmed === '') {
      return { lineStart, lineEnd, langTag: null };
    }
    // The lang token: leading whitespace allowed? No — Claude Desktop accepts
    // ```python (no space) but typically not ``` python. Be conservative:
    // accept either, but the lang tag is the trimmed remainder.
    const langCandidate = trimmed.replace(/^\s+/, '');
    if (!/^[A-Za-z0-9_+\-.#]+$/.test(langCandidate)) return null;
    return { lineStart, lineEnd, langTag: langCandidate };
  }

  /**
   * Enter block-entry mode via Trigger B (early-trigger gesture).
   * Strips the fence line from `inputValue`, captures the lang tag, opens the
   * block textarea, focuses it. Caller handles `e.preventDefault()` so the
   * trigger keystroke (Shift+Enter or Space) is consumed.
   *
   * @param {{lineStart:number, lineEnd:number, langTag:string|null}} det
   */
  function enterBlockModeTriggerB(det) {
    const preEntryInputValue = inputValue;
    const preEntryCaret = inputEl ? inputEl.selectionStart : preEntryInputValue.length;

    // Strip the fence line. If the line has a trailing newline, also strip
    // that — we don't want to leave a bare blank line where the fence used
    // to be (§5.1.1: "fence chars are removed from source").
    const lineEndIncludingNewline =
      det.lineEnd < preEntryInputValue.length && preEntryInputValue.charCodeAt(det.lineEnd) === 0x0a
        ? det.lineEnd + 1
        : det.lineEnd;
    const newInline =
      preEntryInputValue.slice(0, det.lineStart) +
      preEntryInputValue.slice(lineEndIncludingNewline);

    inputValue = newInline;
    blockMode = {
      trigger: 'B',
      fenceLineStart: det.lineStart,
      langTag: det.langTag,
      body: '',
      preEntryInputValue,
      preEntryCaret,
    };

    // Move caret in the inline textarea to where the fence used to start
    // (re-anchor diff state). The block textarea will receive focus AFTER
    // it mounts — Svelte's bind:this fires post-flush, so a queueMicrotask
    // can fire before blockEl is assigned. Use a small chain of fallbacks:
    // try microtask first (works in tests under jsdom), fall back to
    // requestAnimationFrame which guarantees post-render in real browsers.
    prevText = newInline;
    prevCursor = det.lineStart;
    const focusBlock = () => {
      if (blockEl) {
        blockEl.focus();
        blockEl.setSelectionRange(0, 0);
      }
    };
    queueMicrotask(() => {
      if (inputEl) inputEl.setSelectionRange(det.lineStart, det.lineStart);
      focusBlock();
      if (!blockEl && typeof requestAnimationFrame !== 'undefined') {
        requestAnimationFrame(() => {
          focusBlock();
          if (!blockEl) {
            // Last-resort: try once more after a paint.
            requestAnimationFrame(focusBlock);
          }
        });
      }
    });
  }

  /**
   * Exit block mode and synthesize a complete fenced block back into the
   * inline source. Used on close-fence-typed-in-block, on send, and on Esc
   * (Trigger A path — body preserved).
   *
   * @param {{exitMode: 'commit'|'esc-A'|'esc-B-empty'|'fence-dissolve'}} opts
   */
  function exitBlockMode(opts = { exitMode: 'commit' }) {
    if (!blockMode) return;
    const bm = blockMode;
    if (opts.exitMode === 'esc-B-empty') {
      // Restore pre-entry inline source verbatim — undo the gesture entirely.
      inputValue = bm.preEntryInputValue;
      const restoreCaret = bm.preEntryCaret;
      blockMode = null;
      prevText = inputValue;
      prevCursor = restoreCaret;
      queueMicrotask(() => {
        if (inputEl) {
          inputEl.focus();
          inputEl.setSelectionRange(restoreCaret, restoreCaret);
        }
      });
      return;
    }

    // Synthesize the closed block source: `\`\`\`lang?\nbody\n\`\`\``.
    // Body may be empty; we still emit a syntactically complete block on
    // commit so MessageBubble parses it as block-code.
    const langPart = bm.langTag ? bm.langTag : '';
    const bodyPart = bm.body;
    // Ensure body doesn't already end in a stray newline; we always emit a
    // single \n between body and closing fence.
    const synthesized = '```' + langPart + '\n' + bodyPart + '\n```';

    if (opts.exitMode === 'fence-dissolve') {
      // §5.4 fence-dissolve-merge: opening fence and closing fence both
      // dissolve; body merges back as plain text at fenceLineStart.
      const before = inputValue.slice(0, bm.fenceLineStart);
      const after = inputValue.slice(bm.fenceLineStart);
      inputValue = before + bodyPart + after;
      const restoreCaret = bm.fenceLineStart + bodyPart.length;
      blockMode = null;
      prevText = inputValue;
      prevCursor = restoreCaret;
      queueMicrotask(() => {
        if (inputEl) {
          inputEl.focus();
          inputEl.setSelectionRange(restoreCaret, restoreCaret);
        }
      });
      return;
    }

    // Default: commit / esc-A — splice the synthesized block into inline
    // source at the fence line start.
    const before = inputValue.slice(0, bm.fenceLineStart);
    const after = inputValue.slice(bm.fenceLineStart);
    // If the splice point is mid-line (not the start of a line), prepend a
    // newline so the fence sits on its own line (parser correctness).
    const needsLeadingNewline =
      bm.fenceLineStart > 0 && inputValue.charCodeAt(bm.fenceLineStart - 1) !== 0x0a;
    const insert = (needsLeadingNewline ? '\n' : '') + synthesized;
    // If the next character isn't a newline, append one so subsequent text
    // doesn't bleed into the closing fence line.
    const insertWithTrailing = after.length > 0 && after.charCodeAt(0) !== 0x0a
      ? insert + '\n'
      : insert;
    inputValue = before + insertWithTrailing + after;
    const restoreCaret = before.length + insertWithTrailing.length;
    blockMode = null;
    prevText = inputValue;
    prevCursor = restoreCaret;
    queueMicrotask(() => {
      if (inputEl) {
        inputEl.focus();
        inputEl.setSelectionRange(restoreCaret, restoreCaret);
      }
    });
  }

  function handleBlockInput(e) {
    if (!blockMode) return;
    const newBody = e.target.value;
    // Detect close-fence-typed-on-own-line: scan body for a line consisting
    // only of ``` (optionally trailing whitespace). When found, commit the
    // block (body up to that line) and exit; remainder after the close goes
    // back into inline source.
    const lines = newBody.split('\n');
    let closeIdx = -1;
    for (let li = 0; li < lines.length; li++) {
      const trimmed = lines[li].replace(/\s+$/, '');
      if (trimmed === '```') {
        closeIdx = li;
        break;
      }
    }
    if (closeIdx !== -1) {
      // Body is everything before the close-fence line.
      const bodyLines = lines.slice(0, closeIdx);
      const tailLines = lines.slice(closeIdx + 1);
      blockMode = { ...blockMode, body: bodyLines.join('\n') };
      const tail = tailLines.join('\n');
      // Commit, then append `tail` back into inline source.
      const bm = blockMode;
      const langPart = bm.langTag ? bm.langTag : '';
      const synthesized = '```' + langPart + '\n' + bm.body + '\n```';
      const before = inputValue.slice(0, bm.fenceLineStart);
      const after = inputValue.slice(bm.fenceLineStart);
      const needsLeadingNewline =
        bm.fenceLineStart > 0 && inputValue.charCodeAt(bm.fenceLineStart - 1) !== 0x0a;
      const insert = (needsLeadingNewline ? '\n' : '') + synthesized;
      const insertWithTrailing = after.length > 0 && after.charCodeAt(0) !== 0x0a
        ? insert + '\n'
        : insert + (tail.length > 0 ? '\n' + tail : '');
      const finalInline = before + insertWithTrailing + after;
      const restoreCaret = before.length + insertWithTrailing.length;
      inputValue = finalInline;
      blockMode = null;
      prevText = finalInline;
      prevCursor = restoreCaret;
      queueMicrotask(() => {
        if (inputEl) {
          inputEl.focus();
          inputEl.setSelectionRange(restoreCaret, restoreCaret);
        }
      });
      return;
    }
    blockMode = { ...blockMode, body: newBody };
  }

  function handleBlockKeydown(e) {
    if (!blockMode) return;
    // Esc → exit block mode. Trigger B + empty body → undo gesture (restore
    // pre-entry source). Trigger A or non-empty body → commit synthesized
    // block back to inline source.
    if (e.key === 'Escape') {
      e.preventDefault();
      if (blockMode.trigger === 'B' && blockMode.body === '') {
        exitBlockMode({ exitMode: 'esc-B-empty' });
      } else {
        exitBlockMode({ exitMode: 'esc-A' });
      }
      return;
    }

    // Arrow-key escape (Phil's v2 ask): right-arrow at end of body OR
    // down-arrow on the last line of the body should exit the block and
    // return focus to the inline textarea. Lets the user "step out" of the
    // block without Esc / closing fence / re-clicking.
    {
      const ta = e.target;
      const value = blockMode.body;
      const caret = ta.selectionStart;
      const isCollapsed = ta.selectionStart === ta.selectionEnd;
      if (isCollapsed && e.key === 'ArrowRight' && caret === value.length) {
        e.preventDefault();
        exitBlockMode({ exitMode: 'commit' });
        return;
      }
      if (isCollapsed && e.key === 'ArrowDown') {
        // True iff caret sits on the LAST line of the body. Equivalent to:
        // no '\n' in `value.slice(caret)`.
        if (value.indexOf('\n', caret) === -1) {
          e.preventDefault();
          exitBlockMode({ exitMode: 'commit' });
          return;
        }
      }
    }
    // Tab → insert literal tab; preventDefault so focus doesn't escape.
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.target;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const oldBody = blockMode.body;
      const newBody = oldBody.slice(0, start) + '\t' + oldBody.slice(end);
      blockMode = { ...blockMode, body: newBody };
      queueMicrotask(() => {
        if (blockEl) {
          blockEl.value = newBody;
          blockEl.setSelectionRange(start + 1, start + 1);
        }
      });
      return;
    }
    // Enter inside block → newline (default textarea behavior). Cmd/Ctrl+Enter
    // sends the message (commits block first).
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      // Commit block first, then send.
      exitBlockMode({ exitMode: 'commit' });
      // sendMessage runs in the microtask after commit, after inputValue has
      // been updated.
      queueMicrotask(() => {
        sendMessage();
      });
      return;
    }
    // Backspace at row 0 col 0:
    //   - Empty block → atomically remove block.
    //     - Trigger B: restore pre-entry source (gesture undo).
    //     - Trigger A: collapse — body was empty so we just leave NORMAL with
    //       the inline fences intact.
    //   - Non-empty block → fence-dissolve-merge (Trigger A only); body
    //     merges as plain text at fenceLineStart.
    if (e.key === 'Backspace') {
      const ta = e.target;
      if (ta.selectionStart === 0 && ta.selectionEnd === 0) {
        e.preventDefault();
        if (blockMode.body === '') {
          // Empty block — atomic remove.
          if (blockMode.trigger === 'B') {
            exitBlockMode({ exitMode: 'esc-B-empty' });
          } else {
            // Trigger A empty: just clear blockMode, leave inline source as-is.
            blockMode = null;
          }
        } else {
          // Non-empty block — fence-dissolve-merge.
          exitBlockMode({ exitMode: 'fence-dissolve' });
        }
        return;
      }
    }
  }

  function handleSelect() {
    // selectionchange-equivalent for the textarea: cursor moved without
    // a text edit. If we were holding a pending exact match and the
    // cursor moved out of the prefix range, commit immediately.
    if (!inputEl) return;
    let cursor = inputEl.selectionStart;
    const selEnd = inputEl.selectionEnd;

    // Phil §5.4 (inline chip): the caret cannot rest at chip interior
    // position 1 (immediately after the opening backtick). If the user
    // clicks/arrow-lefts there, snap left to just before the opening tick.
    // We only enforce this for collapsed selections — a range selection
    // that happens to start mid-chip is the user explicitly grabbing
    // content, leave it alone.
    if (cursor === selEnd) {
      const chip = inlineChipAtCaret(inputValue, cursor);
      if (chip && cursor === chip.start + 1) {
        // Caret is immediately after the opening backtick — illegal rest
        // position. Snap left to before the opening tick.
        const snap = chip.start;
        inputEl.setSelectionRange(snap, snap);
        cursor = snap;
      }
    }

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

    // §5.1.1 early-trigger gesture (Trigger B): triple-tick on its own line
    // + Shift+Enter OR Space → enter block mode, fence chars stripped from
    // source. Must fire BEFORE the Enter-sends handler below (Shift+Enter
    // would otherwise default to a literal newline) and BEFORE Space gets
    // inserted as a literal character.
    //
    // Precondition: block-mode not active (no nested triggers); not composing
    // an IME character; the caret line matches detectTriggerBLine.
    if (
      !isComposing
      && !blockMode
      && (
        (e.key === 'Enter' && e.shiftKey)
        || (e.key === ' ' && !e.metaKey && !e.ctrlKey && !e.altKey)
      )
      && inputEl
    ) {
      const det = detectTriggerBLine(inputValue, inputEl.selectionStart);
      if (det) {
        e.preventDefault();
        enterBlockModeTriggerB(det);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
    // Shift+Enter inserts a newline (default textarea behavior).

    // Phil §5.4 (inline chip): Backspace from chip-interior-position-2
    // (caret immediately after the FIRST interior char, e.g. `|x|y` with
    // caret at the | between x and y) deletes that first interior char
    // AND jumps the caret to before the opening tick. The chip is now
    // empty (`|y`) — parser sees ``y` -> single tick + text + tick which
    // becomes literal text. This dissolves the chip atomically and lands
    // the caret outside, matching Claude Desktop.
    if (e.key === 'Backspace' && !isComposing && inputEl) {
      const cursor = inputEl.selectionStart;
      const selEnd = inputEl.selectionEnd;
      if (cursor === selEnd) {
        const chip = inlineChipAtCaret(inputValue, cursor);
        // chip exists when cursor is strictly inside (chip.start, chip.end).
        // chip-interior-position-2 means cursor === chip.start + 2.
        if (chip && cursor === chip.start + 2) {
          e.preventDefault();
          // Delete the first interior char (at chip.start + 1).
          const deleteAt = chip.start + 1;
          const newText = inputValue.slice(0, deleteAt) + inputValue.slice(deleteAt + 1);
          inputValue = newText;
          // Re-anchor diff state; caret jumps to before opening tick.
          const newCursor = chip.start;
          prevText = newText;
          prevCursor = newCursor;
          // Apply caret on next tick (after Svelte propagates value).
          queueMicrotask(() => {
            if (inputEl) {
              inputEl.setSelectionRange(newCursor, newCursor);
              autoResize(inputEl);
              ensureCaretVisible(inputEl);
            }
          });
          // Re-run mention parser against the new text.
          const r = parseMentions(newText, mentionTokens, prevText, prevCursor, newCursor);
          mentionTokens = r.tokens;
          activeSuggestion = r.activeSuggestion;
          return;
        }
      }
    }
  }

  /**
   * Maximum visible textarea height in pixels before the textarea becomes
   * internally scrollable. Kept in lock-step with the `max-height` CSS rule
   * on the textarea (`.input-wrap textarea`). If you change one, change
   * both — drift produces a phantom region where the caret sits but the
   * overlay paints, which is exactly the bug Phil reported (cursor at
   * "line start" visually while text is elsewhere).
   */
  const TEXTAREA_MAX_HEIGHT = 180;

  /** Auto-resize textarea to fit content, capped at TEXTAREA_MAX_HEIGHT. */
  function autoResize(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT) + 'px';
  }

  /**
   * After autoResize the textarea may be in scroll-mode (scrollHeight >
   * clientHeight). The browser does NOT auto-scroll the caret into view in
   * that case for programmatic height changes — only for clientHeight that
   * was already smaller. Manually push scrollTop to keep the caret visible
   * if it's below the visible region. Then mirror to the overlay so the
   * styled layer follows.
   */
  function ensureCaretVisible(el) {
    if (!el) return;
    // Cheap heuristic: if the textarea is in overflow mode and the caret is
    // at or near the end, pin scroll to bottom. This covers the dominant
    // "type past the bottom" case Phil flagged. Mid-document edits with
    // long content remain in the user's control via native scroll.
    if (el.scrollHeight > el.clientHeight) {
      const caretAtEnd = el.selectionStart === el.value.length;
      if (caretAtEnd) {
        el.scrollTop = el.scrollHeight;
      }
    }
    // Always sync the overlay even if we didn't touch scrollTop —
    // autoResize itself can change scrollTop implicitly when height shrinks.
    handleScroll();
  }

  // ── Send ─────────────────────────────────────────────────────────────

  function sendMessage() {
    // If a block is open, commit it first so the synthesized fenced source
    // lands in inputValue before we read recipients & dispatch.
    if (blockMode) {
      exitBlockMode({ exitMode: 'commit' });
    }

    // Force-commit any pending exact-match before reading mentions so
    // what the user sees is what we send.
    commitPendingIfMatch();

    if (!inputValue.trim()) return;
    if (inputValue.length > MAX_MESSAGE_LENGTH) return;

    // Parse-order (plan §11 Phase C-1): /dm-detection BEFORE
    // tokensToMentions. The two paths are mutually exclusive — a /dm send
    // never carries `mentions`, an autocomplete send never carries
    // `recipients`.
    if (inputValue.trim().startsWith('/dm ')) {
      const parsed = parseDM(inputValue, store.participants, store.userProfile.key);
      if (parsed.error) {
        // Surface inline; do NOT reset composer so user can correct.
        composerError = parsed.error;
        return;
      }
      store.sendMessage(parsed.body, null, {
        recipients: parsed.recipients,
        mentions: null,
      });
    } else if (
      inputValue.trim().startsWith('/reply ')
      || inputValue.trim() === '/reply'
    ) {
      // Threaded-replies plan §6 — /reply <message_id> <body>.
      // Server is the authority on parent-exists / depth-2 / non-system;
      // parser screens the surface UUID shape so typos are caught locally.
      const parsed = parseReply(inputValue);
      if (parsed.error) {
        composerError = parsed.error;
        return;
      }
      store.sendMessage(parsed.body, parsed.replyTo, {
        recipients: null,
        mentions: null,
      });
    } else {
      // Default path: autocomplete-driven mentions (broadcast highlight).
      const mentions = tokensToMentions(mentionTokens);
      // Composer-side sender-key dedup (UX): drop self if it somehow snuck
      // into the token list. `filterCandidates` already excludes self, so
      // this is defense in depth against direct token-list manipulation.
      const filtered = mentions.filter((k) => k !== store.userProfile.key);
      store.sendMessage(inputValue, null, {
        mentions: filtered.length > 0 ? filtered : null,
        recipients: null,
      });
    }

    resetComposer();
  }

  /**
   * Reset composer state after a successful send. Extracted so /dm and
   * autocomplete paths share the cleanup; both leave the composer empty
   * with diff state re-anchored.
   */
  function resetComposer() {
    inputValue = '';
    mentionTokens = [];
    activeSuggestion = null;
    highlightIndex = 0;
    prevText = '';
    prevCursor = 0;
    composerError = null;
    if (pendingCommitTimer) {
      clearTimeout(pendingCommitTimer);
      pendingCommitTimer = null;
    }
    blockMode = null;
    if (inputEl) {
      inputEl.style.height = 'auto';
    }
  }

  /**
   * v0.3.3 stub for the over-limit "Convert to artifact" CTA (G-28).
   *
   * The full artifact-create flow lands in v0.4.x — for now we copy the
   * composer contents to clipboard so the user can paste them into a new
   * artifact manually, surface a transient in-composer notice, AND dispatch
   * a `requestToast` CustomEvent on the root element so an App-level
   * listener can show a global toast if it wants to.
   *
   * The textarea contents are intentionally NOT cleared — the user might
   * still want to split the message in-place rather than convert it whole.
   */
  async function convertToArtifact() {
    const text = inputValue;
    const toastText = 'Copied — paste into a new artifact (coming v0.4.x)';
    let copied = false;
    try {
      if (typeof navigator !== 'undefined'
          && navigator.clipboard
          && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch (err) {
      // Clipboard write can throw (permissions, insecure context, jsdom).
      // Fall through to the console-log fallback so the user at least sees
      // a notice and the App-side listener still gets the request event.
      console.warn('[MessageInput] convertToArtifact: clipboard.writeText failed', err);
    }
    if (!copied) {
      console.info('[MessageInput] convertToArtifact: clipboard unavailable, contents not copied');
    }
    convertNotice = toastText;
    setTimeout(() => {
      if (convertNotice === toastText) convertNotice = '';
    }, 3000);
    // Emit a CustomEvent for any App-level listener wanting to render a
    // global toast. Decoupled from the in-composer notice so the UI works
    // even if no listener is attached.
    if (rootEl && typeof CustomEvent === 'function') {
      rootEl.dispatchEvent(new CustomEvent('requestToast', {
        bubbles: true,
        composed: true,
        detail: { text: toastText, kind: 'info', copied },
      }));
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

<div class="input-area" bind:this={rootEl}>
  {#if overLimit}
    <!--
      G-28 over-limit error banner (Step 1.7). Surfaces directly above the
      composer in --ember-400 so it reads as a hard "you can't send this"
      signal rather than a soft warning. The "Convert to artifact" CTA is a
      v0.3.3 stub — it copies the textarea contents to clipboard so the user
      can paste them into a new artifact manually; the full artifact-create
      flow lands in v0.4.x. Send is independently disabled via `overLimit`
      on the send button (the prior behavior silently no-op'd, leaving the
      user with no diagnostic).
    -->
    <div class="over-limit-banner" data-testid="over-limit-banner" role="alert">
      <span class="over-limit-text">
        Message too long ({(charCount - MAX_MESSAGE_LENGTH).toLocaleString()} over limit) — split or convert to artifact
      </span>
      <button
        type="button"
        class="over-limit-cta"
        onclick={convertToArtifact}
        data-testid="convert-to-artifact"
      >Convert to artifact</button>
    </div>
  {/if}

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

  <div class="input-wrap" class:over-limit={overLimit}>
    <div class="textarea-wrap">
      <div class="input-overlay" aria-hidden="true">
        {#each overlaySegments as seg, i (i)}
          {#if seg.type === 'mention-confirmed'}
            <span class="mention-confirmed">{seg.text}</span>
          {:else if seg.type === 'mention-pending'}
            <span class="mention-pending">{seg.text}</span>
          {:else if seg.type === 'ghost'}
            <span class="ghost-suggestion">{seg.text}</span>
          {:else if seg.type === 'inline-code'}
            <span class="overlay-code-chip">{seg.text}</span>
          {:else if seg.type === 'inline-code-tick'}
            <span class="overlay-code-tick">{seg.text}</span>
          {:else if seg.type === 'block-code'}
            <span class="overlay-code-block">{seg.text}</span>
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

    {#if blockMode}
      <!--
        Dedicated block textarea per backtick-highlighting-plan §5.1 / §5.1.1.
        Mounted only while in block-mode. Body chars live here, NOT in the
        inline textarea. On commit / send / Esc the synthesized closed block
        is spliced back into inline source (see exitBlockMode).
      -->
      <div class="block-textarea-wrap" data-testid="block-textarea-wrap">
        <div class="block-textarea-header">
          <span class="block-textarea-label">code block</span>
          {#if blockMode.langTag}
            <span class="block-textarea-lang" data-testid="block-textarea-lang">{blockMode.langTag}</span>
          {/if}
          <span class="block-textarea-hint">Esc to exit · ``` to close</span>
        </div>
        <textarea
          bind:this={blockEl}
          rows="3"
          class="block-textarea"
          placeholder="Type your code..."
          value={blockMode.body}
          oninput={handleBlockInput}
          onkeydown={handleBlockKeydown}
          data-testid="block-textarea"
        ></textarea>
      </div>
    {/if}

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
      <button
        class="btn-send"
        title={overLimit ? 'Message too long — split or convert to artifact' : 'Send message'}
        onclick={sendMessage}
        disabled={overLimit || !inputValue.trim()}
        aria-disabled={overLimit || !inputValue.trim()}
        data-testid="send-button"
      >
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

  {#if convertNotice}
    <div class="attach-notice" data-testid="convert-notice">{convertNotice}</div>
  {/if}

  {#if composerError}
    <div class="composer-error" data-testid="composer-error" role="alert">
      {composerError}
    </div>
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

  /*
   * Over-limit character counter (G-28). Uses --ember-400 to match the
   * over-limit textarea border and the inline error banner above the
   * composer, so the three over-limit affordances read as a single
   * coordinated state rather than three independent reds.
   */
  .char-counter.over-limit {
    color: var(--ember-400);
    font-weight: 600;
  }

  .limit-warning {
    font-weight: 400;
  }

  /*
   * G-28 over-limit banner above the composer. Surfaces only when
   * inputValue.length > MAX_MESSAGE_LENGTH. Pairs with:
   *   - the textarea border (also --ember-400 via .input-wrap.over-limit)
   *   - the char-counter color (--ember-400 via .char-counter.over-limit)
   *   - the disabled send button
   * so the over-limit state is unmistakable rather than a silent no-op.
   */
  .over-limit-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 6px 10px;
    margin-bottom: 6px;
    border-radius: var(--radius-sm);
    background: rgba(245, 158, 11, 0.08);
    border: 1px solid var(--ember-400);
    color: var(--ember-400);
    font-size: 12px;
    line-height: 1.4;
  }

  .over-limit-text {
    flex: 1 1 auto;
  }

  .over-limit-cta {
    flex: 0 0 auto;
    padding: 3px 10px;
    border-radius: var(--radius-xs);
    background: var(--ember-400);
    border: 1px solid var(--ember-400);
    color: #0a0a0c;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
    transition: var(--transition-fast);
  }

  .over-limit-cta:hover {
    filter: brightness(1.1);
  }

  .over-limit-cta:focus-visible {
    outline: 2px solid var(--ember-400);
    outline-offset: 2px;
  }

  /*
   * Over-limit textarea border. Wins over the default 1px border on
   * .input-wrap and over the focus-within glow so the over-limit state is
   * visually persistent regardless of focus.
   */
  .input-wrap.over-limit {
    border-color: var(--ember-400);
    box-shadow: 0 0 0 1px var(--ember-400), 0 2px 8px rgba(0, 0, 0, 0.15);
  }

  .input-wrap.over-limit:focus-within {
    border-color: var(--ember-400);
    box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.35), 0 2px 8px rgba(0, 0, 0, 0.15);
  }

  /* Disabled send button: dim + remove the shimmer + cursor-not-allowed
     so the over-limit / empty-input gating is unambiguous. */
  .btn-send:disabled,
  .btn-send[aria-disabled='true'] {
    opacity: 0.45;
    cursor: not-allowed;
    transform: none;
    filter: grayscale(0.4);
    box-shadow: none;
  }

  .btn-send:disabled:hover,
  .btn-send[aria-disabled='true']:hover {
    filter: grayscale(0.4);
    transform: none;
    box-shadow: none;
  }

  .btn-send:disabled:hover::after,
  .btn-send[aria-disabled='true']:hover::after {
    animation: none;
  }

  .attach-notice {
    font-size: 11.5px;
    color: var(--text-muted);
    padding: 4px 4px 0;
  }

  /* Inline composer error: surfaced when /dm parsing rejects (unknown
     recipient, empty body, self-DM, etc.). Auto-clears on next keystroke
     via handleInput; no explicit dismiss control. Positioned above the
     send row so the user sees it without scroll. */
  .composer-error {
    margin-top: 6px;
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.4);
    color: rgb(252, 165, 165);
    font-size: 12px;
    line-height: 1.4;
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

  /*
   * Overlay and textarea must share the EXACT same text-flow properties
   * (font-family, font-size, line-height, letter-spacing, padding,
   * box-sizing, white-space, overflow-wrap, word-break, tab-size) so that
   * a glyph at source offset N renders at the same x/y in both layers.
   * Any drift produces the bug Phil flagged: caret position visually
   * lagging the rendered text. See plan §10.5 + §11.1.
   */
  .input-overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    word-break: normal;
    overflow: hidden;
    padding: 4px 0;
    font-size: 14px;
    font-family: inherit;
    line-height: 1.5;
    letter-spacing: normal;
    tab-size: 2;
    color: var(--text-primary);
    box-sizing: border-box;
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

  /* Inline code chip — rounded background highlight on the value between
     the backticks. The backticks themselves render as `overlay-code-tick`
     spans at low opacity so the overlay stays character-aligned with the
     textarea (caret math depends on identical character counts). The chip
     uses the SAME base font as the surrounding text — the "monospace
     feel" comes from the background + accent color, NOT a font swap; a
     font-family change here would shift glyph metrics and misalign the
     caret. The rendered MessageBubble (no caret) is free to use a real
     monospace stack. */
  .input-overlay .overlay-code-chip {
    background: var(--code-chip-bg, rgba(239, 68, 68, 0.14));
    color: var(--code-chip-fg, rgb(252, 165, 165));
    border-radius: 6px;
    /* Inset box-shadow gives the 1px edge without affecting layout
       (a real `border` would shift glyph metrics and misalign the caret
       against the textarea behind us). */
    box-shadow: inset 0 0 0 1px var(--code-chip-border, rgba(239, 68, 68, 0.55));
    padding: 0 2px;
    /* Negative margin keeps the chip's visual width matching its source
       chars (the padding would otherwise push the textarea/overlay out of
       sync). Browsers render this stably for inline backgrounds. */
    margin: 0 -2px;
  }

  .input-overlay .overlay-code-tick {
    color: var(--code-chip-fg, rgb(252, 165, 165));
    opacity: 0.45;
  }

  /* Block code — rendered as a single inline span over the entire fenced
     range (raw text including the opening/closing fences). The dedicated
     block textarea (when in BLOCK mode) handles fine-grained editing; the
     overlay here is purely decorative until the user closes the fence.

     Multi-line bubble cohesion: by default an inline span with a
     background paints each visual line as a separate fragment, which Phil
     flagged as ugly ("each line gets its own bubble"). `box-decoration-break:
     clone` (and webkit prefix for Safari) makes EACH fragment carry the
     full background + border-radius + border-left, which still reads as
     "one block" because they share the same bg color and accent edge — and
     critically they don't fight the textarea's character flow underneath.
     A real `display: block` would shift glyph metrics and break caret
     alignment with the textarea behind us, so we stick with inline. */
  .input-overlay .overlay-code-block {
    background: var(--code-block-bg, rgba(20, 20, 24, 0.85));
    color: var(--code-block-fg, var(--text-primary));
    border-left: 2px solid var(--code-block-accent, rgba(239, 68, 68, 0.55));
    border-radius: 4px;
    padding: 0 6px;
    display: inline;
    -webkit-box-decoration-break: clone;
    box-decoration-break: clone;
    /* white-space: pre-wrap is inherited from .input-overlay so newlines
       inside the block render as line breaks correctly. */
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
    /* Mirror the overlay's text-flow properties so wrap points line up.
       See plan §10.5 + §11.1 — drift here is the cursor-drift bug. */
    white-space: pre-wrap;
    overflow-wrap: break-word;
    word-break: normal;
    letter-spacing: normal;
    tab-size: 2;
    box-sizing: border-box;
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

  /* Dedicated block textarea (v2 §5.1 / §5.1.1). Mounted only while
     blockMode is active. Visually distinct from the inline textarea — uses
     the code-block theme tokens, monospace font, and a leading accent
     border to read as a block-of-code surface.

     Border color uses --code-block-accent (red, distinct from the ember
     accent on @mentions per Phil's call) so users don't confuse code with
     mentions at a glance. Default falls back to a red rgba so the chrome
     reads even without theme tokens. */
  .block-textarea-wrap {
    margin-top: 6px;
    border-radius: var(--radius-sm);
    background: var(--code-block-bg, rgba(20, 20, 24, 0.85));
    border: 1px solid var(--code-block-accent, rgba(239, 68, 68, 0.55));
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
    overflow: hidden;
  }

  .block-textarea-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    font-size: 11px;
    color: var(--code-block-lang-fg, var(--text-faint));
    background: rgba(0, 0, 0, 0.35);
    border-bottom: 1px solid var(--code-block-accent, rgba(239, 68, 68, 0.4));
  }

  .block-textarea-label {
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .block-textarea-lang {
    color: var(--code-block-fg, var(--text-primary));
    background: rgba(0, 0, 0, 0.25);
    padding: 1px 6px;
    border-radius: 3px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }

  .block-textarea-hint {
    margin-left: auto;
    color: var(--text-faint);
    font-size: 10.5px;
  }

  .block-textarea {
    width: 100%;
    background: transparent;
    border: none;
    outline: none !important;
    box-shadow: none !important;
    color: var(--code-block-fg, var(--text-primary));
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 13px;
    line-height: 1.5;
    padding: 8px 10px;
    resize: vertical;
    min-height: 60px;
    max-height: 240px;
    white-space: pre;
    overflow: auto;
    tab-size: 2;
    box-sizing: border-box;
  }

  .block-textarea:focus-visible {
    outline: none !important;
    box-shadow: none !important;
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
