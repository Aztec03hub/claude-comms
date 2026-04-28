// Pure helpers for the @mention autocomplete in MessageInput.
//
// This module contains no Svelte runes — it's plain JS so it can be unit
// tested in isolation and reused outside Svelte components if needed.
//
// Glossary
// ────────
//   text        : string in the textarea
//   mentionTokens: Array<{ start, end, name, key }>
//                  - start: index of the '@' character
//                  - end:   exclusive index after the name
//                  - name:  display name committed
//                  - key:   participant key (8 hex chars)
//
//   activeSuggestion: { atIndex: int, query: string } | null
//                  - atIndex: index of '@' triggering the live suggestion
//                  - query:   text after '@' up to the cursor
//
// The two state objects are managed together: every confirmed token MUST be
// covered by an exact `'@' + name` substring in `text`, and every active
// suggestion MUST sit at the cursor's location with the cursor at the end
// of an `@\w+` prefix that is NOT covered by a confirmed token.

/**
 * Characters allowed inside a mention name. Hyphens and dots are common in
 * participant names (e.g. `claude-test`, `phil.exe`). Everything else
 * terminates the active suggestion query.
 *
 * Kept synchronized with the parsing regex below.
 */
const MENTION_NAME_CHARS = /[\w.-]/;

/**
 * Regex matching an `@`-prefix at the END of a string. Captures the partial
 * name. Used during edit reconciliation to detect a live suggestion at the
 * cursor.
 */
const TRAILING_AT_PREFIX = /@([\w.-]*)$/;

/**
 * Compute the edit range introduced by a text change. Given the old and
 * new text + the new cursor, returns:
 *
 *   { start, oldEnd, newEnd }
 *
 *   - `start`  : first character that differs
 *   - `oldEnd` : end index in the OLD text of the changed region
 *   - `newEnd` : end index in the NEW text of the changed region
 *
 * Algorithm: longest common prefix and longest common suffix; the change
 * sits between them. The new cursor is consulted as a tie-breaker when
 * suffix-prefix overlap creates ambiguity (e.g. `aa → aaa` could be "a
 * inserted at index 0" or "a inserted at index 2"; the cursor tells us).
 *
 * @param {string} oldText
 * @param {number} oldCursor   - cursor (selectionStart) BEFORE the edit (currently unused)
 * @param {string} newText
 * @param {number} newCursor   - cursor AFTER the edit
 * @returns {{start: number, oldEnd: number, newEnd: number}}
 */
export function computeEditRange(oldText, oldCursor, newText, newCursor) {
  // Empty edit: text unchanged, no shift needed.
  if (oldText === newText) {
    return { start: newCursor, oldEnd: newCursor, newEnd: newCursor };
  }

  // Find common prefix length, capped at newCursor so we don't claim a
  // prefix that extends INTO the inserted region (which would split the
  // new text incorrectly when characters in the insertion match the
  // following characters in the old text).
  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length, newCursor);
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) {
    prefix++;
  }

  // Find common suffix length.
  let suffix = 0;
  const maxSuffix = Math.min(oldText.length - prefix, newText.length - prefix);
  while (
    suffix < maxSuffix
    && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix++;
  }

  const start = prefix;
  const oldEnd = oldText.length - suffix;
  const newEnd = newText.length - suffix;
  // Silence unused-parameter lint warning: oldCursor is part of the API
  // surface for future cursor-aware refinements.
  void oldCursor;
  return { start, oldEnd, newEnd };
}

/**
 * Parse the latest text + cursor against the prior token list. Returns an
 * updated token list (entries shifted, invalidated, or kept) plus the
 * active suggestion at the cursor (if any).
 *
 * Three passes per the plan:
 *   1. Offset shift  : compute edit range; tokens entirely AFTER the edit
 *                      shift by (newEnd - oldEnd); tokens overlapping the
 *                      edit are dropped.
 *   2. Sanity check  : every surviving token must still cover its expected
 *                      `'@' + name` substring; otherwise drop it.
 *   3. Active prefix : if cursor is at the end of an `@\w+` prefix that is
 *                      NOT covered by a confirmed token, return that as
 *                      `activeSuggestion`. If the prefix STRICTLY EXTENDS
 *                      a confirmed token (user typed an extra letter at
 *                      the token's end), invalidate that token and use the
 *                      longer prefix as the new query.
 *
 * @param {string} text        - new textarea value
 * @param {Array<{start:number,end:number,name:string,key:string}>} prevTokens
 * @param {string} oldText     - textarea value before the edit
 * @param {number} oldCursor   - cursor before the edit
 * @param {number} newCursor   - cursor after the edit
 * @returns {{
 *   tokens: Array<{start:number,end:number,name:string,key:string}>,
 *   activeSuggestion: {atIndex:number,query:string} | null,
 * }}
 */
