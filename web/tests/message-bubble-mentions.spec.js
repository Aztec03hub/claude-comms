// Component tests for MessageBubble.svelte focused on the
// mentions-vs-whisper render-branch separation per
// plans/mentions-vs-whisper-separation.md §6.3 + §10 + §11 Phase D / F2.
//
// Coverage
// ────────
// Locks the renderer's per-segment classification of body-side `@name`
// tokens into one of three types:
//   - `mention-self`   — viewer's key is in `message.mentions`; renders as
//     a loud chip (`.mention-chip-self`) AND adds `.has-self-mention`
//     class to the bubble root for the 3px amber border accent.
//   - `mention-other`  — some other participant's key is in
//     `message.mentions`; renders as a quiet chip (`.mention-chip-other`).
//   - legacy `mention` — none of the above (key not in mentions, or
//     mentions is null/empty/undefined). Renders as the existing `.mention`
//     chip — preserves backwards compatibility with pre-cutover messages.
//
// Plus two cross-cutting rules the algorithm specifies:
//   1. **Sender-self special case** (§6.3 step 4): on the sender's OWN
//      bubble, any segment that would be `mention-self` is downgraded to
//      legacy `mention`. No loud self-chip on a message you sent.
//   2. **Whisper + mention overlap** (§10 Test #4 + R2-C1): when the
//      message is a whisper (`recipients` non-empty), the body-side `@name`
//      renders as legacy `.mention` chip + whisper bubble — NOT loud
//      self/other styling. Self/other classification is a mention-only
//      treatment.
//
// AMBIGUITY FLAG (sage-web contract §9): plan §6.3 step 3 doesn't
// explicitly gate self/other classification on `recipients` being
// null/empty. Plan §10 Test #4 + §6.3 R2-C1 text DO specify that whispers
// render legacy chips. The locked behavior per the test matrix is:
// whisper-bubble suppresses self/other classification → legacy `.mention`.
// The test below (`test_whisper_with_mention_renders_legacy_chip_not_self_other`)
// asserts the §10 outcome. If phoenix's renderer gates self/other on
// `!isTargeted`, this passes. If not, the renderer needs a gate added.
//
// All §10 cases below map to the matrix in plans/mentions-vs-whisper-separation.md.

