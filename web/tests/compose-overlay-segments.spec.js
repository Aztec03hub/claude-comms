// Unit tests for compose-overlay-segments.js — the merge layer that combines
// rich-text (backtick) parser output with mention-overlay output for the
// MessageInput composer.
//
// Phil's regression (v2.1+): when the input contains BOTH backtick-code
// tokens AND an active @mention with a highlighted candidate, the ghost
// suggestion (the visual hint extending the partial query) was being dropped.
// Root cause: the placeholder-based expansion algorithm assigned a phantom
// position past source-end to the ghost segment, so it missed every text
// region. Fix: ghost segments are zero-width anchors at the cumulative
// source position; emitted whole when their anchor lies in a text region.

import { describe, it, expect } from 'vitest';

import {
  composeOverlaySegments,
  splitFencedBlock,
} from '../src/lib/compose-overlay-segments.js';

const PARTICIPANTS_NONE = [];

function makeSuggestion(atIndex, query) {
  return { atIndex, query };
}

describe('composeOverlaySegments — ghost suggestion preservation', () => {
  it('emits ghost segment for plain @mention prefix (no code tokens)', () => {
    // Plain text path — falls through to renderMentionSegments directly.
    const source = '@cl';
    const segs = composeOverlaySegments(
      source,
      PARTICIPANTS_NONE,
      makeSuggestion(0, 'cl'),
      { name: 'claude-ember', key: 'k1', online: true },
      null,
    );
    expect(segs.some((s) => s.type === 'ghost')).toBe(true);
    const ghost = segs.find((s) => s.type === 'ghost');
    expect(ghost.text).toBe('aude-ember');
  });

  it('emits ghost segment when @mention is BEFORE a code chip', () => {
    // Source has both an active @mention prefix AND a code token. The fix
    // ensures the ghost survives the placeholder-based merge.
    const source = '@cl and `code`';
    const segs = composeOverlaySegments(
      source,
      PARTICIPANTS_NONE,
      makeSuggestion(0, 'cl'),
      { name: 'claude-ember', key: 'k1', online: true },
      null,
    );
    const ghost = segs.find((s) => s.type === 'ghost');
    expect(ghost).toBeTruthy();
    expect(ghost.text).toBe('aude-ember');
    // Inline-code chip should also be present.
    expect(segs.some((s) => s.type === 'inline-code')).toBe(true);
  });

  it('emits ghost segment when @mention is AFTER a code chip', () => {
    // Cursor at end of source; ghost anchor at cursor position.
    const source = '`code` then @cl';
    const segs = composeOverlaySegments(
      source,
      PARTICIPANTS_NONE,
      makeSuggestion(12, 'cl'),
      { name: 'claude-ember', key: 'k1', online: true },
      null,
    );
    const ghost = segs.find((s) => s.type === 'ghost');
    expect(ghost).toBeTruthy();
    expect(ghost.text).toBe('aude-ember');
    expect(segs.some((s) => s.type === 'inline-code')).toBe(true);
  });

  it('emits ghost segment when @mention is BETWEEN two code chips', () => {
    const source = '`a` @cl `b`';
    const segs = composeOverlaySegments(
      source,
      PARTICIPANTS_NONE,
      makeSuggestion(4, 'cl'),
      { name: 'claude-ember', key: 'k1', online: true },
      null,
    );
    const ghost = segs.find((s) => s.type === 'ghost');
    expect(ghost).toBeTruthy();
    expect(ghost.text).toBe('aude-ember');
    const chips = segs.filter((s) => s.type === 'inline-code');
    expect(chips).toHaveLength(2);
  });

  it('does NOT emit ghost for an exact-match query (would be redundant)', () => {
    // When the active suggestion's query exactly matches the highlighted
    // candidate's name, renderMentionSegments suppresses the ghost (avoids
    // painting "" or repeating the name). composeOverlaySegments should
    // pass that through unchanged.
    const source = '@claude-ember';
    const segs = composeOverlaySegments(
      source,
      PARTICIPANTS_NONE,
      makeSuggestion(0, 'claude-ember'),
      { name: 'claude-ember', key: 'k1', online: true },
      null,
    );
    expect(segs.some((s) => s.type === 'ghost')).toBe(false);
  });

  it('emits ghost when there is no highlighted candidate? then no ghost', () => {
    // Defensive: if highlightedCandidate is null, no ghost is emitted by
    // renderMentionSegments at all.
    const source = '@cl `code`';
    const segs = composeOverlaySegments(
      source,
      PARTICIPANTS_NONE,
      makeSuggestion(0, 'cl'),
      null,
      null,
    );
    expect(segs.some((s) => s.type === 'ghost')).toBe(false);
  });
});

