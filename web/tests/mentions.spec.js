// Unit tests for src/lib/mentions.js — pure helper module backing the
// @mention autocomplete in MessageInput.
//
// Coverage
// ────────
//   1. parseMentions edit reconciliation:
//      - typing `@cl` at end → activeSuggestion {atIndex, query: 'cl'}
//      - committing `@claude-test` produces a token at the right range
//      - inserting text BEFORE a token shifts the token correctly
//      - typing inside a confirmed token invalidates it and re-spins
//      - typing a letter immediately after a confirmed token (extending)
//        invalidates the token and re-spins for a longer query
//      - backspace into a token's name invalidates the token and re-spins
//      - paste-broken token (text changed under the token) is dropped by
//        the sanity check
//      - comma after a committed token preserves the token
//      - commit at the END of an existing token does NOT spawn a fresh
//        active suggestion
//   2. filterCandidates:
//      - case-insensitive prefix match
//      - online ranked first, alpha tie-breaker
//      - excludes self
//      - caps at 7
//      - empty query returns all (still capped + sorted)
//   3. findExactMatch:
//      - case-insensitive exact match
//      - returns null when query is empty or no match
//   4. commitMention:
//      - replaces the @-prefix range with @{name}, no trailing space
//      - new token has correct (start, end, name, key)
//      - tokens after the commit point shift by the delta
//      - cursor returned at end of inserted token
//   5. tokensToRecipients:
//      - dedupes keys, preserves insertion order
//   6. renderSegments:
//      - confirmed token rendered as 'mention-confirmed'
//      - active suggestion at cursor with no exact match shows ghost text
//      - exact match shows pending+ghost (no ghost since query==name)
//
// Read alongside `plans/mention-autocomplete-revamp.md`.

import { describe, it, expect } from 'vitest';
import {
  parseMentions,
  filterCandidates,
  findExactMatch,
  commitMention,
  computeEditRange,
  tokensToRecipients,
  renderSegments,
  isWordTerminator,
} from '../src/lib/mentions.js';

// ── computeEditRange ───────────────────────────────────────────────────

describe('computeEditRange', () => {
  it('returns identity range for unchanged text', () => {
    const r = computeEditRange('hello', 5, 'hello', 5);
    expect(r).toEqual({ start: 5, oldEnd: 5, newEnd: 5 });
  });
  it('detects a single-character insertion at cursor', () => {
    const r = computeEditRange('helo', 3, 'hello', 4);
    // prefix='hel' (cap by cursor=4 so we stop at 'l' at index 3),
    // suffix='o' on both sides.
    expect(r.start).toBe(3);
    expect(r.oldEnd).toBe(3);
    expect(r.newEnd).toBe(4);
  });
  it('detects a deletion', () => {
    const r = computeEditRange('hello', 5, 'helo', 4);
    // prefix='hel' shared, suffix='o' shared → edited 'l' at index 3.
    expect(r.start).toBe(3);
    expect(r.oldEnd).toBe(4);
    expect(r.newEnd).toBe(3);
  });
  it('detects a multi-char insert at the end', () => {
    const r = computeEditRange('hi', 2, 'hi there', 8);
    expect(r.start).toBe(2);
    expect(r.oldEnd).toBe(2);
    expect(r.newEnd).toBe(8);
  });
});

// ── parseMentions ──────────────────────────────────────────────────────

describe('parseMentions — active suggestion detection', () => {
  it('typing `@cl` triggers active suggestion {atIndex:0, query:"cl"}', () => {
    const oldText = '@c';
    const newText = '@cl';
    const r = parseMentions(newText, [], oldText, 2, 3);
    expect(r.tokens).toEqual([]);
    expect(r.activeSuggestion).toEqual({ atIndex: 0, query: 'cl' });
  });

  it('typing `@` alone triggers an empty-query suggestion', () => {
    const r = parseMentions('hello @', [], 'hello ', 6, 7);
    expect(r.activeSuggestion).toEqual({ atIndex: 6, query: '' });
  });

  it('cursor not at end of @-prefix → no active suggestion', () => {
    // Cursor in the middle of the string, no '@' immediately preceding.
    const r = parseMentions('hello world', [], 'hello world', 5, 5);
    expect(r.activeSuggestion).toBeNull();
  });

  it('@ followed by space terminates the query — no suggestion', () => {
    const r = parseMentions('@cl ', [], '@cl', 3, 4);
    expect(r.activeSuggestion).toBeNull();
  });
});

