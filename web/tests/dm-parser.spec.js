// Unit tests for src/lib/dm-parser.js — pure parser for the `/dm` slash
// command per plans/mentions-vs-whisper-separation.md §6.2-A and §10.
//
// `parseDM(input, participants, senderKey)` returns
//   { recipients: string[], body: string, error: string | null }
//
// Coverage
// ────────
//   §10 cases 1–10 (the slash-command parser matrix), plus defensive
//   tests for whitespace, body-internal `@`, punctuation, and shape
//   consistency.
//
// The parser is a PURE function. No DOM, no store, no side effects.
// Sender-key dedup is applied at parse-time per §6.2-A bullet 4 + 9.
// Wire-format `recipients` always carries 8-hex keys (never names) per
// §6.2-A bullet 3.
//
// Body composition rule (§6.2-A bullet 7): body strips the `/dm @r1, @r2`
// prefix AND prepends parser-injected `@name` tokens for each resolved
// recipient. So `/dm @ember hi` produces body `"@ember hi"` (NOT just
// `"hi"`). This is what drives MessageBubble's render-side mention
// classification post-strip.

import { describe, test, expect } from 'vitest';
import { parseDM } from '../src/lib/dm-parser.js';

// ── Fixtures ───────────────────────────────────────────────────────────

/**
 * Participants map — same shape as `store.participants`. Three entries
 * cover sender (phil) + two valid recipients (ember, sage).
 */
const participants = {
  'aea026a7': { key: 'aea026a7', name: 'ember', type: 'claude' },
  'd319475c': { key: 'd319475c', name: 'sage', type: 'claude' },
  'a1aece1b': { key: 'a1aece1b', name: 'phil', type: 'human' },
};

const PHIL_KEY = 'a1aece1b';
const EMBER_KEY = 'aea026a7';
const SAGE_KEY = 'd319475c';

// ── §10 matrix cases 1–10 ──────────────────────────────────────────────

describe('parseDM — §10 matrix', () => {
  test('test_single_recipient_basic — case 1: `/dm @ember hi`', () => {
    const result = parseDM('/dm @ember hi', participants, PHIL_KEY);
    expect(result.error).toBeNull();
    expect(result.recipients).toEqual([EMBER_KEY]);
    // §6.2-A bullet 7: body has parser-injected @ember prefix.
    expect(result.body).toBe('@ember hi');
  });

  test('test_multi_recipient_comma_space — case 2: `/dm @ember, @sage hi`', () => {
    const result = parseDM('/dm @ember, @sage hi', participants, PHIL_KEY);
    expect(result.error).toBeNull();
    expect(result.recipients).toEqual([EMBER_KEY, SAGE_KEY]);
    expect(result.body).toBe('@ember @sage hi');
  });

  test('test_multi_recipient_comma_no_space — case 3: `/dm @ember,@sage hi`', () => {
    const result = parseDM('/dm @ember,@sage hi', participants, PHIL_KEY);
    expect(result.error).toBeNull();
    expect(result.recipients).toEqual([EMBER_KEY, SAGE_KEY]);
    expect(result.body).toBe('@ember @sage hi');
  });

  test('test_recipient_list_ends_at_first_non_at_token — case 4: `/dm @ember hi @sage`', () => {
    // Trailing @sage is BODY content, not a recipient (per §6.2-A bullet 2).
    const result = parseDM('/dm @ember hi @sage', participants, PHIL_KEY);
    expect(result.error).toBeNull();
    expect(result.recipients).toEqual([EMBER_KEY]);
    // Body has parser-injected @ember prefix + the original trailing `@sage`.
    expect(result.body).toBe('@ember hi @sage');
  });

  test('test_reject_unknown_recipient — case 5: `/dm @notanyone hi`', () => {
    const result = parseDM('/dm @notanyone hi', participants, PHIL_KEY);
    expect(result.error).toBeTruthy();
    // Error must surface the bad token so the composer can highlight it.
    expect(result.error).toMatch(/notanyone/i);
    expect(result.recipients).toEqual([]);
    expect(result.body).toBe('');
  });

  test('test_reject_no_recipients — case 6: `/dm hi`', () => {
    const result = parseDM('/dm hi', participants, PHIL_KEY);
    expect(result.error).toBeTruthy();
    // Match either "No recipients" or "recipients specified" wording.
    expect(result.error).toMatch(/recipient/i);
    expect(result.recipients).toEqual([]);
    expect(result.body).toBe('');
  });

  test('test_reject_self_dm — case 7: `/dm @phil hi` (sender = phil)', () => {
    const result = parseDM('/dm @phil hi', participants, PHIL_KEY);
    expect(result.error).toBeTruthy();
    // After sender-self dedup, recipients is empty → reject. Wording mentions
    // self-DM (per §6.2-A bullet 6 — "all resolved recipients are the sender").
    expect(result.error).toMatch(/yourself|self/i);
    expect(result.recipients).toEqual([]);
    expect(result.body).toBe('');
  });

  test('test_reject_empty_body — case 8: `/dm @ember`', () => {
    const result = parseDM('/dm @ember', participants, PHIL_KEY);
    expect(result.error).toBeTruthy();
    expect(result.error).toMatch(/body|empty/i);
    expect(result.recipients).toEqual([]);
    expect(result.body).toBe('');
  });

  test('test_multi_recipient_with_self_dropped — case 9: `/dm @ember @phil hi` (sender = phil)', () => {
    // Phil's own key dropped at parse-time per §6.2-A bullet 4.
    const result = parseDM('/dm @ember @phil hi', participants, PHIL_KEY);
    expect(result.error).toBeNull();
    expect(result.recipients).toEqual([EMBER_KEY]);
    // Body's parser-injected prefix should reflect the deduped recipient list.
    expect(result.body).toBe('@ember hi');
  });

  test('test_reject_partial_unknown — case 10: `/dm @notanyone, @ember hi`', () => {
    // First failure wins, OR all-or-nothing — either way, error surfaces.
    const result = parseDM('/dm @notanyone, @ember hi', participants, PHIL_KEY);
    expect(result.error).toBeTruthy();
    expect(result.error).toMatch(/notanyone/i);
    expect(result.recipients).toEqual([]);
    expect(result.body).toBe('');
  });
});

