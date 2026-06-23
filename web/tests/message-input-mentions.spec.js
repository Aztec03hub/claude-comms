// Component tests for MessageInput.svelte focused on the
// mentions-vs-whisper wire-field separation per
// plans/mentions-vs-whisper-separation.md §6.2 + §11 Phase C.
//
// Coverage
// ────────
//   1. Autocomplete-committed @mentions populate the `mentions` wire field
//      (NOT `recipients`). Driven by `tokensToMentions(tokens)`.
//   2. No autocomplete → both wire fields are null/empty (broadcast).
//   3. `/dm @user body` slash-command path populates `recipients` (NOT
//      `mentions`). Body has the parser-injected `@name` prefix.
//   4. Invalid `/dm` rejected at parse-time: composer surfaces an inline
//      error, store.sendMessage NOT called.
//   5. Sender-self autocomplete edge case: filterCandidates excludes self,
//      but if a sender-key somehow lands in mentionTokens, parse-time dedup
//      drops it.
//   6. composerPrefill (§6.2-B fix) — `store.composerPrefill = '/dm @ember '`
//      pre-fills the textarea, positions cursor, focuses, and resets the
//      store flag.
//
// New wire-format invariants (§5 + §6.4): `store.sendMessage(body, replyTo,
// { mentions, recipients })` — third positional arg is now an options
// object, not a recipients array.

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

import MessageInput from '../src/components/MessageInput.svelte';

// ── Fixtures ───────────────────────────────────────────────────────────

const PARTICIPANTS = {
  'phil-key': {
    key: 'phil-key',
    name: 'phil',
    type: 'human',
    connections: { 'web-1': {} },
  },
  'ember-key': {
    key: 'ember-key',
    name: 'ember',
    type: 'claude',
    connections: { 'mcp-1': {} },
  },
  'sage-key': {
    key: 'sage-key',
    name: 'sage',
    type: 'claude',
    connections: {}, // offline
  },
  'notanyone-decoy-key': {
    // Intentionally unrelated participant so `notanyone` resolves to nothing.
    key: 'notanyone-decoy-key',
    name: 'bob',
    type: 'human',
    connections: {},
  },
};

/**
 * Build a fresh store stub. Includes the new `composerPrefill` field
 * (§6.2-B fix): a $state-equivalent slot the composer reads via $effect
 * and clears after consumption.
 */
function makeStore(overrides = {}) {
  const sendMessage = vi.fn();
  const notifyTyping = vi.fn();
  return {
    participants: PARTICIPANTS,
    userProfile: { key: 'phil-key', name: 'phil', type: 'human' },
    composerPrefill: null,
    sendMessage,
    notifyTyping,
    ...overrides,
  };
}

// ── Helpers (mirror mention-input.spec.js) ─────────────────────────────

async function typeText(ta, text) {
  for (const ch of text) {
    const newValue = ta.value + ch;
    ta.value = newValue;
    ta.setSelectionRange(newValue.length, newValue.length);
    await fireEvent.input(ta, { target: ta });
    await tick();
  }
}

async function pressKey(ta, key, opts = {}) {
  const ev = await fireEvent.keyDown(ta, { key, ...opts });
  await tick();
  return ev;
}

/**
 * Set the textarea value wholesale (bypassing per-char input events).
 * Used for `/dm` paths where we don't care about per-keystroke
 * autocomplete state — only the final submit behavior.
 */
async function setText(ta, text) {
  ta.value = text;
  ta.setSelectionRange(text.length, text.length);
  await fireEvent.input(ta, { target: ta });
  await tick();
}