describe('parseMentions — token offset shifting', () => {
  it('inserting text BEFORE a token shifts the token forward', () => {
    // Old: "@bob hello" with token at 0..4.
    // New: "hi @bob hello" — user prepended "hi " at index 0.
    const oldText = '@bob hello';
    const newText = 'hi @bob hello';
    const tokens = [{ start: 0, end: 4, name: 'bob', key: 'k-bob' }];
    const r = parseMentions(newText, tokens, oldText, 0, 3);
    expect(r.tokens).toHaveLength(1);
    expect(r.tokens[0]).toEqual({ start: 3, end: 7, name: 'bob', key: 'k-bob' });
  });

  it('inserting text AFTER a token leaves the token unchanged', () => {
    const oldText = '@bob ';
    const newText = '@bob hello';
    const tokens = [{ start: 0, end: 4, name: 'bob', key: 'k-bob' }];
    const r = parseMentions(newText, tokens, oldText, 5, 10);
    expect(r.tokens).toEqual([{ start: 0, end: 4, name: 'bob', key: 'k-bob' }]);
  });

  it('a comma typed immediately after a committed token preserves it', () => {
    const oldText = '@bob';
    const newText = '@bob,';
    const tokens = [{ start: 0, end: 4, name: 'bob', key: 'k-bob' }];
    const r = parseMentions(newText, tokens, oldText, 4, 5);
    expect(r.tokens).toEqual([{ start: 0, end: 4, name: 'bob', key: 'k-bob' }]);
    expect(r.activeSuggestion).toBeNull();
  });
});

describe('parseMentions — token invalidation', () => {
  it('backspacing INTO a token name drops the token and re-spins suggestion', () => {
    // "@bob" → backspace one char → "@bo"
    const oldText = '@bob';
    const newText = '@bo';
    const tokens = [{ start: 0, end: 4, name: 'bob', key: 'k-bob' }];
    const r = parseMentions(newText, tokens, oldText, 4, 3);
    expect(r.tokens).toEqual([]);
    expect(r.activeSuggestion).toEqual({ atIndex: 0, query: 'bo' });
  });

  it('typing a letter at the END of a token strictly extends it → invalidate', () => {
    // "@bob" → user types 's' → "@bobs"
    const oldText = '@bob';
    const newText = '@bobs';
    const tokens = [{ start: 0, end: 4, name: 'bob', key: 'k-bob' }];
    const r = parseMentions(newText, tokens, oldText, 4, 5);
    expect(r.tokens).toEqual([]);
    expect(r.activeSuggestion).toEqual({ atIndex: 0, query: 'bobs' });
  });

  it('cursor lands exactly at end of a committed token → no active suggestion', () => {
    // Already-committed "@bob hello" with token 0..4. Click cursor at index 4.
    const oldText = '@bob hello';
    const newText = '@bob hello';
    const tokens = [{ start: 0, end: 4, name: 'bob', key: 'k-bob' }];
    const r = parseMentions(newText, tokens, oldText, 4, 4);
    expect(r.tokens).toHaveLength(1);
    expect(r.activeSuggestion).toBeNull();
  });

  it('paste-broken token (text changed under the token) drops the token', () => {
    // Old: "@bob" with token. Paste replaces all → "different".
    const oldText = '@bob';
    const newText = 'different';
    const tokens = [{ start: 0, end: 4, name: 'bob', key: 'k-bob' }];
    const r = parseMentions(newText, tokens, oldText, 4, 9);
    expect(r.tokens).toEqual([]);
  });

  it('clicking the cursor INTO a token range still invalidates it (even no edit)', () => {
    // No text change, cursor moves into the middle of the token.
    const text = '@bob hello';
    const tokens = [{ start: 0, end: 4, name: 'bob', key: 'k-bob' }];
    const r = parseMentions(text, tokens, text, 5, 2);
    // Per parseMentions Pass 3: cursor inside a covering token → invalidate.
    expect(r.tokens).toEqual([]);
    expect(r.activeSuggestion).toEqual({ atIndex: 0, query: 'b' });
  });
});

