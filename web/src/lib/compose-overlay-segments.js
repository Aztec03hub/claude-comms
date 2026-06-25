/**
 * Compose overlay segments for the MessageInput composer.
 *
 * The overlay layer paints styled spans behind a transparent <textarea> so
 * the user sees rendered tokens (mentions, inline code, code blocks) while
 * typing. This module merges TWO independent token streams into a single
 * segment list the Svelte template iterates over:
 *
 *   1. Code tokens from rich-text-parser.parse(source) — inline-code and
 *      block-code/unclosed-block ranges that disable any inner formatting
 *      and render as chips/blocks.
 *
 *   2. Mention tokens from lib/mentions.js — confirmed @-mentions, plus the
 *      ghost-suggestion + pending-exact-match coloring near the cursor.
 *
 * Mentions are only rendered inside `text` regions (regions NOT covered by
 * code tokens). Inside a code chip or code block, the source is verbatim;
 * mentions there stay literal.
 *
 * Segment shape (the Svelte template's discriminated union):
 *   { type: 'text',              text }
 *   { type: 'mention-confirmed', text }
 *   { type: 'mention-pending',   text }
 *   { type: 'ghost',             text }
 *   { type: 'inline-code',       text }   // contains the literal `value`,
 *                                          // backticks rendered separately
 *   { type: 'inline-code-tick',  text }   // a single backtick at low alpha
 *                                          // that bookends the chip; keeps
 *                                          // textarea/overlay character-
 *                                          // alignment exact for caret math
 *   { type: 'block-code',        text, lang }
 *   { type: 'block-code-fence',  text }   // ``` opening / closing fence
 *                                          // (rendered as low-alpha so the
 *                                          // textarea source chars align)
 */

import { parse as parseRichText } from './rich-text-parser.js';
import { renderSegments as renderMentionSegments } from './mentions.js';

/**
 * Split a fenced-block token's `raw` into its opening fence (```lang + the
 * newline), body, and closing fence (the trailing newline + ```). Concatenating
 * open + body + close reproduces `raw` EXACTLY — this is the character-exact
 * contract the overlay alignment depends on. Handles closed blocks, unclosed
 * blocks (no close), empty-body blocks, and a bare opening fence (no newline).
 *
 * @param {{type:string, raw:string}} tok
 * @returns {{open:string, body:string, close:string}}
 */
export function splitFencedBlock(tok) {
  const raw = tok.raw ?? '';
  const nl = raw.indexOf('\n');
  // Bare opening fence with no newline (e.g. an unclosed ```lang at EOF).
  if (nl === -1) return { open: raw, body: '', close: '' };

  const open = raw.slice(0, nl + 1); // ```lang\n
  const afterOpen = raw.slice(nl + 1);
  // Unclosed block: everything after the opening fence is body, no close.
  if (tok.type === 'unclosed-block') return { open, body: afterOpen, close: '' };

  // Closed block: the closing fence is the final line of `raw`.
  const lastNl = raw.lastIndexOf('\n');
  if (lastNl === nl) {
    // Only one newline → empty body; close is everything after the open fence.
    return { open, body: '', close: afterOpen };
  }
  return { open, body: raw.slice(nl + 1, lastNl), close: raw.slice(lastNl) };
}

/**
 * @param {string} source - the textarea's plain-text value
 * @param {Array<{start:number,end:number,name:string,key:string}>} mentionTokens
 * @param {{atIndex:number,query:string}|null} activeSuggestion
 * @param {object|null} highlightedCandidate
 * @param {object|null} pendingExactMatch
 * @returns {Array<{type:string,text:string,lang?:string|null}>}
 */