export function parseMentions(text, prevTokens, oldText, oldCursor, newCursor) {
  // ── Pass 1: offset shift ─────────────────────────────────────────────
  const { start, oldEnd, newEnd } = computeEditRange(oldText, oldCursor, text, newCursor);
  const delta = newEnd - oldEnd;

  let tokens = [];
  for (const tok of prevTokens) {
    if (tok.end <= start) {
      // Entirely before the edit — keep as-is.
      tokens.push({ ...tok });
    } else if (tok.start >= oldEnd) {
      // Entirely after the edit — shift.
      tokens.push({ ...tok, start: tok.start + delta, end: tok.end + delta });
    } else {
      // Overlapping the edit — invalidate.
      // (token dropped)
    }
  }

  // ── Pass 2: sanity check ─────────────────────────────────────────────
  tokens = tokens.filter((t) => {
    if (t.start < 0 || t.end > text.length) return false;
    const expected = '@' + t.name;
    return text.slice(t.start, t.end) === expected;
  });

  // ── Pass 3: active suggestion at cursor ──────────────────────────────
  const cursor = newCursor;
  const before = text.slice(0, cursor);
  const m = before.match(TRAILING_AT_PREFIX);
  let activeSuggestion = null;

  if (m) {
    const atIndex = before.length - m[0].length;
    const query = m[1];

    // Check whether the prefix is covered by a confirmed token.
    const coveringTok = tokens.find((t) => t.start === atIndex);
    if (coveringTok) {
      // The prefix starts at a confirmed token. If the cursor is exactly at
      // the token's end (no extension), no active suggestion. If the cursor
      // is past the token's end (extension typed: e.g. token covers
      // `@claude-test` and user typed `s` to make `@claude-tests`), then
      // (a) the sanity-check above kept the token because the prefix bytes
      //     `@claude-test` still match → but the cursor is at index 13 which
      //     is BEYOND the token's end of 12; that mismatch means the user
      //     extended past the committed name.
      // (b) we invalidate the token and re-derive the active suggestion
      //     from the longer prefix.
      if (cursor === coveringTok.end) {
        // Cursor is exactly at the end of a committed token. No active
        // suggestion — the user is "done" with this mention; let typing
        // continue to spawn a NEW @ later.
        activeSuggestion = null;
      } else if (cursor > coveringTok.end) {
        // Strictly extending: drop the token, treat the longer prefix as
        // a fresh suggestion query.
        tokens = tokens.filter((t) => t !== coveringTok);
        activeSuggestion = { atIndex, query };
      } else {
        // cursor < coveringTok.end → cursor is INSIDE the token. The
        // sanity-check would have kept the token (text bytes still match),
        // but conceptually the user is editing inside it. Fire active
        // suggestion with the partial query (substring up to cursor).
        tokens = tokens.filter((t) => t !== coveringTok);
        activeSuggestion = { atIndex, query };
      }
    } else {
      activeSuggestion = { atIndex, query };
    }
  }

  // Final sort by start so callers get a stable order.
  tokens.sort((a, b) => a.start - b.start);
  return { tokens, activeSuggestion };
}

/**
 * Filter and sort participants for the dropdown.
 *
 *   - Excludes the current user (no self-mention by default).
 *   - Case-insensitive PREFIX match on `query`. Empty query → all.
 *   - Sort: online first (any non-empty `connections`), then alpha by name.
 *   - Cap at 7 candidates (plan §2).
 *
 * @param {Record<string, object>|object[]} participants
 *        Either a `key → participant` map (the store shape) or an array.
 * @param {string} query
 * @param {string} currentUserKey
 * @returns {Array<{name:string,key:string,online:boolean}>}
 */