// ── filterCandidates ───────────────────────────────────────────────────

const FIXTURE_PARTICIPANTS = {
  'phil-key': { key: 'phil-key', name: 'phil', connections: { 'web-1': {} } },
  'claude-key': {
    key: 'claude-key',
    name: 'claude-test',
    connections: { 'mcp-1': {} },
  },
  'bob-key': { key: 'bob-key', name: 'bob', connections: {} },
  'alice-key': {
    key: 'alice-key',
    name: 'alice',
    connections: { 'tui-1': {} },
  },
  'carol-key': { key: 'carol-key', name: 'carol', connections: {} },
};

describe('filterCandidates', () => {
  it('case-insensitive prefix match', () => {
    const r = filterCandidates(FIXTURE_PARTICIPANTS, 'CL', 'phil-key');
    expect(r.map((c) => c.name)).toEqual(['claude-test']);
  });

  it('online participants ranked before offline (with alpha tie-break)', () => {
    const r = filterCandidates(FIXTURE_PARTICIPANTS, '', 'phil-key');
    // Online: alice (tui-1), claude-test (mcp-1) → alpha order.
    // Offline: bob, carol → alpha order.
    expect(r.map((c) => c.name)).toEqual(['alice', 'claude-test', 'bob', 'carol']);
    expect(r[0].online).toBe(true);
    expect(r[2].online).toBe(false);
  });

  it('excludes self (currentUserKey)', () => {
    const r = filterCandidates(FIXTURE_PARTICIPANTS, '', 'claude-key');
    expect(r.find((c) => c.key === 'claude-key')).toBeUndefined();
  });

  it('caps at 7 candidates', () => {
    const big = {};
    for (let i = 0; i < 20; i++) {
      big[`k${i}`] = {
        key: `k${i}`,
        name: `user${String(i).padStart(2, '0')}`,
        connections: { 'web-1': {} },
      };
    }
    const r = filterCandidates(big, 'user', 'self');
    expect(r).toHaveLength(7);
  });

  it('accepts an array as well as a key→participant map', () => {
    const arr = Object.values(FIXTURE_PARTICIPANTS);
    const r = filterCandidates(arr, 'a', 'phil-key');
    expect(r.map((c) => c.name).sort()).toEqual(['alice']);
  });

  it('non-prefix substrings do NOT match (prefix only)', () => {
    const r = filterCandidates(FIXTURE_PARTICIPANTS, 'aude', 'phil-key');
    expect(r).toEqual([]);
  });

  it('exposes online flag derived from connections map', () => {
    const r = filterCandidates(FIXTURE_PARTICIPANTS, 'al', 'phil-key');
    expect(r[0]).toMatchObject({ name: 'alice', online: true });
  });
});

// ── findExactMatch ─────────────────────────────────────────────────────

describe('findExactMatch', () => {
  const candidates = [
    { name: 'claude-test', key: 'k1', online: true },
    { name: 'Bob', key: 'k2', online: false },
  ];

  it('case-insensitive exact match', () => {
    expect(findExactMatch('CLAUDE-TEST', candidates)).toMatchObject({ key: 'k1' });
    expect(findExactMatch('bob', candidates)).toMatchObject({ key: 'k2' });
  });

  it('returns null on partial match or empty query', () => {
    expect(findExactMatch('claude', candidates)).toBeNull();
    expect(findExactMatch('', candidates)).toBeNull();
    expect(findExactMatch(undefined, candidates)).toBeNull();
  });
});

// ── commitMention ──────────────────────────────────────────────────────

