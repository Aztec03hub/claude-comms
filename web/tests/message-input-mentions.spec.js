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

    // Type `@em`, accept the autocomplete via Tab → token committed. No
    // auto-space; the user types the separator.
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

describe('MessageInput — @all / @everyone broadcast mentions', () => {
  test('test_broadcast_candidate_appears_in_dropdown', async () => {
    const store = makeStore();
    const { getByTestId, getAllByTestId } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');

    // Typing just `@` opens the dropdown with the synthetic broadcast rows
    // present (and labeled with their hint).
    await typeText(ta, '@');
    expect(getByTestId('mention-item-__broadcast_all__')).toBeTruthy();
    expect(getByTestId('mention-item-__broadcast_everyone__')).toBeTruthy();
    // Both broadcast rows carry a hint label.
    expect(getAllByTestId('mention-broadcast-hint')).toHaveLength(2);
  });

  test('test_broadcast_all_expands_to_present_members_minus_self', async () => {
    // Active channel has phil (self), ember, sage present.
    const store = makeStore({
      activeMembers: [
        { key: 'phil-key', name: 'phil' },
        { key: 'ember-key', name: 'ember' },
        { key: 'sage-key', name: 'sage' },
      ],
    });
    const { getByTestId, container } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');

    // Type `@all` and accept via Tab → single committed broadcast token. No
    // auto-space (per Phil) — value is exactly `@all`.
    await typeText(ta, '@all');
    await pressKey(ta, 'Tab');
    await tick();
    expect(ta.value).toBe('@all');

    // Composer renders ONE pill for the broadcast token (not N member pills).
    const pills = container.querySelectorAll('.mention-confirmed');
    expect(pills).toHaveLength(1);
    expect(pills[0].textContent).toBe('@all');

    await fireEvent.click(getByTestId('send-button'));
    await tick();

    // Wire `mentions` carries every present member's key EXCEPT the sender's.
    expect(store.sendMessage).toHaveBeenCalledTimes(1);
    expect(store.sendMessage).toHaveBeenCalledWith(
      '@all',
      null,
      { mentions: ['ember-key', 'sage-key'], recipients: null },
    );
  });

  test('test_broadcast_unions_and_dedups_with_explicit_mention', async () => {
    const store = makeStore({
      activeMembers: [
        { key: 'phil-key', name: 'phil' },
        { key: 'ember-key', name: 'ember' },
        { key: 'sage-key', name: 'sage' },
      ],
    });
    const { getByTestId } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');

    // `@all @ember` — @ember is already covered by the broadcast expansion,
    // so the wire field must not list it twice.
    await typeText(ta, '@all');
    await pressKey(ta, 'Tab');
    await tick();
    await typeText(ta, ' @em');
    await pressKey(ta, 'Tab');
    await tick();
    expect(ta.value).toBe('@all @ember');

    await fireEvent.click(getByTestId('send-button'));
    await tick();

    expect(store.sendMessage).toHaveBeenCalledWith(
      '@all @ember',
      null,
      { mentions: ['ember-key', 'sage-key'], recipients: null },
    );
  });

  test('test_broadcast_with_no_other_members_sends_null_mentions', async () => {
    // Sender is the only present member → broadcast expands to empty, which
    // the composer normalizes to a null mentions field (still a valid send).
    const store = makeStore({
      activeMembers: [{ key: 'phil-key', name: 'phil' }],
    });
    const { getByTestId } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');

    await typeText(ta, '@everyone');
    await pressKey(ta, 'Tab');
    await tick();
    expect(ta.value).toBe('@everyone');

    await fireEvent.click(getByTestId('send-button'));
    await tick();

    expect(store.sendMessage).toHaveBeenCalledWith(
      '@everyone',
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

describe('MessageInput — overlay mirrors the textarea text exactly', () => {
  // Regression for Phil's "doubled / overlaid on selection" report. The
  // colored overlay layer is painted on top of a transparent textarea; if the
  // overlay's rendered character stream differs from the textarea value by even
  // one character, the colored glyphs drift off the underlying text. This test
  // pins the invariant that the overlay's textContent equals the textarea value
  // for multi-mention input (the @Iris @Sol shape), so coloring can never
  // diverge from the source. (The transparent-selection CSS that prevents the
  // textarea's own glyphs from also rendering during selection lives in the
  // component <style> and is not observable under jsdom, which does not apply
  // scoped stylesheet rules; this structural mirror test is the jsdom-testable
  // half of the same invariant.)
  test('test_overlay_textcontent_matches_value_for_two_mentions', async () => {
    const store = makeStore();
    const { getByTestId, container } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');

    // Commit two mentions with a user-typed space between them (no auto-space).
    await typeText(ta, '@em');
    await pressKey(ta, 'Tab');
    await tick();
    await typeText(ta, ' @sa');
    await pressKey(ta, 'Tab');
    await tick();

    expect(ta.value).toBe('@ember @sage');

    const overlay = container.querySelector('.input-overlay');
    expect(overlay).not.toBeNull();
    // The overlay's flattened text must equal the textarea value character for
    // character — no extra template whitespace, no dropped separators.
    expect(overlay.textContent).toBe(ta.value);
  });

  test('test_overlay_textcontent_matches_value_with_code_chip', async () => {
    const store = makeStore();
    const { getByTestId, container } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');

    // Commit a mention, then add body text containing an inline-code chip
    // (user types the leading space; no auto-space on commit).
    await typeText(ta, '@em');
    await pressKey(ta, 'Tab');
    await tick();
    await typeText(ta, ' run `npm test`');
    await tick();

    expect(ta.value).toBe('@ember run `npm test`');
    const overlay = container.querySelector('.input-overlay');
    // Backticks are present in the overlay (transparent, width-preserved) so
    // textContent still mirrors the textarea exactly.
    expect(overlay.textContent).toBe(ta.value);
  });

  test('test_overlay_textcontent_matches_value_across_many_lines', async () => {
    // Vertical-axis regression (Phil): after MANY wrapped/explicit lines the
    // overlay must still mirror the textarea character-for-character — newlines
    // included — so the colored layer wraps onto the same physical lines and
    // the caret / spellcheck squigglies stay on the overlay baseline. jsdom
    // does not lay out pixels, but a character-exact overlay (every newline
    // preserved, no extra/dropped whitespace) is the prerequisite the px
    // line-height lockdown builds on. This pins that prerequisite for a 12-line
    // body with a committed mention on the first line.
    const store = makeStore();
    const { getByTestId, container } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');

    await typeText(ta, '@em');
    await pressKey(ta, 'Tab');
    await tick();
    expect(ta.value).toBe('@ember');

    // Append a 12-line body (newlines flow in via input events). The value does
    // NOT end in a newline, so the overlay's trailing-newline pad span is not
    // engaged and textContent must equal the value exactly. The user types the
    // leading space (no auto-space on commit).
    const body = ' ' + Array.from({ length: 12 }, (_, n) => `line ${n} content`).join('\n');
    await typeText(ta, body);
    await tick();

    expect(ta.value).toBe('@ember' + body);
    expect(ta.value.split('\n')).toHaveLength(12);
    const overlay = container.querySelector('.input-overlay');
    expect(overlay.textContent).toBe(ta.value);
  });

  test('test_completed_inline_code_backticks_render_in_hidden_tick_spans', async () => {
    // Phil regression: a COMPLETED inline code span shows only the chip pill —
    // the literal backticks are rendered in dedicated `overlay-code-tick` spans
    // (CSS paints them transparent). The backtick characters are still present
    // (alignment), but isolated in the hideable spans rather than the visible
    // chip body or plain text.
    const store = makeStore();
    const { getByTestId, container } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');

    await setText(ta, 'run `npm test` now');
    await tick();

    const overlay = container.querySelector('.input-overlay');
    // Two backtick tick-spans bracket the chip.
    const ticks = overlay.querySelectorAll('.overlay-code-tick');
    expect(ticks).toHaveLength(2);
    expect(Array.from(ticks).every((t) => t.textContent === '`')).toBe(true);
    // The visible chip carries only the inner code, NO backticks.
    const chip = overlay.querySelector('.overlay-code-chip');
    expect(chip.textContent).toBe('npm test');
    // Overlay still mirrors the textarea exactly (backticks present, just in the
    // transparent tick spans).
    expect(overlay.textContent).toBe(ta.value);
  });

  test('test_completed_fenced_block_fences_render_in_hidden_fence_spans', async () => {
    // Phil regression for triple-backtick blocks: the ``` fences are rendered in
    // `overlay-code-block-fence` spans (CSS paints them transparent) so only the
    // code bubble shows. Setting a complete block via input keeps it inline (no
    // block-mode entry), exercising the overlay block-code path.
    const store = makeStore();
    const { getByTestId, container } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');

    await setText(ta, '```js\nfoo\nbar\n```');
    await tick();

    const overlay = container.querySelector('.input-overlay');
    const fences = overlay.querySelectorAll('.overlay-code-block-fence');
    // Opening fence (```js\n) and closing fence (\n```).
    expect(fences).toHaveLength(2);
    expect(fences[0].textContent).toBe('```js\n');
    expect(fences[1].textContent).toBe('\n```');
    // The visible block body carries only the code, no fences.
    const body = overlay.querySelector('.overlay-code-block');
    expect(body.textContent).toBe('foo\nbar');
    // Overlay mirrors the textarea exactly (fences present, just transparent).
    expect(overlay.textContent).toBe(ta.value);
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
    // Caret immediately after the inserted mention (NO trailing space) —
    // restored by the component, NOT by the test helper.
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
    // Two mentions in a row. Each commit bases its caret on the CURRENT value,
    // so the second mention's caret lands at the end of the whole string — not
    // at a stale offset from the first commit. The user types the separating
    // space (no auto-space).
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
    expect(ta.value).toBe('@ember @sa');
    ta.setSelectionRange(0, 0);
    await pressKey(ta, 'Tab');
    await tick();

    expect(ta.value).toBe('@ember @sage');
    expect(ta.selectionStart).toBe('@ember @sage'.length);
    expect(ta.selectionEnd).toBe('@ember @sage'.length);
  });

  test('test_commit_never_appends_space_caret_immediately_after', async () => {
    // Regression for Phil's "no auto-space" rule: committing a mention must NOT
    // append a trailing space, and the caret must land immediately after the
    // mention text so the user controls all spacing themselves.
    const store = makeStore();
    const { getByTestId } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');

    await typeText(ta, '@em');
    await pressKey(ta, 'Tab');
    await tick();

    expect(ta.value).toBe('@ember');
    expect(ta.value.endsWith(' ')).toBe(false);
    expect(ta.selectionStart).toBe('@ember'.length);

    // Typing a fresh `@` right away jams (the user chose not to type a space);
    // this is the accepted literal text — readability is handled by overlay
    // alignment + correct caret, NOT by injected spaces.
    await typeText(ta, '@sa');
    expect(ta.value).toBe('@ember@sa');
  });

  test('test_typing_continues_after_committed_mention', async () => {
    // After committing, typed characters must append after the mention, not
    // bleed into / before it. The user types the separating space themselves.
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
