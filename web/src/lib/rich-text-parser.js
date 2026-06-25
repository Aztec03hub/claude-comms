/**
 * Rich-text parser for backtick highlighting.
 *
 * Pure function: source string → token stream. Used by both the message
 * composer (live overlay) and the rendered message bubble.
 *
 * Token shape:
 *   { type: 'text',           value }
 *   { type: 'inline-code',    value, raw, start, end }
 *   { type: 'block-code',     value, lang, raw, start, end }
 *   { type: 'unclosed-block', value, lang, raw, start, end }
 *
 * `value` is the inner content (without the backticks).
 * `raw` is the exact source slice INCLUDING the backticks (and lang tag).
 * `start`/`end` are source-string offsets pointing at `raw` boundaries.
 *
 * Rules (v1, per backtick-highlighting-plan v2):
 *   - Single-tick pair on a single line, non-empty between → inline-code.
 *   - Empty pair `` `` `` (back-to-back, same line, no content) → text.
 *   - Unclosed single tick → text (the lone backtick stays literal).
 *   - Triple backticks at start of input or start of a line → block-code
 *     up to a matching ``` on its own line, OR unclosed-block to EOF.
 *   - Triple backticks mid-line → text (literal).
 *   - Inside a block: backticks are literal until the closing fence.
 *   - No nested formatting. No doubled-backtick markdown escape (v1).
 *
 * Performance budget: parse(10kChars) < 5ms on commodity hardware.
 */

/**
 * Parse a source string into a token stream.
 *
 * `opts.strictInline` (default false) switches inline-code scanning from the
 * composer's "no-flicker" rule (the FIRST backtick closes the span — see the
 * trailing-tick stability tests) to the CommonMark-faithful rule used by the
 * READ side: a code span opened by a run of N backticks closes only at the
 * next run of EXACTLY N backticks on the same line, and a run of a different
 * length inside the span is literal content. This is what lets an inline span
 * delimited by one backtick legally CONTAIN a `` ``` `` run, e.g.
 * `` ` ```markdown ` `` → one chip reading `` ```markdown ``. Under
 * strictInline a single leading + trailing space is also stripped from the
 * span content (CommonMark code-span normalization). The composer keeps the
 * default behavior so `parse()` (and `inlineChipAtCaret`/`modeAtCaret`) stay
 * byte-for-byte unchanged for live-typing caret math.
 *
 * @param {string} source
 * @param {{strictInline?: boolean}} [opts]
 * @returns {Array<{type: string, value: string, raw?: string, lang?: string|null, start?: number, end?: number}>}
 */
