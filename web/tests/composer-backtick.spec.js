// Composer-state tests for MessageInput.svelte focused on the backtick
// rendering pipeline (compose-overlay-segments + parser-driven overlay)
// and Phil's §5.4 inline chip caret/backspace semantics.
//
// Per backtick-highlighting-plan v2 §9: composer-state vitest is phoenix's
// surface (lives next to the code). Parser unit tests live in
// rich-text-parser.spec.js (sage's lane).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

import MessageInput from '../src/components/MessageInput.svelte';

const PARTICIPANTS = {
  'phil-key': {
    key: 'phil-key',
    name: 'phil',
    type: 'human',
    connections: { 'web-1': {} },
  },
};

function makeStore() {
  return {
    participants: PARTICIPANTS,
    userProfile: { key: 'phil-key', name: 'phil', type: 'human' },
    sendMessage: vi.fn(),
    notifyTyping: vi.fn(),
  };
}

/**
 * Fast-path setter: assign value + selection in one go and dispatch input.
 * The component reparses on every input event.
 */
async function setValue(ta, value, caret = value.length) {
  ta.value = value;
  ta.setSelectionRange(caret, caret);
  await fireEvent.input(ta, { target: ta });
  await tick();
}

function getOverlay(container) {
  return container.querySelector('.input-overlay');
}

beforeEach(() => {
  // jsdom doesn't implement scrollHeight/clientHeight beyond static 0, so
  // the autoResize/ensureCaretVisible code paths are exercised but no-op.
  // That's fine — these tests focus on the overlay+caret semantics.
});

afterEach(() => {
  cleanup();
});

describe('MessageInput backtick overlay', () => {
  it('renders inline-code chip on closing backtick', async () => {
    const store = makeStore();
    const { container } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = container.querySelector('textarea');
    expect(ta).toBeTruthy();

    await setValue(ta, '`x`');
    const overlay = getOverlay(container);
    expect(overlay).toBeTruthy();

    // Should have an overlay-code-chip span with text 'x' and two
    // overlay-code-tick spans with text '`' each.
    const chip = overlay.querySelector('.overlay-code-chip');
    expect(chip).toBeTruthy();
    expect(chip.textContent).toBe('x');

    const ticks = overlay.querySelectorAll('.overlay-code-tick');
    expect(ticks).toHaveLength(2);
    for (const t of ticks) expect(t.textContent).toBe('`');
  });

  it('does NOT render chip for empty backtick pair', async () => {
    const store = makeStore();
    const { container } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = container.querySelector('textarea');

    await setValue(ta, '``');
    const overlay = getOverlay(container);
    expect(overlay.querySelector('.overlay-code-chip')).toBeNull();
  });

  it('renders block-code span when triple-tick fence opens at line start', async () => {
    const store = makeStore();
    const { container } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = container.querySelector('textarea');

    await setValue(ta, '```\nfoo\n```');
    const overlay = getOverlay(container);
    const block = overlay.querySelector('.overlay-code-block');
    expect(block).toBeTruthy();
    // The block span contains the entire raw range including fences.
    expect(block.textContent).toContain('foo');
  });

  it('does NOT render block-code when triple-tick is mid-line', async () => {
    const store = makeStore();
    const { container } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = container.querySelector('textarea');

    await setValue(ta, 'hello ```code```');
    const overlay = getOverlay(container);
    expect(overlay.querySelector('.overlay-code-block')).toBeNull();
  });

  it('caret cannot rest at chip-interior-position-1 (snaps to chip start)', async () => {
    const store = makeStore();
    const { container } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = container.querySelector('textarea');

    await setValue(ta, 'a`xy`b');
    // Place caret at chip-interior-position-1 (between opening tick and 'x').
    // The chip is at offsets [1, 5); chip.start = 1 (the opening tick).
    // chip-interior-position-1 = chip.start + 1 = 2.
    ta.setSelectionRange(2, 2);
    await fireEvent.click(ta);
    await tick();

    // Component should snap caret left to chip.start = 1.
    expect(ta.selectionStart).toBe(1);
    expect(ta.selectionEnd).toBe(1);
  });

  it('Backspace from chip-interior-position-2 deletes first interior char and jumps to chip start', async () => {
    const store = makeStore();
    const { container } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = container.querySelector('textarea');

    await setValue(ta, 'a`xy`b');
    // Place caret at chip-interior-position-2 = chip.start + 2 = 3.
    ta.setSelectionRange(3, 3);
    await fireEvent.click(ta);
    await tick();

    // Press Backspace.
    await fireEvent.keyDown(ta, { key: 'Backspace' });
    await tick();
    // microtask: setSelectionRange runs in queueMicrotask; flush it
    await Promise.resolve();
    await tick();

    // Expected: 'x' is deleted, value becomes 'a`y`b', caret at 1.
    expect(ta.value).toBe('a`y`b');
    expect(ta.selectionStart).toBe(1);
  });

  it('block-code span includes the lang tag in raw output (rendered in overlay)', async () => {
    const store = makeStore();
    const { container } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = container.querySelector('textarea');

    await setValue(ta, '```python\nx = 1\n```');
    const overlay = getOverlay(container);
    const block = overlay.querySelector('.overlay-code-block');
    expect(block).toBeTruthy();
    expect(block.textContent).toContain('python');
    expect(block.textContent).toContain('x = 1');
  });

  it('multiple inline chips on one line each render as separate chips', async () => {
    const store = makeStore();
    const { container } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = container.querySelector('textarea');

    await setValue(ta, 'use `--flag` with `--other`');
    const overlay = getOverlay(container);
    const chips = overlay.querySelectorAll('.overlay-code-chip');
    expect(chips).toHaveLength(2);
    expect(chips[0].textContent).toBe('--flag');
    expect(chips[1].textContent).toBe('--other');
  });

  it('plain text (no backticks) renders without any code spans', async () => {
    const store = makeStore();
    const { container } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = container.querySelector('textarea');

    await setValue(ta, 'just some normal text');
    const overlay = getOverlay(container);
    expect(overlay.querySelector('.overlay-code-chip')).toBeNull();
    expect(overlay.querySelector('.overlay-code-block')).toBeNull();
    expect(overlay.querySelector('.overlay-code-tick')).toBeNull();
  });

  // DELETED: "TEXTAREA_MAX_HEIGHT alignment" test (only asserted expect(ta).toBeTruthy(),
  // which is guaranteed by every other test in the file). The 180px px-level contract
  // cannot be verified in jsdom (no layout engine) — it lives in the Playwright e2e suite.
});

