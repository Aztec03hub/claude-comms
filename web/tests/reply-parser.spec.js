// Unit tests for src/lib/reply-parser.js — pure parser for the `/reply`
// slash command per the threaded-replies plan §6.
//
// `parseReply(input)` returns
//   { replyTo: string | null, body: string, error: string | null }
//
// Coverage
// ────────
//   Happy paths (single id, surrounding whitespace, body with internal
//   whitespace), surface-shape rejections (missing trigger, missing id,
//   malformed id), and body validation (empty body after id).
//
// The parser is a PURE function. No DOM, no store, no side effects.
// Server is the authority on existence / same-conv / depth-2 / non-system
// validation; the parser screens only the surface UUID shape so typos
// surface to the user without a server round-trip.

import { describe, test, expect } from 'vitest';
import { parseReply } from '../src/lib/reply-parser.js';

// ── Fixtures ───────────────────────────────────────────────────────────

const VALID_ID_1 = 'b899d2cf-d645-4644-bf27-d3f4bd6494ed';
const VALID_ID_2 = '2bb3f903-5dcb-49ec-a937-d5740619db83';

// ── Happy paths ────────────────────────────────────────────────────────

describe('parseReply — happy paths', () => {
  test('basic /reply with id and body', () => {
    const result = parseReply(`/reply ${VALID_ID_1} agreed`);
    expect(result.error).toBeNull();
    expect(result.replyTo).toBe(VALID_ID_1);
    expect(result.body).toBe('agreed');
  });

  test('multi-word body preserved verbatim', () => {
    const result = parseReply(`/reply ${VALID_ID_1} agreed, ship it tomorrow`);
    expect(result.error).toBeNull();
    expect(result.replyTo).toBe(VALID_ID_1);
    expect(result.body).toBe('agreed, ship it tomorrow');
  });

  test('leading whitespace tolerated', () => {
    const result = parseReply(`   /reply ${VALID_ID_1} hi`);
    expect(result.error).toBeNull();
    expect(result.replyTo).toBe(VALID_ID_1);
    expect(result.body).toBe('hi');
  });

  test('extra whitespace between trigger and id collapsed', () => {
    const result = parseReply(`/reply    ${VALID_ID_1}    body text`);
    expect(result.error).toBeNull();
    expect(result.replyTo).toBe(VALID_ID_1);
    expect(result.body).toBe('body text');
  });

  test('tab separator works', () => {
    const result = parseReply(`/reply\t${VALID_ID_1}\tbody`);
    expect(result.error).toBeNull();
    expect(result.replyTo).toBe(VALID_ID_1);
    expect(result.body).toBe('body');
  });

  test('body containing @mentions left intact', () => {
    // /reply does NOT do @-token magic the way /dm does. Mentions in the
    // body are passed through verbatim and resolved by the existing
    // mention-classification path on the wire.
    const result = parseReply(`/reply ${VALID_ID_1} cc @ember see thread`);
    expect(result.error).toBeNull();
    expect(result.replyTo).toBe(VALID_ID_1);
    expect(result.body).toBe('cc @ember see thread');
  });

  test('different valid id resolves cleanly', () => {
    const result = parseReply(`/reply ${VALID_ID_2} k`);
    expect(result.error).toBeNull();
    expect(result.replyTo).toBe(VALID_ID_2);
    expect(result.body).toBe('k');
  });
});

// ── Surface-shape rejections ───────────────────────────────────────────

describe('parseReply — rejections', () => {
  test('missing trigger', () => {
    const result = parseReply('hello world');
    expect(result.error).toBe('Missing /reply trigger');
    expect(result.replyTo).toBeNull();
    expect(result.body).toBe('');
  });

  test('non-string input rejected as empty body', () => {
    expect(parseReply(null).error).toBe('Empty message body');
    expect(parseReply(undefined).error).toBe('Empty message body');
    expect(parseReply(42).error).toBe('Empty message body');
  });

  test('almost-trigger (no whitespace after) rejected', () => {
    // `/replyfoo` is NOT a /reply command — must be `/reply` followed by
    // whitespace OR end of string.
    const result = parseReply('/replyfoo bar');
    expect(result.error).toBe('Missing /reply trigger');
  });

  test('bare /reply with no id', () => {
    const result = parseReply('/reply');
    expect(result.error).toBe('Missing message id');
  });

  test('bare /reply with trailing whitespace only', () => {
    const result = parseReply('/reply   ');
    expect(result.error).toBe('Missing message id');
  });

  test('malformed id (too short) surfaces token in error', () => {
    const result = parseReply('/reply abc hi');
    expect(result.error).toBe('Invalid message id: abc');
  });

  test('malformed id (uppercase hex) rejected — wire is lowercase', () => {
    const result = parseReply('/reply B899D2CF-D645-4644-BF27-D3F4BD6494ED hi');
    expect(result.error).toMatch(/^Invalid message id:/);
  });

  test('malformed id (missing hyphens) rejected', () => {
    const result = parseReply('/reply b899d2cfd6454644bf27d3f4bd6494ed hi');
    expect(result.error).toMatch(/^Invalid message id:/);
  });

  test('malformed id (extra char) rejected', () => {
    const result = parseReply(`/reply ${VALID_ID_1}x hi`);
    expect(result.error).toMatch(/^Invalid message id:/);
  });

  test('valid id but empty body', () => {
    const result = parseReply(`/reply ${VALID_ID_1}`);
    expect(result.error).toBe('Empty message body');
  });

  test('valid id followed by whitespace only', () => {
    const result = parseReply(`/reply ${VALID_ID_1}    `);
    expect(result.error).toBe('Empty message body');
  });
});

// ── Shape consistency ──────────────────────────────────────────────────

describe('parseReply — shape consistency', () => {
  test('failure shape always has null replyTo and empty body', () => {
    const cases = [
      'no trigger',
      '/reply',
      '/reply badid hi',
      `/reply ${VALID_ID_1}`,
    ];
    for (const input of cases) {
      const result = parseReply(input);
      expect(result.error).toBeTruthy();
      expect(result.replyTo).toBeNull();
      expect(result.body).toBe('');
    }
  });

  test('success shape always has null error', () => {
    const result = parseReply(`/reply ${VALID_ID_1} ok`);
    expect(result.error).toBeNull();
    expect(typeof result.replyTo).toBe('string');
    expect(typeof result.body).toBe('string');
  });
});
