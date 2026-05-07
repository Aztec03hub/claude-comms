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
      // Emit: opening backtick (low-alpha) + chip body + closing backtick.
      // Backticks are kept visible at low opacity so the overlay's character
      // count exactly matches the textarea's, preserving caret math.
      out.push({ type: 'inline-code-tick', text: '`' });
      out.push({ type: 'inline-code', text: tok.value });
      out.push({ type: 'inline-code-tick', text: '`' });
      i = tok.end;
      continue;
    }

    if (tok.type === 'block-code' || tok.type === 'unclosed-block') {
      // Block tokens render the entire `raw` slice — we paint the opening
      // fence (and lang tag) and any closing fence as low-alpha decorations
      // and the body content as the styled block surface. For overlay
      // simplicity in v1, render the whole raw chunk inside one block-code
      // segment; the dedicated block-textarea handles fine-grained editing.
      out.push({
        type: 'block-code',
        text: tok.raw,
        lang: tok.lang ?? null,
      });
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