// ── v2 (plan §5.1 / §5.1.1 / §5.4) ────────────────────────────────────
//
// Block-entry mode tests. Covers Trigger B (early-trigger gesture), Esc
// semantics, close-fence-typed-in-block, backspace at row 0 col 0,
// preventDefault behavior on the trigger keystrokes, and edge-cases that
// MUST NOT trigger (mid-line fence, plain Enter, extra chars on fence
// line). Trigger A (parser sees complete block) is exercised indirectly
// through the existing v1 block-overlay tests above.

describe('MessageInput backtick block-entry (v2)', () => {
  function setup() {
    const store = makeStore();
    const { container } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = container.querySelector('textarea[data-testid="message-input"]');
    return { store, container, ta };
  }

  function getBlockTextarea(container) {
    return container.querySelector('[data-testid="block-textarea"]');
  }

  it('Trigger B: ``` at line start + Shift+Enter strips fence, opens block textarea, no newline inserted', async () => {
    const { container, ta } = setup();
    await setValue(ta, '```');
    expect(getBlockTextarea(container)).toBeNull(); // not yet
    await fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    await tick();
    await Promise.resolve();
    await tick();

    // Inline source should have the fence stripped.
    expect(ta.value).toBe('');
    // Block textarea should be mounted.
    const block = getBlockTextarea(container);
    expect(block).toBeTruthy();
    expect(block.value).toBe('');
  });

  it('Trigger B: ```python at line start + Space strips fence, captures lang tag, opens block', async () => {
    const { container, ta } = setup();
    await setValue(ta, '```python');
    await fireEvent.keyDown(ta, { key: ' ' });
    await tick();
    await Promise.resolve();
    await tick();

    expect(ta.value).toBe('');
    const block = getBlockTextarea(container);
    expect(block).toBeTruthy();
    const langLabel = container.querySelector('[data-testid="block-textarea-lang"]');
    expect(langLabel).toBeTruthy();
    expect(langLabel.textContent).toBe('python');
  });

  it('Trigger B: plain Enter (no shift) on ``` line does NOT trigger gesture (sends instead)', async () => {
    const { store, container, ta } = setup();
    await setValue(ta, '```');
    await fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false });
    await tick();

    // Should NOT have entered block mode.
    expect(getBlockTextarea(container)).toBeNull();
    // sendMessage should have been called with '```' (or rather not called
    // because the 1-char-trim-test would let it through, but check it's
    // NOT block mode).
    expect(store.sendMessage).toHaveBeenCalled();
  });

  it('Trigger B: extra chars on fence line (``` foo bar) does NOT trigger', async () => {
    const { container, ta } = setup();
    await setValue(ta, '``` foo bar');
    await fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    await tick();

    // No block mode; default Shift+Enter newline behavior would have inserted
    // a newline (we don't preventDefault when det is null). Inline source
    // unchanged for this test purpose — what matters is no block mode.
    expect(getBlockTextarea(container)).toBeNull();
  });

  it('Trigger B: ``` mid-line (preceded by content) does NOT trigger', async () => {
    const { container, ta } = setup();
    await setValue(ta, 'hello ```');
    await fireEvent.keyDown(ta, { key: ' ' });
    await tick();

    expect(getBlockTextarea(container)).toBeNull();
  });

  it('Trigger B: with content on a previous line, ``` on new line still triggers', async () => {
    const { container, ta } = setup();
    await setValue(ta, 'note about something\n```');
    await fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    await tick();
    await Promise.resolve();
    await tick();

    // Fence line stripped; previous line preserved (the trailing newline
    // between the prior line and the now-removed fence is intentionally
    // kept — it was the user's own newline, separate from the fence chars).
    expect(ta.value).toBe('note about something\n');
    expect(getBlockTextarea(container)).toBeTruthy();
  });

  it('Esc inside empty Trigger B block restores pre-entry source (gesture undo)', async () => {
    const { container, ta } = setup();
    await setValue(ta, '```python');
    await fireEvent.keyDown(ta, { key: ' ' });
    await tick();
    await Promise.resolve();
    await tick();

    const block = getBlockTextarea(container);
    expect(block).toBeTruthy();

    await fireEvent.keyDown(block, { key: 'Escape' });
    await tick();
    await Promise.resolve();
    await tick();

    // Block dismissed; inline source restored to pre-gesture state.
    expect(getBlockTextarea(container)).toBeNull();
    expect(ta.value).toBe('```python');
  });

  it('Backspace in empty Trigger B block restores pre-entry source', async () => {
    const { container, ta } = setup();
    await setValue(ta, '```');
    await fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    await tick();
    await Promise.resolve();
    await tick();

    const block = getBlockTextarea(container);
    expect(block).toBeTruthy();
    block.setSelectionRange(0, 0);

    await fireEvent.keyDown(block, { key: 'Backspace' });
    await tick();
    await Promise.resolve();
    await tick();

    expect(getBlockTextarea(container)).toBeNull();
    expect(ta.value).toBe('```');
  });

  it('Typing ``` on its own line inside the block closes and commits the synthesized block', async () => {
    const { container, ta } = setup();
    await setValue(ta, '```');
    await fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    await tick();
    await Promise.resolve();
    await tick();

    let block = getBlockTextarea(container);
    expect(block).toBeTruthy();

    // Simulate typing body + close fence in one input event.
    block.value = 'foo\n```';
    await fireEvent.input(block, { target: block });
    await tick();
    await Promise.resolve();
    await tick();

    // Block should have closed.
    expect(getBlockTextarea(container)).toBeNull();
    // Inline source should now contain the synthesized closed block. No
    // trailing newline because the splice point was at end-of-source and
    // there was no following content to separate from.
    expect(ta.value).toBe('```\nfoo\n```');
  });

  it('Esc inside non-empty block commits the synthesized block back into inline source', async () => {
    const { container, ta } = setup();
    await setValue(ta, '```');
    await fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    await tick();
    await Promise.resolve();
    await tick();

    const block = getBlockTextarea(container);
    block.value = 'hello\nworld';
    await fireEvent.input(block, { target: block });
    await tick();

    await fireEvent.keyDown(block, { key: 'Escape' });
    await tick();
    await Promise.resolve();
    await tick();

    expect(getBlockTextarea(container)).toBeNull();
    expect(ta.value).toBe('```\nhello\nworld\n```');
  });

  it('Backspace at row 0 col 0 of non-empty block dissolves fences and merges body as plain text', async () => {
    const { container, ta } = setup();
    await setValue(ta, '```');
    await fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    await tick();
    await Promise.resolve();
    await tick();

    const block = getBlockTextarea(container);
    block.value = 'preserve me';
    await fireEvent.input(block, { target: block });
    await tick();

    block.setSelectionRange(0, 0);
    await fireEvent.keyDown(block, { key: 'Backspace' });
    await tick();
    await Promise.resolve();
    await tick();

    expect(getBlockTextarea(container)).toBeNull();
    expect(ta.value).toBe('preserve me');
  });

  it('Send while in block mode commits block first then dispatches', async () => {
    const { store, container, ta } = setup();
    await setValue(ta, '```');
    await fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    await tick();
    await Promise.resolve();
    await tick();

    const block = getBlockTextarea(container);
    block.value = 'sent body';
    await fireEvent.input(block, { target: block });
    await tick();

    // Click the send button.
    const sendBtn = container.querySelector('[data-testid="send-button"]');
    await fireEvent.click(sendBtn);
    await tick();
    await Promise.resolve();
    await tick();

    expect(store.sendMessage).toHaveBeenCalled();
    const sent = store.sendMessage.mock.calls[0][0];
    expect(sent).toContain('```');
    expect(sent).toContain('sent body');
    // Block dismissed.
    expect(getBlockTextarea(container)).toBeNull();
  });

  it('ArrowRight at end of body exits block (commits synthesized) and returns to inline', async () => {
    const { container, ta } = setup();
    await setValue(ta, '```');
    await fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    await tick();
    await Promise.resolve();
    await tick();

    const block = getBlockTextarea(container);
    block.value = 'foo';
    await fireEvent.input(block, { target: block });
    await tick();

    block.setSelectionRange(3, 3); // end of body
    await fireEvent.keyDown(block, { key: 'ArrowRight' });
    await tick();
    await Promise.resolve();
    await tick();

    expect(getBlockTextarea(container)).toBeNull();
    expect(ta.value).toBe('```\nfoo\n```');
  });

  it('ArrowDown on last line of body exits block', async () => {
    const { container, ta } = setup();
    await setValue(ta, '```');
    await fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    await tick();
    await Promise.resolve();
    await tick();

    const block = getBlockTextarea(container);
    block.value = 'first\nsecond';
    await fireEvent.input(block, { target: block });
    await tick();

    // Caret on last line (index 6 = start of "second", 12 = end).
    block.setSelectionRange(8, 8);
    await fireEvent.keyDown(block, { key: 'ArrowDown' });
    await tick();
    await Promise.resolve();
    await tick();

    expect(getBlockTextarea(container)).toBeNull();
    expect(ta.value).toBe('```\nfirst\nsecond\n```');
  });

  it('ArrowDown on non-last line stays inside block (no exit)', async () => {
    const { container, ta } = setup();
    await setValue(ta, '```');
    await fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    await tick();
    await Promise.resolve();
    await tick();

    const block = getBlockTextarea(container);
    block.value = 'first\nsecond';
    await fireEvent.input(block, { target: block });
    await tick();

    // Caret on FIRST line.
    block.setSelectionRange(2, 2);
    await fireEvent.keyDown(block, { key: 'ArrowDown' });
    await tick();
    await Promise.resolve();
    await tick();

    // Block still mounted.
    expect(getBlockTextarea(container)).toBeTruthy();
  });

  it('ArrowRight not at end of body stays inside block (no exit)', async () => {
    const { container, ta } = setup();
    await setValue(ta, '```');
    await fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    await tick();
    await Promise.resolve();
    await tick();

    const block = getBlockTextarea(container);
    block.value = 'foo';
    await fireEvent.input(block, { target: block });
    await tick();

    block.setSelectionRange(1, 1); // middle of body
    await fireEvent.keyDown(block, { key: 'ArrowRight' });
    await tick();
    await Promise.resolve();
    await tick();

    expect(getBlockTextarea(container)).toBeTruthy();
  });

  it('Trigger B does not fire when caret is on a different line than the fence', async () => {
    const { container, ta } = setup();
    // Fence is on line 1; user is on line 2 typing other content.
    await setValue(ta, '```\nhello world');
    // Caret somewhere in 'hello world' (line 2).
    ta.setSelectionRange(11, 11);
    await fireEvent.click(ta);
    await tick();

    await fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    await tick();
    await Promise.resolve();
    await tick();

    expect(getBlockTextarea(container)).toBeNull();
  });

  it('Trigger B does NOT fire on mid-line ``` + Shift+Enter (complement to Space test)', async () => {
    const { container, ta } = setup();
    await setValue(ta, 'hello ```');
    await fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    await tick();

    expect(getBlockTextarea(container)).toBeNull();
  });

  // DELETED: "Already in block mode, Shift+Enter inside block inserts newline (no nested gesture)"
  // The only assertion was expect(true).toBe(true) — the stated scenario was never exercised.
  // The "no nested gesture" property is structurally guaranteed by Svelte's event-handler
  // binding (the block textarea's keydown handler never handles Shift+Enter). No production
  // code was called by this test.
  // TODO: implement correctly by typing a non-fence char + Shift+Enter inside the block
  // textarea and asserting the block stays open (block textarea still in DOM).
});