export function filterCandidates(participants, query, currentUserKey) {
  const list = Array.isArray(participants)
    ? participants
    : Object.values(participants ?? {});
  const q = (query ?? '').toLowerCase();

  const filtered = list
    .filter((p) => p && p.key && p.key !== currentUserKey)
    .filter((p) => {
      const name = (p.name ?? '').toLowerCase();
      return q === '' || name.startsWith(q);
    })
    .map((p) => ({
      name: p.name,
      key: p.key,
      online: !!(p.connections && Object.keys(p.connections).length > 0),
    }));

  filtered.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return filtered.slice(0, 7);
}

/**
 * Find a candidate whose name is a case-insensitive EXACT match for the query.
 * Returns the candidate or null. Used to drive the implicit-commit logic.
 *
 * @param {string} query
 * @param {Array<{name:string,key:string,online:boolean}>} candidates
 * @returns {{name:string,key:string,online:boolean}|null}
 */
export function findExactMatch(query, candidates) {
  if (!query) return null;
  const q = query.toLowerCase();
  for (const c of candidates) {
    if ((c.name ?? '').toLowerCase() === q) return c;
  }
  return null;
}

/**
 * Replace the range `[atIndex, queryEnd)` in `text` with `'@' + candidate.name`,
 * inserting a new mention token at that range and returning the updated state.
 *
 * @param {string} text
 * @param {Array<{start:number,end:number,name:string,key:string}>} tokens
 * @param {number} atIndex   - index of the '@' starting the suggestion
 * @param {number} queryEnd  - exclusive end of the partial query in `text`
 *                              (typically the cursor position when commit fires)
 * @param {{name:string,key:string}} candidate
 * @returns {{
 *   text: string,
 *   tokens: Array<{start:number,end:number,name:string,key:string}>,
 *   newCursor: number,
 * }}
 */
export function commitMention(text, tokens, atIndex, queryEnd, candidate) {
  const replacement = '@' + candidate.name;
  const before = text.slice(0, atIndex);
  const after = text.slice(queryEnd);
  const newTextValue = before + replacement + after;
  const newEnd = atIndex + replacement.length;

  // Compute the delta this commit imposes on the rest of the text so any
  // tokens beyond `queryEnd` shift correctly.
  const delta = replacement.length - (queryEnd - atIndex);
  const updatedTokens = tokens
    .filter((t) => t.end <= atIndex || t.start >= queryEnd)
    .map((t) =>
      t.start >= queryEnd ? { ...t, start: t.start + delta, end: t.end + delta } : { ...t },
    );
  updatedTokens.push({
    start: atIndex,
    end: newEnd,
    name: candidate.name,
    key: candidate.key,
  });
  updatedTokens.sort((a, b) => a.start - b.start);

  return {
    text: newTextValue,
    tokens: updatedTokens,
    newCursor: newEnd,
  };
}

/**
 * Walk the text, confirmed tokens, and active suggestion to produce a flat
 * list of overlay segments suitable for rendering colored spans on top of
 * a transparent textarea. Segment shapes:
 *
 *   { type: 'text',             text: string }
 *   { type: 'mention-confirmed', text: string }
 *   { type: 'mention-pending',   text: string }   // exact-match-but-not-yet-committed
 *   { type: 'ghost',             text: string }   // ghost-suggestion remainder
 *
 * Render order matches `text` exactly, with the ghost segment inserted at
 * the cursor when an active suggestion has a highlighted candidate that
 * extends the partial query.
 *
 * @param {string} text
 * @param {Array<{start:number,end:number,name:string,key:string}>} tokens
 * @param {{atIndex:number,query:string}|null} activeSuggestion
 * @param {{name:string,key:string,online:boolean}|null} highlightedCandidate
 * @param {{name:string,key:string,online:boolean}|null} pendingExactMatch
 *        Candidate whose name === query (case-insensitive). Painted ember
 *        ahead of the formal commit, per plan §"Visual coloring leads".
 * @returns {Array<{type:string,text:string}>}
 */