describe('composeOverlaySegments — segments exactly cover the source', () => {
  // The overlay MUST mirror the textarea character-for-character — any extra
  // or missing character shifts the colored glyphs off the underlying text
  // (the misalignment behind Phil's "doubled on selection" report). These
  // tests assert the concatenation of all NON-ghost segment texts equals the
  // source exactly, and that mention segments land on the right offsets.
  //
  // Ghost segments are PHANTOM (not present in the source string), so they are
  // excluded from the coverage concatenation.
  function coverage(segs) {
    return segs.filter((s) => s.type !== 'ghost').map((s) => s.text).join('');
  }

  it('covers a single confirmed mention + trailing text', () => {
    const source = '@bob hello';
    const segs = composeOverlaySegments(
      source,
      [{ start: 0, end: 4, name: 'bob', key: 'k-bob' }],
      null,
      null,
      null,
    );
    expect(coverage(segs)).toBe(source);
  });

  it('covers TWO space-separated mentions with correct offsets (the @Iris @Sol shape)', () => {
    const source = '@ember @sage hi';
    const tokens = [
      { start: 0, end: 6, name: 'ember', key: 'k-ember' },
      { start: 7, end: 12, name: 'sage', key: 'k-sage' },
    ];
    const segs = composeOverlaySegments(source, tokens, null, null, null);
    // Exact coverage — no dropped/duplicated characters.
    expect(coverage(segs)).toBe(source);
    // The two mention spans carry exactly the source slices for their ranges.
    const mentions = segs.filter((s) => s.type === 'mention-confirmed');
    expect(mentions.map((s) => s.text)).toEqual(['@ember', '@sage']);
    // The separating space survives as its own plain-text segment between them.
    const idxEmber = segs.findIndex((s) => s.text === '@ember');
    const idxSage = segs.findIndex((s) => s.text === '@sage');
    expect(idxSage).toBeGreaterThan(idxEmber);
    expect(segs.slice(idxEmber + 1, idxSage).map((s) => s.text).join('')).toBe(' ');
  });

  it('covers a long MULTI-LINE wrapped input with mentions on several lines', () => {
    // Vertical-axis regression (Phil): over many wrapped lines the overlay must
    // stay character-exact with the textarea so the caret, native spellcheck
    // squigglies, and overlay coloring share one baseline. Character coverage
    // is the prerequisite for pixel alignment — if the segment stream drifts by
    // one character on line 1, every later line is off too. We build a 12-line
    // body with mentions on different lines and assert exact coverage + offsets.
    const lines = [];
    for (let n = 0; n < 12; n++) {
      lines.push(`line ${n} some reasonably long content here to force wrapping`);
    }
    lines[0] = '@ember ' + lines[0];
    lines[6] = lines[6] + ' cc @sage';
    const source = lines.join('\n');

    const sageStart = source.indexOf('@sage');
    const tokens = [
      { start: 0, end: '@ember'.length, name: 'ember', key: 'k-ember' },
      { start: sageStart, end: sageStart + '@sage'.length, name: 'sage', key: 'k-sage' },
    ];

    const segs = composeOverlaySegments(source, tokens, null, null, null);
    // Exact coverage across all 12 lines — no drift, no dropped newlines.
    expect(coverage(segs)).toBe(source);
    // Both mentions render with their exact source slices.
    const mentions = segs.filter((s) => s.type === 'mention-confirmed');
    expect(mentions.map((s) => s.text)).toEqual(['@ember', '@sage']);
    // All 12 source lines are preserved (newlines survive as plain text so the
    // overlay wraps on the same physical lines as the textarea).
    expect(coverage(segs).split('\n')).toHaveLength(12);
  });

  it('covers mentions interleaved with an inline-code chip', () => {
    const source = '@bob run `npm test` ok';
    const segs = composeOverlaySegments(
      source,
      [{ start: 0, end: 4, name: 'bob', key: 'k-bob' }],
      null,
      null,
      null,
    );
    // Coverage must equal the source even with the code-token merge path.
    expect(coverage(segs)).toBe(source);
    expect(segs.some((s) => s.type === 'inline-code')).toBe(true);
    expect(segs.some((s) => s.type === 'mention-confirmed' && s.text === '@bob')).toBe(true);
  });

  it('preserves ghost when input contains a code BLOCK (not just chip)', () => {
    // Block-code spans multiple chars; ghost should still survive the merge.
    const source = '@cl\n```\nfoo\n```';
    const segs = composeOverlaySegments(
      source,
      PARTICIPANTS_NONE,
      makeSuggestion(0, 'cl'),
      { name: 'claude-ember', key: 'k1', online: true },
      null,
    );
    const ghost = segs.find((s) => s.type === 'ghost');
    expect(ghost).toBeTruthy();
    expect(ghost.text).toBe('aude-ember');
    expect(segs.some((s) => s.type === 'block-code')).toBe(true);
  });
});