export function parse(source, opts = {}) {
  if (typeof source !== 'string' || source.length === 0) return [];
  const strictInline = opts.strictInline === true;

  const tokens = [];
  let i = 0;
  let textStart = 0;

  // Helper: flush any accumulated plain text up to (but not including) `end`.
  function flushText(end) {
    if (end > textStart) {
      tokens.push({ type: 'text', value: source.slice(textStart, end) });
    }
  }

  while (i < source.length) {
    const ch = source.charCodeAt(i);
    if (ch !== 0x60 /* backtick */) {
      i++;
      continue;
    }

    // Count consecutive backticks at this position.
    let runStart = i;
    let runLen = 0;
    while (i < source.length && source.charCodeAt(i) === 0x60) {
      runLen++;
      i++;
    }

    // Check whether this run starts a fenced block: needs >=3 ticks, AND
    // must be at start of input or immediately after a newline.
    const atLineStart =
      runStart === 0 || source.charCodeAt(runStart - 1) === 0x0a /* \n */;

    if (runLen >= 3 && atLineStart) {
      // Block-fence opener. The opening line is `` `(`)*lang? `` followed by
      // an optional newline. Exactly 3 ticks consume the fence; any extra
      // ticks at the same position are literal characters at the start of
      // the lang tag (which we'll just include in the lang capture or as
      // text within the block — see below for lang parsing).
      //
      // Per spec: "exactly 3 ticks, then optional lang tag, then end-of-line".
      // We treat runLen > 3 as block-fence-with-leading-extras and parse
      // them as part of the lang field if no whitespace; but the simplest
      // and most robust thing is: only the first 3 are the fence, the rest
      // are literal lang characters. Most users will type exactly 3.

      const fenceTickEnd = runStart + 3;
      const extraTicks = runLen - 3; // may be 0

      // Parse lang tag: from `fenceTickEnd + extraTicks` to end of line.
      // (Extra ticks become part of the lang string verbatim — odd but
      // preserves source faithfully. In practice users type exactly 3.)
      const langStart = runStart + 3;
      let langEnd = i; // `i` is now positioned just past the run.
      // Continue until newline or EOF.
      while (langEnd < source.length && source.charCodeAt(langEnd) !== 0x0a) {
        langEnd++;
      }
      const langRaw = source.slice(langStart, langEnd);
      const lang = langRaw.trim() === '' ? null : langRaw.trim();

      // Body starts after the newline (if any).
      const bodyStart = langEnd < source.length ? langEnd + 1 : langEnd;

      // Search for closing fence: ``` on its own line (start of line, then
      // exactly 3 backticks, then optional whitespace/lang-strip and end-
      // of-line OR end-of-input).
      let closeStart = -1;
      let closeEnd = -1;
      let scan = bodyStart;
      while (scan < source.length) {
        // Find next newline.
        const nl = source.indexOf('\n', scan);
        const lineStart = scan;
        const lineEnd = nl === -1 ? source.length : nl;
        // Check this line for closing fence.
        if (
          lineEnd - lineStart >= 3 &&
          source.charCodeAt(lineStart) === 0x60 &&
          source.charCodeAt(lineStart + 1) === 0x60 &&
          source.charCodeAt(lineStart + 2) === 0x60
        ) {
          // The line starts with ```. After the 3 ticks, allow optional
          // whitespace only — anything else means this isn't a clean close.
          // (We allow trailing chars and still treat as close — markdown
          // permissive.) Simpler: as long as the line begins with ```, treat
          // as closing fence.
          closeStart = lineStart;
          closeEnd = lineEnd;
          break;
        }
        if (nl === -1) break;
        scan = nl + 1;
      }

      // Flush plain text accumulated before the opener.
      flushText(runStart);

      if (closeStart !== -1) {
        // Closed block.
        const bodyEnd = closeStart > 0 && source.charCodeAt(closeStart - 1) === 0x0a
          ? closeStart - 1 // strip the \n that's part of the close-line separation
          : closeStart;
        const value = source.slice(bodyStart, bodyEnd);
        const raw = source.slice(runStart, closeEnd);
        tokens.push({
          type: 'block-code',
          value,
          lang,
          raw,
          start: runStart,
          end: closeEnd,
        });
        i = closeEnd;
        textStart = closeEnd;
      } else {
        // Unclosed block — runs to EOF.
        const value = source.slice(bodyStart);
        const raw = source.slice(runStart);
        tokens.push({
          type: 'unclosed-block',
          value,
          lang,
          raw,
          start: runStart,
          end: source.length,
        });
        i = source.length;
        textStart = source.length;
      }
      continue;
    }

    // Read-side (strictInline): CommonMark-faithful inline code span. The
    // opener is a run of `runLen` backticks; it closes only at the next run
    // of EXACTLY `runLen` backticks on the same line. A run of a different
    // length encountered while scanning is literal content INSIDE the span
    // (this is what fixes the garbled render of `` ` ```markdown ` `` — the
    // 1-tick span legally contains the 3-tick run). Supports 1/2/3-backtick
    // delimiters uniformly.
    if (strictInline) {
      const delim = runLen;
      let scan = i; // `i` is positioned just past the opener run.
      let close = -1; // start index of the matching closing run.
      while (scan < source.length) {
        const c = source.charCodeAt(scan);
        if (c === 0x0a /* \n */) break; // same-line rule → unclosed
        if (c === 0x60 /* backtick */) {
          const runHere = scan;
          let runHereLen = 0;
          while (scan < source.length && source.charCodeAt(scan) === 0x60) {
            runHereLen++;
            scan++;
          }
          if (runHereLen === delim) {
            close = runHere;
            break;
          }
          // Different-length run → literal content; keep scanning. `scan` has
          // already advanced past this run.
          continue;
        }
        scan++;
      }

      if (close !== -1 && close > i) {
        // Non-empty span. Flush preceding text and emit the chip.
        flushText(runStart);
        let value = source.slice(i, close);
        // CommonMark code-span normalization: if the content both begins and
        // ends with a space and is not all spaces, strip one space from each
        // end (so `` ` ```markdown ` `` chips read `` ```markdown ``).
        if (
          value.length >= 2 &&
          value.charCodeAt(0) === 0x20 /* space */ &&
          value.charCodeAt(value.length - 1) === 0x20 &&
          value.trim() !== ''
        ) {
          value = value.slice(1, -1);
        }
        const raw = source.slice(runStart, close + delim);
        tokens.push({
          type: 'inline-code',
          value,
          raw,
          start: runStart,
          end: close + delim,
        });
        i = close + delim;
        textStart = close + delim;
      }
      // Unclosed or empty span → the opener run stays literal (picked up by
      // the next flush). `i` is already past the opener run.
      continue;
    }

    // Not a block. Could be inline-code opener (single tick), empty pair
    // (two adjacent ticks, no content), or just literal ticks (>=3 mid-line,
    // which we treat as text).
    if (runLen === 1) {
      // Look for closing single backtick on the SAME line. Per the
      // "no flicker" rule (phoenix + sage agreed): if we hit a run of
      // backticks while scanning, the FIRST tick in the run closes us.
      // Any extra ticks in the run remain as literal text after the chip.
      // Without this rule, typing `` `--flag` `` then a stray tick would
      // dissolve the whole chip — bad UX.
      let scan = i;
      let close = -1;
      while (scan < source.length) {
        const c = source.charCodeAt(scan);
        if (c === 0x0a) break; // newline → unclosed
        if (c === 0x60) {
          close = scan;
          break;
        }
        scan++;
      }

      if (close !== -1 && close > i) {
        // Non-empty inline code: ` (chars) ` where chars.length >= 1.
        flushText(runStart);
        const value = source.slice(i, close);
        const raw = source.slice(runStart, close + 1);
        tokens.push({
          type: 'inline-code',
          value,
          raw,
          start: runStart,
          end: close + 1,
        });
        i = close + 1;
        textStart = close + 1;
        continue;
      }
      // Unclosed (no closing tick on the same line) → fall through, the
      // single backtick stays as literal text in the next text flush.
      // Reset i to just past the lone backtick (it's already at runStart+1
      // = i was incremented during the run-counting loop).
      // Continue scanning from current i.
      continue;
    }

    if (runLen === 2) {
      // Empty pair `` `` `` — literal two backticks. Already incremented `i`
      // past the run; let the chars become text.
      continue;
    }

    // runLen >= 3 mid-line (atLineStart was false because we'd have taken
    // the block branch above). Literal backticks. `i` already past the run.
    continue;
  }

  // Flush trailing text.
  flushText(source.length);

  return tokens;
}

