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

import { composeOverlaySegments } from '../src/lib/compose-overlay-segments.js';

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