export function renderSegments(text, tokens, activeSuggestion, highlightedCandidate, pendingExactMatch) {
  const sorted = [...tokens].sort((a, b) => a.start - b.start);
  /** @type {Array<{type:string,text:string}>} */
  const segments = [];
  let i = 0;

  for (const tok of sorted) {
    if (tok.start > i) {
      segments.push({ type: 'text', text: text.slice(i, tok.start) });
    }
    segments.push({ type: 'mention-confirmed', text: text.slice(tok.start, tok.end) });
    i = tok.end;
  }

  if (i < text.length) {
    let tail = text.slice(i);

    // If there's an active suggestion ending at the cursor with an exact
    // match, paint that range as 'mention-pending' so the user sees the
    // ember coloring slightly before the formal commit. The active
    // suggestion's range is `[atIndex, atIndex + 1 + query.length)`.
    if (
      activeSuggestion
      && pendingExactMatch
      && activeSuggestion.atIndex >= i
    ) {
      const atIdxLocal = activeSuggestion.atIndex - i;
      const pendEnd = atIdxLocal + 1 + activeSuggestion.query.length;
      if (atIdxLocal >= 0 && pendEnd <= tail.length) {
        const before = tail.slice(0, atIdxLocal);
        const pending = tail.slice(atIdxLocal, pendEnd);
        const after = tail.slice(pendEnd);
        if (before) segments.push({ type: 'text', text: before });
        segments.push({ type: 'mention-pending', text: pending });

        // Append a ghost remainder if the highlighted candidate strictly
        // extends the query (e.g. query='cl', candidate='claude-test' →
        // ghost = 'aude-test'). Only when there is NO exact match (would
        // be redundant).
        if (
          highlightedCandidate
          && !exactNameMatch(activeSuggestion.query, highlightedCandidate.name)
          && (highlightedCandidate.name ?? '')
            .toLowerCase()
            .startsWith((activeSuggestion.query ?? '').toLowerCase())
        ) {
          const ghost = highlightedCandidate.name.slice(activeSuggestion.query.length);
          if (ghost) segments.push({ type: 'ghost', text: ghost });
        }

        if (after) segments.push({ type: 'text', text: after });
        return segments;
      }
    }

    // No pending exact-match — render the tail as plain text and drop a
    // ghost suggestion at the cursor if the highlighted candidate extends
    // the query.
    if (
      activeSuggestion
      && highlightedCandidate
      && activeSuggestion.atIndex >= i
      && (highlightedCandidate.name ?? '')
        .toLowerCase()
        .startsWith((activeSuggestion.query ?? '').toLowerCase())
      && !exactNameMatch(activeSuggestion.query, highlightedCandidate.name)
    ) {
      const atIdxLocal = activeSuggestion.atIndex - i;
      const cursorLocal = atIdxLocal + 1 + activeSuggestion.query.length;
      if (cursorLocal <= tail.length) {
        const before = tail.slice(0, cursorLocal);
        const after = tail.slice(cursorLocal);
        const ghost = highlightedCandidate.name.slice(activeSuggestion.query.length);
        if (before) segments.push({ type: 'text', text: before });
        if (ghost) segments.push({ type: 'ghost', text: ghost });
        if (after) segments.push({ type: 'text', text: after });
        return segments;
      }
    }

    segments.push({ type: 'text', text: tail });
  }

  return segments;
}

function exactNameMatch(query, name) {
  return (query ?? '').toLowerCase() === (name ?? '').toLowerCase();
}

/**
 * Word-terminator characters that trigger an implicit commit when an exact
 * match is present. Per plan §"Implicit triggers".
 */
export const WORD_TERMINATORS = new Set([' ', ',', '.', ';', '(', ')', '!', '?', '/', '\n', '\t']);

/**
 * @param {string} ch
 * @returns {boolean}
 */
export function isWordTerminator(ch) {
  return WORD_TERMINATORS.has(ch);
}

/**
 * Convenience: convert a list of tokens into the recipients array expected
 * by the comms_send call (just the keys). Maintains insertion order.
 *
 * @param {Array<{key:string}>} tokens
 * @returns {string[]}
 */
export function tokensToRecipients(tokens) {
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const t of tokens) {
    if (!t.key || seen.has(t.key)) continue;
    seen.add(t.key);
    out.push(t.key);
  }
  return out;
}

/**
 * Re-export so test suites can probe the same regex used internally.
 */
export const _internal = {
  TRAILING_AT_PREFIX,
  MENTION_NAME_CHARS,
};