describe('splitFencedBlock', () => {
  it('splits a closed block into open / body / close, reproducing raw exactly', () => {
    const tok = { type: 'block-code', raw: '```js\nfoo\nbar\n```' };
    const { open, body, close } = splitFencedBlock(tok);
    expect(open).toBe('```js\n');
    expect(body).toBe('foo\nbar');
    expect(close).toBe('\n```');
    expect(open + body + close).toBe(tok.raw);
  });

  it('handles an empty-body closed block', () => {
    const tok = { type: 'block-code', raw: '```\n```' };
    const { open, body, close } = splitFencedBlock(tok);
    expect(open).toBe('```\n');
    expect(body).toBe('');
    expect(close).toBe('```');
    expect(open + body + close).toBe(tok.raw);
  });

  it('handles an unclosed block (no closing fence)', () => {
    const tok = { type: 'unclosed-block', raw: '```py\nx = 1' };
    const { open, body, close } = splitFencedBlock(tok);
    expect(open).toBe('```py\n');
    expect(body).toBe('x = 1');
    expect(close).toBe('');
    expect(open + body + close).toBe(tok.raw);
  });

  it('handles a bare opening fence with no newline', () => {
    const tok = { type: 'unclosed-block', raw: '```js' };
    const { open, body, close } = splitFencedBlock(tok);
    expect(open).toBe('```js');
    expect(body).toBe('');
    expect(close).toBe('');
  });
});

describe('composeOverlaySegments — code backticks/fences are hidden but width-preserving', () => {
  // Phil regression: after a code span/block is complete, the literal backticks
  // must DISAPPEAR so only the bubble/chip shows. We render them as dedicated
  // segments (inline-code-tick / block-code-fence) that the CSS paints
  // transparent — the CHARACTERS stay present so the overlay's coverage still
  // equals the source exactly (alignment), but the glyphs are invisible.
  function coverage(segs) {
    return segs.filter((s) => s.type !== 'ghost').map((s) => s.text).join('');
  }

  it('inline code emits backtick segments around the body; coverage exact', () => {
    const source = 'see `npm test` now';
    const segs = composeOverlaySegments(source, [], null, null, null);
    const ticks = segs.filter((s) => s.type === 'inline-code-tick');
    expect(ticks).toHaveLength(2);
    expect(ticks.every((t) => t.text === '`')).toBe(true);
    // The visible chip body carries ONLY the inner value (no backticks).
    const chip = segs.find((s) => s.type === 'inline-code');
    expect(chip.text).toBe('npm test');
    // But the full source (backticks included) is still covered exactly.
    expect(coverage(segs)).toBe(source);
  });

  it('fenced block emits open + body + close fence segments; coverage exact', () => {
    const source = '```js\nfoo\nbar\n```';
    const segs = composeOverlaySegments(source, [], null, null, null);
    const fences = segs.filter((s) => s.type === 'block-code-fence');
    // Opening fence (```js\n) and closing fence (\n```).
    expect(fences.map((f) => f.text)).toEqual(['```js\n', '\n```']);
    // The visible body carries ONLY the code, no fences.
    const body = segs.find((s) => s.type === 'block-code');
    expect(body.text).toBe('foo\nbar');
    // Full source including fences is covered exactly (alignment preserved).
    expect(coverage(segs)).toBe(source);
  });

  it('unclosed block emits an opening fence segment only; coverage exact', () => {
    const source = '```py\nx = 1';
    const segs = composeOverlaySegments(source, [], null, null, null);
    const fences = segs.filter((s) => s.type === 'block-code-fence');
    expect(fences.map((f) => f.text)).toEqual(['```py\n']);
    expect(coverage(segs)).toBe(source);
  });
});