// ── Defensive tests beyond the matrix ──────────────────────────────────

describe('parseDM — defensive cases', () => {
  test('test_dm_with_extra_whitespace — multiple spaces between recipients and body', () => {
    // Per §6.2-A bullet 1: trigger is `^/dm\s+` (any whitespace count).
    // Per bullet 2: separators include "any whitespace". Per bullet 5: body
    // has leading whitespace trimmed. Multiple spaces should still parse.
    const result = parseDM('  /dm   @ember   hi  ', participants, PHIL_KEY);
    expect(result.error).toBeNull();
    expect(result.recipients).toEqual([EMBER_KEY]);
    // The body is "@ember hi" — parser-injected prefix + body content.
    // Trailing whitespace handling is impl-detail; we accept either "hi" or
    // "hi  " in the BODY portion as long as the prefix is correct.
    expect(result.body).toMatch(/^@ember\s+hi/);
  });

  test('test_dm_with_punctuation_in_body — punctuation preserved verbatim', () => {
    const result = parseDM('/dm @ember hi! how are you?', participants, PHIL_KEY);
    expect(result.error).toBeNull();
    expect(result.recipients).toEqual([EMBER_KEY]);
    expect(result.body).toBe('@ember hi! how are you?');
  });

  test('test_dm_at_in_middle_of_body — @ inside body content not extracted as recipient', () => {
    // Email-like `me@example.com` in body must be kept as-is. The recipient
    // list ends at the first non-`@<name>` token (`email` is not @-prefixed),
    // so `me@example.com` is body content.
    const result = parseDM(
      '/dm @ember email me at me@example.com',
      participants,
      PHIL_KEY,
    );
    expect(result.error).toBeNull();
    expect(result.recipients).toEqual([EMBER_KEY]);
    expect(result.body).toBe('@ember email me at me@example.com');
  });

  test('test_returns_object_shape_consistency — error response has empty recipients/body', () => {
    // Error case: recipients=[], body='', error=<msg>
    const errResult = parseDM('/dm @notanyone hi', participants, PHIL_KEY);
    expect(errResult).toMatchObject({
      recipients: expect.any(Array),
      body: expect.any(String),
      error: expect.any(String),
    });
    expect(errResult.recipients).toEqual([]);
    expect(errResult.body).toBe('');
    expect(typeof errResult.error).toBe('string');
    expect(errResult.error.length).toBeGreaterThan(0);

    // Success case: error=null, recipients non-empty, body non-empty.
    const okResult = parseDM('/dm @ember hi', participants, PHIL_KEY);
    expect(okResult).toMatchObject({
      recipients: expect.any(Array),
      body: expect.any(String),
      error: null,
    });
    expect(okResult.recipients.length).toBeGreaterThan(0);
    expect(okResult.body.length).toBeGreaterThan(0);
  });
});