afterEach(() => {
  cleanup();
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('MessageInput — autocomplete commits populate mentions wire field', () => {
  test('test_autocomplete_commit_populates_mentions_field', async () => {
    const store = makeStore();
    const { getByTestId } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');

    // Type `@em`, accept the autocomplete via Tab → token committed.
    await typeText(ta, '@em');
    await pressKey(ta, 'Tab');
    expect(ta.value).toBe('@ember');

    // Add body text after the mention.
    await typeText(ta, ' hi');
    expect(ta.value).toBe('@ember hi');

    // Submit.
    await fireEvent.click(getByTestId('send-button'));
    await tick();

    expect(store.sendMessage).toHaveBeenCalledTimes(1);
    // §6.4: third positional arg is options object `{ mentions, recipients }`.
    // §6.2-A: autocomplete-committed mentions populate `mentions`, NOT
    // `recipients`. `recipients` is null for the broadcast-with-highlight path.
    expect(store.sendMessage).toHaveBeenCalledWith(
      '@ember hi',
      null,
      { mentions: ['ember-key'], recipients: null },
    );
  });

  test('test_no_autocomplete_no_mentions', async () => {
    const store = makeStore();
    const { getByTestId } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');

    // Plain text, no `@` trigger.
    await typeText(ta, 'hello world');
    await fireEvent.click(getByTestId('send-button'));
    await tick();

    expect(store.sendMessage).toHaveBeenCalledTimes(1);
    // Both fields null → broadcast.
    expect(store.sendMessage).toHaveBeenCalledWith(
      'hello world',
      null,
      { mentions: null, recipients: null },
    );
  });
});

describe('MessageInput — `/dm` slash-command routes through parser', () => {
  test('test_dm_path_populates_recipients_not_mentions', async () => {
    const store = makeStore();
    const { getByTestId } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');

    // `/dm` slash command — recipients=[ember-key], body has parser-injected
    // `@ember` prefix per §6.2-A bullet 7.
    await setText(ta, '/dm @ember hi');
    await fireEvent.click(getByTestId('send-button'));
    await tick();

    expect(store.sendMessage).toHaveBeenCalledTimes(1);
    expect(store.sendMessage).toHaveBeenCalledWith(
      '@ember hi',
      null,
      { mentions: null, recipients: ['ember-key'] },
    );
  });

  test('test_invalid_dm_shows_error_no_send', async () => {
    const store = makeStore();
    const { getByTestId, container } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');

    // `@notanyone` is not in participants → parser rejects with inline error.
    await setText(ta, '/dm @notanyone hi');
    await fireEvent.click(getByTestId('send-button'));
    await tick();

    // Send NOT called — error surfaced inline.
    expect(store.sendMessage).not.toHaveBeenCalled();

    // Composer shows an error somewhere in the DOM. The test is intentionally
    // permissive about the exact element — phoenix may use a `composer-error`
    // testid, an aria-live region, or a styled span. We assert that the
    // string `notanyone` appears somewhere in the rendered output as a
    // user-visible error signal.
    const html = container.innerHTML;
    expect(html.toLowerCase()).toContain('notanyone');
  });

  test('test_sender_self_mention_dropped_at_parse_time', async () => {
    // `filterCandidates` already excludes self from the autocomplete dropdown,
    // so the user can't normally autocomplete-commit themselves. We probe
    // the dedup discipline (§6.2-A bullet 9) by typing `@phil` literally and
    // submitting — no token commit happens (filterCandidates returns nothing
    // for self), so mentionTokens is empty and the wire field is null. This
    // pins the invariant: even if the user types their own name, the
    // mentions wire field never carries the sender's own key.
    const store = makeStore();
    const { getByTestId } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');

    await typeText(ta, '@phil hi');
    // No autocomplete commit possible — phil is filtered out as self.
    await fireEvent.click(getByTestId('send-button'));
    await tick();

    expect(store.sendMessage).toHaveBeenCalledTimes(1);
    expect(store.sendMessage).toHaveBeenCalledWith(
      '@phil hi',
      null,
      { mentions: null, recipients: null },
    );
  });
});

describe('MessageInput — composerPrefill (profile-card prefill mechanism)', () => {
  test('test_profile_card_prefill_via_composerPrefill', async () => {
    // Per R2-C3 fix in §6.2-B: ProfileCard sets store.composerPrefill;
    // MessageInput watches it via $effect, populates inputValue, focuses
    // and positions cursor at end, then clears the store flag.
    //
    // Because we can't easily trigger Svelte 5 $effect from a plain object
    // mutation in jsdom (the store stub isn't a $state), this test renders
    // the component with the prefill already set on the store and asserts
    // the composer picks it up on mount.
    const store = makeStore({ composerPrefill: '/dm @ember ' });
    const { getByTestId } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');
    await tick();

    // The textarea value should be the prefill string (trailing space
    // preserved so the user can immediately start typing the body).
    expect(ta.value).toBe('/dm @ember ');

    // Cursor is at the end of the prefill (after the trailing space).
    expect(ta.selectionStart).toBe('/dm @ember '.length);
    expect(ta.selectionEnd).toBe('/dm @ember '.length);

    // Textarea is focused so the user can type immediately.
    expect(document.activeElement).toBe(ta);

    // composerPrefill is reset to null after consumption.
    expect(store.composerPrefill).toBeNull();
  });
});

describe('MessageInput — caret lands after a committed mention', () => {
  // Regression for the composer caret bug: after an autocomplete commit the
  // caret must sit immediately AFTER the inserted @mention so the next typed
  // characters continue from there. Previously the caret restore used a bare
  // queueMicrotask, which is not guaranteed to run after Svelte flushes the
  // bound value into the textarea — so the grown value could reset the caret
  // and subsequent text landed at the wrong offset (worse with more mentions).
  //
  // To keep these tests honest (jsdom can't reproduce the real-browser flush
  // ordering, and our typeText helper sets the caret itself), each test
  // CLOBBERS the textarea caret to a deliberately-wrong offset immediately
  // before the commit fires. After the commit the ONLY code path that can
  // move the caret to the correct end-of-mention offset is the component's
  // own `await tick(); inputEl.setSelectionRange(...)` restore. If that
  // restore regresses (or runs before the value flush), the caret stays at
  // the clobbered offset and the assertion fails.

  test('test_caret_after_single_mention_commit_tab', async () => {
    const store = makeStore();
    const { getByTestId } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');

    await typeText(ta, '@em');
    // Clobber: pretend the caret got knocked to the start.
    ta.setSelectionRange(0, 0);
    await pressKey(ta, 'Tab');
    await tick();

    expect(ta.value).toBe('@ember');
    // Caret immediately after the inserted mention text — restored by the
    // component, NOT by the test helper.
    expect(ta.selectionStart).toBe('@ember'.length);
    expect(ta.selectionEnd).toBe('@ember'.length);
  });

  test('test_caret_after_single_mention_commit_dropdown_mousedown', async () => {
    // The dropdown commits on mousedown (keeps the textarea focused). The
    // caret must still resolve to the end of the inserted mention.
    const store = makeStore();
    const { getByTestId } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');

    await typeText(ta, '@em');
    await tick();
    ta.setSelectionRange(0, 0); // clobber before commit
    const option = getByTestId('mention-item-ember-key');
    await fireEvent.mouseDown(option);
    await tick();

    expect(ta.value).toBe('@ember');
    expect(ta.selectionStart).toBe('@ember'.length);
    expect(ta.selectionEnd).toBe('@ember'.length);
  });

  test('test_caret_after_mention_commit_with_trailing_text', async () => {
    // Mention committed in the MIDDLE of the line (text already after the
    // query). Here end-of-string !== newCursor, so the commit offset math is
    // load-bearing: the caret must land just after the inserted @mention, not
    // at the end of the whole line.
    const store = makeStore();
    const { getByTestId } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');

    // Build "hi @em there" with the caret sitting right after "@em".
    ta.value = 'hi @em there';
    ta.setSelectionRange('hi @em'.length, 'hi @em'.length);
    await fireEvent.input(ta, { target: ta });
    await tick();

    ta.setSelectionRange(0, 0); // clobber before commit
    await pressKey(ta, 'Tab');
    await tick();

    expect(ta.value).toBe('hi @ember there');
    // Caret just after the inserted mention, BEFORE " there".
    expect(ta.selectionStart).toBe('hi @ember'.length);
    expect(ta.selectionEnd).toBe('hi @ember'.length);
  });

  test('test_caret_after_double_mention_commit', async () => {
    // Two mentions in a row. Each commit must base its caret on the CURRENT
    // value, so the second mention's caret lands at the end of the whole
    // string — not at a stale offset from the first commit.
    const store = makeStore();
    const { getByTestId } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');

    await typeText(ta, '@em');
    ta.setSelectionRange(0, 0);
    await pressKey(ta, 'Tab');
    await tick();
    expect(ta.value).toBe('@ember');
    expect(ta.selectionStart).toBe('@ember'.length);

    // Type a separator + the second mention prefix, then commit it.
    await typeText(ta, ' @sa');
    ta.setSelectionRange(0, 0);
    await pressKey(ta, 'Tab');
    await tick();

    expect(ta.value).toBe('@ember @sage');
    expect(ta.selectionStart).toBe('@ember @sage'.length);
    expect(ta.selectionEnd).toBe('@ember @sage'.length);
  });

  test('test_typing_continues_after_committed_mention', async () => {
    // After committing, typed characters must append after the mention, not
    // bleed into / before it.
    const store = makeStore();
    const { getByTestId } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');

    await typeText(ta, '@em');
    await pressKey(ta, 'Tab');
    await tick();
    await typeText(ta, ' hello');

    expect(ta.value).toBe('@ember hello');
    expect(ta.selectionStart).toBe('@ember hello'.length);
  });
});