/**
 * Determine whether the composer is currently in block-entry mode based on
 * source string + caret position. This is a derived state — we don't store
 * mode separately. Mode is BLOCK if the caret falls inside an open or
 * unclosed block-code token.
 *
 * @param {string} source
 * @param {number} caret  source-string offset of the caret
 * @returns {{mode: 'NORMAL'|'BLOCK', token: object|null, fenceLineStart: number|null}}
 */
export function modeAtCaret(source, caret) {
  const tokens = parse(source);
  for (const t of tokens) {
    if (t.type === 'block-code' || t.type === 'unclosed-block') {
      // Caret is "inside the block body" if it's after the opening fence's
      // newline but at or before the closing fence start (exclusive of the
      // closing fence's three backticks themselves — caret can rest at or
      // before them).
      // For simplicity here: any caret offset within [t.start, t.end] is
      // BLOCK mode. The composer code distinguishes "row 0 col 0 of body"
      // for the special backspace rule.
      if (caret >= t.start && caret <= t.end) {
        return { mode: 'BLOCK', token: t, fenceLineStart: t.start };
      }
    }
  }
  return { mode: 'NORMAL', token: null, fenceLineStart: null };
}

/**
 * Find the inline-code token that strictly contains the given caret offset,
 * if any. Used by the composer to enforce Phil's "caret cannot rest mid-chip"
 * rule (caret at chip interior position 1 is illegal — we snap left).
 *
 * @param {string} source
 * @param {number} caret
 * @returns {object|null}
 */