describe('commitMention', () => {
  it('inserts the @name with no trailing space', () => {
    const r = commitMention('hi @cl', [], 3, 6, { name: 'claude-test', key: 'k1' });
    expect(r.text).toBe('hi @claude-test');
    expect(r.newCursor).toBe(15);
    expect(r.tokens).toHaveLength(1);
    expect(r.tokens[0]).toEqual({
      start: 3,
      end: 15,
      name: 'claude-test',
      key: 'k1',
    });
  });

  it('preserves text after the commit point', () => {
    const r = commitMention('@cl, hello', [], 0, 3, { name: 'claude-test', key: 'k1' });
    expect(r.text).toBe('@claude-test, hello');
    expect(r.newCursor).toBe(12);
  });

  it('shifts existing tokens past the commit point by the length delta', () => {
    // " @bob @cl" with @bob already a token, then commit @cl as @claude-test.
    // Wait — tokens after commit point shift forward; tokens before stay.
    // We exercise this with a token AFTER the commit point.
    const text = '@cl @bob';
    const tokens = [{ start: 4, end: 8, name: 'bob', key: 'k-bob' }];
    const r = commitMention(text, tokens, 0, 3, { name: 'claude-test', key: 'k-claude' });
    expect(r.text).toBe('@claude-test @bob');
    // bob token shifts by (12 - 3) = 9 chars → start now 13, end 17.
    const bob = r.tokens.find((t) => t.key === 'k-bob');
    expect(bob).toEqual({ start: 13, end: 17, name: 'bob', key: 'k-bob' });
  });
});

// ── tokensToRecipients ─────────────────────────────────────────────────

describe('tokensToRecipients', () => {
  it('extracts keys, dedupes, preserves insertion order', () => {
    const tokens = [
      { start: 0, end: 4, name: 'bob', key: 'k-bob' },
      { start: 5, end: 16, name: 'claude-test', key: 'k-claude' },
      { start: 17, end: 21, name: 'bob', key: 'k-bob' }, // dup
    ];
    expect(tokensToRecipients(tokens)).toEqual(['k-bob', 'k-claude']);
  });

  it('returns [] for no tokens', () => {
    expect(tokensToRecipients([])).toEqual([]);
  });
});

// ── renderSegments ─────────────────────────────────────────────────────

describe('renderSegments', () => {
  it('renders a confirmed token as mention-confirmed', () => {
    const tokens = [{ start: 0, end: 4, name: 'bob', key: 'k-bob' }];
    const segs = renderSegments('@bob', tokens, null, null, null);
    expect(segs).toEqual([{ type: 'mention-confirmed', text: '@bob' }]);
  });

  it('renders mention-confirmed + trailing plain text', () => {
    const tokens = [{ start: 0, end: 4, name: 'bob', key: 'k-bob' }];
    const segs = renderSegments('@bob hello', tokens, null, null, null);
    expect(segs).toEqual([
      { type: 'mention-confirmed', text: '@bob' },
      { type: 'text', text: ' hello' },
    ]);
  });

  it('drops a ghost suggestion when highlighted candidate extends the query', () => {
    // Text "@cl" with active suggestion at index 0, query 'cl', highlighted
    // candidate 'claude-test' → ghost is 'aude-test' (the unentered tail).
    const segs = renderSegments(
      '@cl',
      [],
      { atIndex: 0, query: 'cl' },
      { name: 'claude-test', key: 'k1', online: true },
      null,
    );
    // Expected: '@cl' as text, then ghost 'aude-test'.
    const ghost = segs.find((s) => s.type === 'ghost');
    expect(ghost?.text).toBe('aude-test');
  });

  it('renders pending exact match as mention-pending', () => {
    // Text "@bob" with active suggestion (no token yet), exact match 'bob'.
    const segs = renderSegments(
      '@bob',
      [],
      { atIndex: 0, query: 'bob' },
      { name: 'bob', key: 'k1', online: true },
      { name: 'bob', key: 'k1', online: true },
    );
    const pend = segs.find((s) => s.type === 'mention-pending');
    expect(pend?.text).toBe('@bob');
    // No ghost when query is the exact name.
    expect(segs.find((s) => s.type === 'ghost')).toBeUndefined();
  });
});

// ── isWordTerminator ───────────────────────────────────────────────────

describe('isWordTerminator', () => {
  it('flags expected terminators', () => {
    for (const c of [' ', ',', '.', ';', '(', ')', '!', '?', '/', '\n']) {
      expect(isWordTerminator(c)).toBe(true);
    }
  });
  it('does not flag normal characters', () => {
    for (const c of ['a', 'Z', '0', '_', '-']) {
      expect(isWordTerminator(c)).toBe(false);
    }
  });
});