// ---------------------------------------------------------------------------
// Markdown emphasis isolation (markdown-inline-plan v2 §3.5)
// ---------------------------------------------------------------------------
//
// The composer overlay must NEVER render bold / italic / strike. Emphasis is
// a read-side-only feature: bold widens glyphs and italic shears them, which
// would break the textarea ↔ overlay caret-alignment invariant we hardened
// for backticks. Structural guarantee comes from compose-overlay-segments
// using bare `parse()` (no emphasis tokens), but these tests lock the
// invariant against future drift — if anyone ever switches the composer to
// `parseRich()`, these blow up immediately.

describe('MessageInput markdown emphasis isolation', () => {
  it('renders *italic* as plain literal source in overlay (no <em>)', async () => {
    const store = makeStore();
    const { container } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = container.querySelector('textarea');

    await setValue(ta, '*foo*');
    const overlay = getOverlay(container);
    expect(overlay).toBeTruthy();

    // No <em> / .md-italic markup should leak into the composer overlay.
    expect(overlay.querySelector('em')).toBeNull();
    expect(overlay.querySelector('.md-italic')).toBeNull();

    // Overlay text must contain the source verbatim — asterisks visible.
    // (Overlay appends a trailing whitespace sentinel for caret-at-end
    // rendering; trim before equality.)
    expect(overlay.textContent.trimEnd()).toBe('*foo*');
  });

  it('renders **bold** as plain literal source in overlay (no <strong>)', async () => {
    const store = makeStore();
    const { container } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = container.querySelector('textarea');

    await setValue(ta, '**bar**');
    const overlay = getOverlay(container);
    expect(overlay.querySelector('strong')).toBeNull();
    expect(overlay.querySelector('.md-bold')).toBeNull();
    expect(overlay.textContent.trimEnd()).toBe('**bar**');
  });

  it('renders ~~strike~~ as plain literal source in overlay', async () => {
    const store = makeStore();
    const { container } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = container.querySelector('textarea');

    await setValue(ta, '~~baz~~');
    const overlay = getOverlay(container);
    expect(overlay.querySelector('.md-strike')).toBeNull();
    expect(overlay.textContent.trimEnd()).toBe('~~baz~~');
  });

  it('emphasis next to a code chip does not leak emphasis markup; chip still renders', async () => {
    const store = makeStore();
    const { container } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = container.querySelector('textarea');

    await setValue(ta, '*pre* `code` **post**');
    const overlay = getOverlay(container);

    // Chip still renders.
    const chip = overlay.querySelector('.overlay-code-chip');
    expect(chip).toBeTruthy();
    expect(chip.textContent).toBe('code');

    // No emphasis markup anywhere.
    expect(overlay.querySelector('em')).toBeNull();
    expect(overlay.querySelector('strong')).toBeNull();
    expect(overlay.querySelector('.md-italic')).toBeNull();
    expect(overlay.querySelector('.md-bold')).toBeNull();
    expect(overlay.querySelector('.md-strike')).toBeNull();

    // Overlay text equals source byte-for-byte (modulo overlay trail
    // sentinel).
    expect(overlay.textContent.trimEnd()).toBe('*pre* `code` **post**');
  });

  it('mixed emphasis + mention + code preserves source text in overlay', async () => {
    const store = makeStore();
    const { container } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = container.querySelector('textarea');

    await setValue(ta, '**bold** @phil `code`');
    const overlay = getOverlay(container);

    // No emphasis markup.
    expect(overlay.querySelector('strong')).toBeNull();
    expect(overlay.querySelector('.md-bold')).toBeNull();

    // Chip + mention pill still render.
    expect(overlay.querySelector('.overlay-code-chip')).toBeTruthy();
    // Mention rendering uses overlay-mention-pill (or similar) — confirm the
    // mention text "phil" appears somewhere in the overlay regardless of
    // exact wrapper class.
    expect(overlay.textContent).toContain('phil');

    // Source text round-trips: `**bold**` literal, code chip text, mention text.
    expect(overlay.textContent).toContain('**bold**');
    expect(overlay.textContent).toContain('code');
  });

  it('emphasis inside a code chip stays literal and does not produce emphasis tokens', async () => {
    const store = makeStore();
    const { container } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = container.querySelector('textarea');

    await setValue(ta, '`*not italic*`');
    const overlay = getOverlay(container);

    // The whole thing is one code chip.
    const chip = overlay.querySelector('.overlay-code-chip');
    expect(chip).toBeTruthy();
    // Asterisks live inside the chip body — never as emphasis markup.
    expect(chip.textContent).toBe('*not italic*');
    expect(overlay.querySelector('em')).toBeNull();
    expect(overlay.querySelector('.md-italic')).toBeNull();
  });
});