export function inlineChipAtCaret(source, caret) {
  const tokens = parse(source);
  for (const t of tokens) {
    if (t.type === 'inline-code' && caret > t.start && caret < t.end) {
      return t;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Emphasis pass (read-side only — bold + italic)
// ---------------------------------------------------------------------------
//
// `parseRich(source)` returns the same token stream as `parse(source)` PLUS
// emphasis tokens emitted from `text`-typed tokens.
//
//   { type: 'bold',   value, raw, start, end }
//   { type: 'italic', value, raw, start, end }
//
// Precedence: code > bold > italic. Emphasis is never applied inside an
// inline-code or block-code token (we run the pass over text tokens only,
// so this is structural — no escaping needed).
//
// Markdown subset (v1):
//   - `**bold**`, `*italic*`, and `~~strike~~`. No `_italic_` / `__bold__`
//     (collide with filenames + identifiers in chat).
//   - Non-empty interior, no leading/trailing whitespace.
//   - No newlines inside the run.
//   - No nesting in v1. Triple-asterisk `***foo***` falls through as plain
//     text (interior may not begin with `*`).
//   - Adjacent or empty runs (`****`, `**`, `* *`) → literal text.

// Negative lookbehind/ahead `(?<!\*)` / `(?!\*)` block matches that are part
// of a longer asterisk run — e.g., `***foo***` should not match as
// bold-with-stray-asterisks; we want the whole thing literal until v2 adds
// nesting (per plan §8.1 + phoenix's flag).
const BOLD_RE = /(?<!\*)\*\*(?!\*)([^\s*][^*\n]*?[^\s*]|[^\s*])(?<!\*)\*\*(?!\*)/g;
const ITALIC_RE = /(?<!\*)\*(?!\*)([^\s*][^*\n]*?[^\s*]|[^\s*])\*(?!\*)/g;
const STRIKE_RE = /(?<!~)~~(?!~)([^\s~][^~\n]*?[^\s~]|[^\s~])(?<!~)~~(?!~)/g;

/**
 * Run the emphasis pass over a text-token VALUE. Returns segments with
 * offsets RELATIVE to the input text.
 *
 * @param {string} text
 * @returns {Array<{type: string, value: string, raw?: string, relStart: number, relEnd: number}>}
 */
export function parseEmphasis(text) {
  if (typeof text !== 'string' || text.length === 0) return [];

  const claims = [];
  BOLD_RE.lastIndex = 0;
  let m;
  while ((m = BOLD_RE.exec(text)) !== null) {
    claims.push({
      type: 'bold',
      relStart: m.index,
      relEnd: m.index + m[0].length,
      value: m[1],
      raw: m[0],
    });
  }

  ITALIC_RE.lastIndex = 0;
  while ((m = ITALIC_RE.exec(text)) !== null) {
    const start = m.index;
    const end = m.index + m[0].length;
    let overlap = false;
    for (const c of claims) {
      if (start < c.relEnd && end > c.relStart) {
        overlap = true;
        break;
      }
    }
    if (overlap) continue;
    claims.push({
      type: 'italic',
      relStart: start,
      relEnd: end,
      value: m[1],
      raw: m[0],
    });
  }

  STRIKE_RE.lastIndex = 0;
  while ((m = STRIKE_RE.exec(text)) !== null) {
    const start = m.index;
    const end = m.index + m[0].length;
    let overlap = false;
    for (const c of claims) {
      if (start < c.relEnd && end > c.relStart) {
        overlap = true;
        break;
      }
    }
    if (overlap) continue;
    claims.push({
      type: 'strike',
      relStart: start,
      relEnd: end,
      value: m[1],
      raw: m[0],
    });
  }

  if (claims.length === 0) {
    return [{ type: 'text', value: text, relStart: 0, relEnd: text.length }];
  }

  claims.sort((a, b) => a.relStart - b.relStart);
  const out = [];
  let cursor = 0;
  for (const c of claims) {
    if (c.relStart > cursor) {
      out.push({
        type: 'text',
        value: text.slice(cursor, c.relStart),
        relStart: cursor,
        relEnd: c.relStart,
      });
    }
    out.push(c);
    cursor = c.relEnd;
  }
  if (cursor < text.length) {
    out.push({
      type: 'text',
      value: text.slice(cursor),
      relStart: cursor,
      relEnd: text.length,
    });
  }
  return out;
}

/**
 * Full read-side parse: code tokens (via `parse()`) PLUS emphasis tokens
 * over text regions. Use this in `MessageBubble` + `RichText` for chat
 * rendering. Composer overlays continue to use `parse()`.
 *
 * @param {string} source
 * @returns {Array<{type: string, value: string, raw?: string, lang?: string|null, start?: number, end?: number}>}
 */
export function parseRich(source) {
  // Read-side: use the CommonMark-faithful inline-code rule so a span can
  // legally contain a longer backtick run (the `` ` ```markdown ` `` repro)
  // and 1/2/3-backtick delimiters all render as a single chip. The composer
  // overlay still calls bare `parse()` and keeps the no-flicker rule.
  const codeTokens = parse(source, { strictInline: true });
  const final = [];
  let cursor = 0;
  for (const t of codeTokens) {
    if (t.type === 'text') {
      const segs = parseEmphasis(t.value);
      const base = cursor;
      for (const s of segs) {
        if (s.type === 'text') {
          final.push({ type: 'text', value: s.value });
        } else {
          final.push({
            type: s.type,
            value: s.value,
            raw: s.raw,
            start: base + s.relStart,
            end: base + s.relEnd,
          });
        }
      }
      cursor += t.value.length;
    } else {
      final.push(t);
      cursor = t.end ?? cursor + (t.raw ? t.raw.length : 0);
    }
  }
  return final;
}