export function composeOverlaySegments(
  source,
  mentionTokens,
  activeSuggestion,
  highlightedCandidate,
  pendingExactMatch,
) {
  if (!source) return [];

  const codeTokens = parseRichText(source);
  if (codeTokens.length === 0) {
    // Pure mention-only path; identical to existing behavior.
    return renderMentionSegments(
      source,
      mentionTokens,
      activeSuggestion,
      highlightedCandidate,
      pendingExactMatch,
    );
  }

  const out = [];
  let i = 0;

  for (const tok of codeTokens) {
    if (tok.type === 'text') {
      // Defer to mention renderer for this run, then translate its segments
      // through with offset accounting trivial — the mention parser sees
      // absolute offsets, so we just let it render against the same source
      // and slice. To keep the existing mentions.renderSegments contract
      // (which takes the FULL text + tokens), we accumulate text spans
      // here directly without delegating, but we still want mention
      // coloring inside code-free runs. Approach: invoke renderMentionSegments
      // on a sub-string and map results back.
      //
      // Cheaper and equivalent: call renderMentionSegments(source, ...) ONCE
      // outside the loop and walk it in lockstep with the codeTokens. We do
      // that below — see post-loop handling. The current loop branch only
      // emits raw text spans for text-typed code tokens; we replace them
      // afterwards.
      out.push({ type: '__pending-text-region', start: i, end: i + tok.value.length });
      i += tok.value.length;
      continue;
    }

    if (tok.type === 'inline-code') {
      // Emit: opening backtick + chip body + closing backtick. The backtick
      // segments keep the characters present so the overlay's character count
      // exactly matches the textarea's (caret math), but the CSS renders them
      // `color: transparent` so the literal backticks DISAPPEAR once the span
      // is complete — only the chip pill shows (Phil).
      out.push({ type: 'inline-code-tick', text: '`' });
      out.push({ type: 'inline-code', text: tok.value });
      out.push({ type: 'inline-code-tick', text: '`' });
      i = tok.end;
      continue;
    }

    if (tok.type === 'block-code' || tok.type === 'unclosed-block') {
      // Split the fenced range into opening-fence / body / closing-fence so the
      // literal ``` fences can be hidden (rendered transparent) while the body
      // shows — only the code bubble is visible, no backticks (Phil). The fence
      // CHARACTERS are still emitted (as block-code-fence segments) so the
      // overlay stays character- and line-aligned with the textarea; dropping
      // them would shift the body up relative to the caret.
      const { open, body, close } = splitFencedBlock(tok);
      if (open) out.push({ type: 'block-code-fence', text: open });
      if (body) out.push({ type: 'block-code', text: body, lang: tok.lang ?? null });
      if (close) out.push({ type: 'block-code-fence', text: close });
      i = tok.end;
      continue;
    }
  }

  // Now expand the __pending-text-region placeholders into full mention
  // segments. We call renderMentionSegments on the whole source once, then
  // walk its output, taking only the slices that fall inside a pending
  // text region. Mentions whose range overlaps a code token are dropped
  // from styling (inside-code is verbatim).
  const mentionSegs = renderMentionSegments(
    source,
    mentionTokens,
    activeSuggestion,
    highlightedCandidate,
    pendingExactMatch,
  );

  // Build absolute offsets for mention segments.
  //
  // CRITICAL: `ghost` segments are PHANTOM — they exist only in the rendered
  // overlay, NOT in the source string (the user hasn't typed those chars
  // yet; we paint the ghost as a hint). Treat them as zero-width anchors at
  // the cumulative source position and DO NOT advance the running cursor.
  // Otherwise the ghost's positional bounds would extend past the source
  // length and miss every code-aware text region, dropping the suggestion
  // (the bug Phil flagged: ghost-suggestion vanished when code tokens
  // existed in the input).
  const mentionSpans = [];
  let mPos = 0;
  for (const m of mentionSegs) {
    if (m.type === 'ghost') {
      // Zero-width anchor at current source position; ghost text is the
      // visual hint that doesn't consume source bytes.
      mentionSpans.push({ ...m, start: mPos, end: mPos, anchor: mPos, ghost: true });
      // mPos stays put — ghost doesn't advance source position.
      continue;
    }
    const start = mPos;
    const end = start + m.text.length;
    mentionSpans.push({ ...m, start, end });
    mPos = end;
  }

  // Replace each placeholder with the mention spans that fall inside it,
  // clipped to the placeholder bounds. Mention spans that fall outside
  // any text region are silently dropped (the chars they covered are
  // already inside a code token, rendered verbatim there).
  //
  // For ghost segments specifically: they're emitted whole (no slicing)
  // when their anchor lies within or at the boundary of a text region.
  // Anchors at exactly seg.end (cursor at end of text region right before
  // a code token) still emit — the user typed up to the boundary and the
  // ghost should be visible there.
  const finalSegs = [];
  for (const seg of out) {
    if (seg.type !== '__pending-text-region') {
      finalSegs.push(seg);
      continue;
    }
    for (const ms of mentionSpans) {
      if (ms.ghost) {
        if (ms.anchor >= seg.start && ms.anchor <= seg.end) {
          finalSegs.push({ type: 'ghost', text: ms.text });
        }
        continue;
      }
      if (ms.end <= seg.start || ms.start >= seg.end) continue;
      const sliceStart = Math.max(ms.start, seg.start) - ms.start;
      const sliceEnd = Math.min(ms.end, seg.end) - ms.start;
      const text = ms.text.slice(sliceStart, sliceEnd);
      if (text.length > 0) {
        finalSegs.push({ type: ms.type, text });
      }
    }
  }

  return finalSegs;
}