import { describe, test, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';

import MessageBubble from '../src/components/MessageBubble.svelte';

// ── Fixtures ───────────────────────────────────────────────────────────

// Hex8-shaped keys to mirror the wire format. Names match the agent
// identities Phil uses in the Comms project (phil/ember/sage) so the
// fixtures read as realistic messages.
const PHIL_KEY = 'a1b2c3d4';
const EMBER_KEY = 'e1f2a3b4';
const SAGE_KEY = '5a6e7c8d';

const PARTICIPANTS = {
  [PHIL_KEY]: {
    key: PHIL_KEY,
    name: 'phil',
    type: 'human',
    connections: { 'web-1': {} },
  },
  [EMBER_KEY]: {
    key: EMBER_KEY,
    name: 'ember',
    type: 'claude',
    connections: { 'mcp-1': {} },
  },
  [SAGE_KEY]: {
    key: SAGE_KEY,
    name: 'sage',
    type: 'claude',
    connections: { 'mcp-2': {} },
  },
};

/**
 * Build a message object with the new wire-format shape (mentions +
 * recipients fields). Defaults to a broadcast from phil with no mentions
 * or recipients. Override per-test.
 *
 * @param {object} overrides
 * @returns {object} message
 */
function makeMessage(overrides = {}) {
  return {
    id: 'msg-test-1',
    ts: '2026-05-06T12:00:00.000Z',
    sender: { key: PHIL_KEY, name: 'phil', type: 'human' },
    body: 'hello',
    reply_to: null,
    mentions: null,
    recipients: null,
    conv: 'general',
    reactions: [],
    thread_count: 0,
    read_by: 0,
    ...overrides,
  };
}

/**
 * Render a MessageBubble with the given message + viewer. Returns the
 * usual @testing-library/svelte handle plus a `bubbleEl` shortcut for
 * the `.bubble` div (the element that should carry `.has-self-mention`
 * when any segment is `mention-self`).
 */
function renderBubble({ message, currentUser }) {
  const result = render(MessageBubble, {
    props: {
      message,
      currentUser,
      participants: PARTICIPANTS,
      consecutive: false,
      onOpenThread: () => {},
      onContextMenu: () => {},
      onShowProfile: () => {},
      onReact: () => {},
      onMore: () => {},
    },
  });
  const bubbleEl = result.container.querySelector('.bubble');
  return { ...result, bubbleEl };
}

afterEach(() => {
  cleanup();
});

// ── §10 Case 2 — Pure mention (recipients=null, mentions=[…]) ──────────

describe('MessageBubble — self vs other mention classification (§10 Case 2)', () => {
  test('test_mention_segment_renders_self_chip_for_viewer', () => {
    // Phil broadcasts "@ember check this" with mentions=[EMBER_KEY].
    // Viewer is ember → body-side `@ember` becomes `mention-self`.
    const message = makeMessage({
      body: '@ember check this',
      mentions: [EMBER_KEY],
    });
    const currentUser = { key: EMBER_KEY, name: 'ember', type: 'claude' };
    const { container } = renderBubble({ message, currentUser });

    const selfChip = container.querySelector('.mention-chip-self');
    expect(selfChip).not.toBeNull();
    expect(selfChip.textContent).toBe('@ember');
    // No other-chip should exist.
    expect(container.querySelector('.mention-chip-other')).toBeNull();
  });

  test('test_mention_segment_renders_other_chip_for_non_viewer', () => {
    // Same message; viewer is sage (not ember) → body-side `@ember`
    // becomes `mention-other`.
    const message = makeMessage({
      body: '@ember check this',
      mentions: [EMBER_KEY],
    });
    const currentUser = { key: SAGE_KEY, name: 'sage', type: 'claude' };
    const { container } = renderBubble({ message, currentUser });

    const otherChip = container.querySelector('.mention-chip-other');
    expect(otherChip).not.toBeNull();
    expect(otherChip.textContent).toBe('@ember');
    // No self-chip should exist.
    expect(container.querySelector('.mention-chip-self')).toBeNull();
  });

  test('test_self_mention_adds_has_self_mention_class_to_bubble', () => {
    // Self-mention triggers the `.has-self-mention` class on the bubble
    // root, which drives the 3px amber left-border accent (§6.3).
    const message = makeMessage({
      body: '@ember check this',
      mentions: [EMBER_KEY],
    });
    const currentUser = { key: EMBER_KEY, name: 'ember', type: 'claude' };
    const { bubbleEl } = renderBubble({ message, currentUser });

    expect(bubbleEl).not.toBeNull();
    expect(bubbleEl.classList.contains('has-self-mention')).toBe(true);
  });

  test('test_other_mention_does_not_add_self_mention_class', () => {
    // Mention exists, but viewer is NOT the mentioned participant.
    // No `.has-self-mention` on the bubble.
    const message = makeMessage({
      body: '@ember check this',
      mentions: [EMBER_KEY],
    });
    const currentUser = { key: SAGE_KEY, name: 'sage', type: 'claude' };
    const { bubbleEl } = renderBubble({ message, currentUser });

    expect(bubbleEl).not.toBeNull();
    expect(bubbleEl.classList.contains('has-self-mention')).toBe(false);
  });
});

// ── §10 Case 4 — Mention + whisper (both fields set) ───────────────────

describe('MessageBubble — whisper + mention overlap (§10 Case 4)', () => {
  test('test_whisper_with_mention_renders_legacy_chip_not_self_other', () => {
    // §10 Test #4 + §6.3 R2-C1: when `recipients` is non-empty, the
    // bubble is a whisper. Body-side `@name` renders as legacy `.mention`
    // chip — NOT loud self/other styling. Self/other is a mention-only
    // treatment per the locked spec.
    //
    // Note: the body in this case must already have the `[@ember] `
    // server prefix stripped by parseMentions (utils.js:74-103). The
    // post-strip body for the wire payload `[@ember] @ember check` is
    // `@ember check`.
    const message = makeMessage({
      body: '[@ember] @ember check',
      recipients: [EMBER_KEY],
      mentions: [EMBER_KEY],
    });
    const currentUser = { key: EMBER_KEY, name: 'ember', type: 'claude' };
    const { container, bubbleEl } = renderBubble({ message, currentUser });

    // Whisper bubble styling present.
    expect(bubbleEl.classList.contains('bubble-targeted')).toBe(true);

    // Body-side `@ember` renders as legacy `.mention` (NOT
    // `.mention-chip-self`).
    expect(container.querySelector('.mention-chip-self')).toBeNull();
    expect(container.querySelector('.mention-chip-other')).toBeNull();
    const legacyMention = container.querySelector('.mention');
    expect(legacyMention).not.toBeNull();
    expect(legacyMention.textContent).toBe('@ember');

    // No self-mention border accent on whispers.
    expect(bubbleEl.classList.contains('has-self-mention')).toBe(false);
  });
});

// ── §10 Case 5 — Multi-mention with mixed self + other ─────────────────

describe('MessageBubble — multi-mention classification (§10 Case 5)', () => {
  test('test_multi_mention_classifies_self_and_other_distinctly', () => {
    // Phil broadcasts "@ember and @sage check" with both keys in
    // mentions. Viewer is ember → @ember is self-chip, @sage is
    // other-chip.
    const message = makeMessage({
      body: '@ember and @sage check',
      mentions: [EMBER_KEY, SAGE_KEY],
    });
    const currentUser = { key: EMBER_KEY, name: 'ember', type: 'claude' };
    const { container, bubbleEl } = renderBubble({ message, currentUser });

    const selfChip = container.querySelector('.mention-chip-self');
    expect(selfChip).not.toBeNull();
    expect(selfChip.textContent).toBe('@ember');

    const otherChip = container.querySelector('.mention-chip-other');
    expect(otherChip).not.toBeNull();
    expect(otherChip.textContent).toBe('@sage');

    // At least one self-mention → bubble carries the accent class.
    expect(bubbleEl.classList.contains('has-self-mention')).toBe(true);
  });
});

// ── §10 Case 7a — Legacy whisper, prefix-only body, no chip ────────────

describe('MessageBubble — legacy whisper bodies (§10 Case 7a)', () => {
  test('test_legacy_whisper_prefix_only_no_chip_rendered', () => {
    // Pre-cutover message: `recipients=[ember]`, mentions absent
    // (Pydantic coerces to None). Body is the bracket prefix only.
    // parseMentions strips `[@ember] ` → post-strip body is `hi`. No
    // `@` token → no chip rendered. Whisper bubble styling present.
    const message = makeMessage({
      body: '[@ember] hi',
      recipients: [EMBER_KEY],
      mentions: null,
    });
    const currentUser = { key: EMBER_KEY, name: 'ember', type: 'claude' };
    const { container, bubbleEl } = renderBubble({ message, currentUser });

    // Whisper bubble styling.
    expect(bubbleEl.classList.contains('bubble-targeted')).toBe(true);

    // No mention chips at all (any flavor).
    expect(container.querySelector('.mention-chip-self')).toBeNull();
    expect(container.querySelector('.mention-chip-other')).toBeNull();
    expect(container.querySelector('.mention')).toBeNull();

    // No self-mention border on the bubble.
    expect(bubbleEl.classList.contains('has-self-mention')).toBe(false);
  });
});

// ── §10 Case 7b — Legacy whisper with body-side @name ──────────────────

describe('MessageBubble — legacy whisper with body @name (§10 Case 7b)', () => {
  test('test_legacy_whisper_with_body_at_name_renders_legacy_chip', () => {
    // Pre-cutover whisper with sender-typed `@ember` after the bracket
    // prefix. parseMentions strips `[@ember] ` → post-strip body is
    // `hi @ember`. The body-side `@ember` produces a mention segment.
    // Since `mentions=null`, the segment STAYS as legacy `mention`
    // (NOT mention-self) — backwards compat.
    const message = makeMessage({
      body: '[@ember] hi @ember',
      recipients: [EMBER_KEY],
      mentions: null,
    });
    const currentUser = { key: EMBER_KEY, name: 'ember', type: 'claude' };
    const { container, bubbleEl } = renderBubble({ message, currentUser });

    // Whisper bubble styling.
    expect(bubbleEl.classList.contains('bubble-targeted')).toBe(true);

    // Legacy `.mention` chip present, but NOT self/other variants.
    const legacyMention = container.querySelector('.mention');
    expect(legacyMention).not.toBeNull();
    expect(legacyMention.textContent).toBe('@ember');
    expect(container.querySelector('.mention-chip-self')).toBeNull();
    expect(container.querySelector('.mention-chip-other')).toBeNull();

    // No self-mention border on the bubble.
    expect(bubbleEl.classList.contains('has-self-mention')).toBe(false);
  });
});

// ── §10 Case 8 — Empty mentions list ───────────────────────────────────

describe('MessageBubble — empty mentions list (§10 Case 8)', () => {
  test('test_empty_mentions_array_treats_segments_as_legacy', () => {
    // mentions=[] (empty list) is treated identically to mentions=null:
    // body-side `@ember` → legacy `.mention` chip, NOT mention-self.
    const message = makeMessage({
      body: '@ember hi',
      mentions: [],
    });
    const currentUser = { key: EMBER_KEY, name: 'ember', type: 'claude' };
    const { container, bubbleEl } = renderBubble({ message, currentUser });

    const legacyMention = container.querySelector('.mention');
    expect(legacyMention).not.toBeNull();
    expect(legacyMention.textContent).toBe('@ember');
    expect(container.querySelector('.mention-chip-self')).toBeNull();
    expect(container.querySelector('.mention-chip-other')).toBeNull();
    expect(bubbleEl.classList.contains('has-self-mention')).toBe(false);
  });
});

// ── §10 Case 9 — Unknown key in mentions ───────────────────────────────

describe('MessageBubble — unknown-key mention (§10 Case 9)', () => {
  test('test_unknown_key_in_mentions_does_not_match_body_at_name', () => {
    // mentions contains a key that doesn't match anyone in participants.
    // parseMentions finds `@ember` in body; ember resolves to EMBER_KEY
    // via participants, but EMBER_KEY is NOT in mentions. Per §6.3 step
    // 3 last bullet: segment STAYS as legacy `mention`.
    const message = makeMessage({
      body: '@ember hi',
      mentions: ['deadbeef'],
    });
    const currentUser = { key: SAGE_KEY, name: 'sage', type: 'claude' };
    const { container, bubbleEl } = renderBubble({ message, currentUser });

    const legacyMention = container.querySelector('.mention');
    expect(legacyMention).not.toBeNull();
    expect(legacyMention.textContent).toBe('@ember');
    expect(container.querySelector('.mention-chip-self')).toBeNull();
    expect(container.querySelector('.mention-chip-other')).toBeNull();
    expect(bubbleEl.classList.contains('has-self-mention')).toBe(false);
  });
});

// ── §10 Case 10 — Sender-self special case ─────────────────────────────

describe('MessageBubble — sender-self special case (§10 Case 10)', () => {
  test('test_sender_self_mention_renders_as_legacy_on_own_bubble', () => {
    // Phil sends a message with mentions=[PHIL_KEY] (sender mentions
    // themselves; only reachable via legacy logs / external MCP since
    // the composer dedups sender-self at parse-time). Viewer is also
    // phil. The §6.3 step-4 sender-self special case downgrades the
    // would-be `mention-self` segment to legacy `mention`.
    const message = makeMessage({
      body: '@phil look at this',
      sender: { key: PHIL_KEY, name: 'phil', type: 'human' },
      mentions: [PHIL_KEY],
    });
    const currentUser = { key: PHIL_KEY, name: 'phil', type: 'human' };
    const { container, bubbleEl } = renderBubble({ message, currentUser });

    // Legacy chip rendered, NOT loud self-chip.
    const legacyMention = container.querySelector('.mention');
    expect(legacyMention).not.toBeNull();
    expect(legacyMention.textContent).toBe('@phil');
    expect(container.querySelector('.mention-chip-self')).toBeNull();
    expect(container.querySelector('.mention-chip-other')).toBeNull();

    // No self-mention border accent on your own bubble.
    expect(bubbleEl.classList.contains('has-self-mention')).toBe(false);
  });
});

// ── §10 Case 11b — Sender-key in mentions on someone else's bubble ────

describe('MessageBubble — sender-key in mentions, viewer is other (§10 Case 11b)', () => {
  test('test_mention_on_others_bubble_when_sender_is_listed', () => {
    // Phil sends "@phil and @ember" with mentions=[PHIL_KEY, EMBER_KEY]
    // (legacy/external-MCP path; server doesn't dedup sender from
    // mentions). Viewer is ember (not the sender).
    //   - Body-side `@phil`: key=PHIL_KEY, in mentions, viewer != phil
    //     → `mention-other`.
    //   - Body-side `@ember`: key=EMBER_KEY, in mentions, viewer ==
    //     ember → `mention-self`. Sender-self special case does NOT
    //     fire (viewer != sender).
    const message = makeMessage({
      body: '@phil and @ember',
      sender: { key: PHIL_KEY, name: 'phil', type: 'human' },
      mentions: [PHIL_KEY, EMBER_KEY],
    });
    const currentUser = { key: EMBER_KEY, name: 'ember', type: 'claude' };
    const { container, bubbleEl } = renderBubble({ message, currentUser });

    // Both chips present, distinguishable by class.
    const otherChip = container.querySelector('.mention-chip-other');
    expect(otherChip).not.toBeNull();
    expect(otherChip.textContent).toBe('@phil');

    const selfChip = container.querySelector('.mention-chip-self');
    expect(selfChip).not.toBeNull();
    expect(selfChip.textContent).toBe('@ember');

    // Bubble carries the accent class because at least one segment is
    // mention-self.
    expect(bubbleEl.classList.contains('has-self-mention')).toBe(true);
  });
});

// ── Defensive tests beyond the §10 matrix ──────────────────────────────

describe('MessageBubble — defensive coverage', () => {
  test('test_no_mentions_field_renders_legacy_for_body_at_name', () => {
    // mentions=undefined (Pydantic absent-field, before any wire
    // re-emit) is treated identically to null/empty: body-side `@ember`
    // renders as legacy `.mention` chip, never self/other.
    const message = makeMessage({
      body: '@ember hi',
    });
    // Force the field to be missing rather than null, to mirror an
    // older payload shape that didn't include the mentions key at all.
    delete message.mentions;
    const currentUser = { key: EMBER_KEY, name: 'ember', type: 'claude' };
    const { container, bubbleEl } = renderBubble({ message, currentUser });

    const legacyMention = container.querySelector('.mention');
    expect(legacyMention).not.toBeNull();
    expect(legacyMention.textContent).toBe('@ember');
    expect(container.querySelector('.mention-chip-self')).toBeNull();
    expect(container.querySelector('.mention-chip-other')).toBeNull();
    expect(bubbleEl.classList.contains('has-self-mention')).toBe(false);
  });

  test('test_message_without_at_in_body_no_mention_segments', () => {
    // Plain text body, no `@` tokens → no chips at all (any flavor),
    // and no `.has-self-mention` accent.
    const message = makeMessage({
      body: 'just a regular message with no mentions',
      mentions: [EMBER_KEY],
    });
    const currentUser = { key: EMBER_KEY, name: 'ember', type: 'claude' };
    const { container, bubbleEl } = renderBubble({ message, currentUser });

    expect(container.querySelector('.mention-chip-self')).toBeNull();
    expect(container.querySelector('.mention-chip-other')).toBeNull();
    expect(container.querySelector('.mention')).toBeNull();
    expect(bubbleEl.classList.contains('has-self-mention')).toBe(false);
  });

  test('test_self_mention_in_code_block_not_classified', () => {
    // `@ember` inside backticks must render as code (`.code-chip`),
    // never as a mention chip. This locks the existing rich-text
    // parser ordering: code tokens are extracted BEFORE mention
    // splitting (parseBody step 1 in MessageBubble.svelte).
    const message = makeMessage({
      body: 'see `@ember` for the syntax',
      mentions: [EMBER_KEY],
    });
    const currentUser = { key: EMBER_KEY, name: 'ember', type: 'claude' };
    const { container, bubbleEl } = renderBubble({ message, currentUser });

    // Inline-code chip present with the literal `@ember` text.
    const codeChip = container.querySelector('.code-chip');
    expect(codeChip).not.toBeNull();
    expect(codeChip.textContent).toBe('@ember');

    // No mention chip of any flavor for the in-code `@ember`.
    expect(container.querySelector('.mention-chip-self')).toBeNull();
    expect(container.querySelector('.mention-chip-other')).toBeNull();
    expect(container.querySelector('.mention')).toBeNull();

    // No self-mention border accent — the in-code token doesn't count.
    expect(bubbleEl.classList.contains('has-self-mention')).toBe(false);
  });
});
