// Component tests for MessageInput.svelte focused on the @mention
// orchestration (lib/mentions.js + MentionDropdown). Rendered in JSDOM
// via @testing-library/svelte.
//
// Coverage targets the 11 UX behaviors enumerated in plans/mention-autocomplete-revamp.md:
//   - Type `@cl` → dropdown appears with filtered candidates
//   - Tab on highlight → text becomes `@claude-test` (no trailing space), token
//     created in the parent state, recipients propagate at send-time
//   - ArrowDown moves highlight, doesn't move text cursor
//   - Click candidate → commits with no trailing space
//   - Esc dismisses dropdown
//   - Space after exact match → instant commit, space follows token
//   - Comma after exact match → instant commit, comma follows token
//   - 200ms debounce auto-commit on idle (vi.useFakeTimers)
//   - Send with committed token → store.sendMessage called with recipients=[key]
//   - Backspace into committed token → suggestion re-spins
//   - Online participants ranked first in dropdown
//
// Mocks
// ─────
// We supply a minimal `store` object — only the surfaces MessageInput
// reads (participants, userProfile, sendMessage, notifyTyping). This
// keeps the test free from MQTT/WebSocket plumbing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  'claude-test-key': {
    key: 'claude-test-key',
    name: 'claude-test',
    type: 'agent',
    connections: { 'mcp-1': {} },
  },
  'bob-key': {
    key: 'bob-key',
    name: 'bob',
    type: 'human',
    connections: {}, // offline
  },
  'alice-key': {
    key: 'alice-key',
    name: 'alice',
    type: 'human',
    connections: { 'tui-1': {} },
  },
};

/**
 * Build a fresh store stub for each test. Tests mutate `participants` via
 * the same object reference so reactivity sees the change. `sendMessage`
 * is a vi.fn so we can assert recipients.
 */
function makeStore(overrides = {}) {
  const sendMessage = vi.fn();
  const notifyTyping = vi.fn();
  return {
    participants: PARTICIPANTS,
    userProfile: { key: 'phil-key', name: 'phil', type: 'human' },
    sendMessage,
    notifyTyping,
    ...overrides,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Type a string into the textarea, mirroring how a browser fires events:
 * one input event per character with selection at the end. We DO NOT use
 * keyboard.type() because our component cares about the input event's
 * synthesized `selectionStart`, which JSDOM only updates after `value=`
 * assignment + manual selection move.
 *
 * @param {HTMLTextAreaElement} ta
 * @param {string} text
 */
async function typeText(ta, text) {
  for (const ch of text) {
    const newValue = ta.value + ch;
    ta.value = newValue;
    ta.setSelectionRange(newValue.length, newValue.length);
    await fireEvent.input(ta, { target: ta });
    await tick();
  }
}

/**
 * Press a key on the textarea. Returns true if the default action was
 * NOT prevented (so the caller can simulate the character insert
 * themselves if needed). Always fires a keydown event.
 */
async function pressKey(ta, key, opts = {}) {
  const ev = await fireEvent.keyDown(ta, { key, ...opts });
  await tick();
  return ev;
}

afterEach(() => {
  cleanup();
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('MessageInput @mention — dropdown trigger', () => {
  it('typing `@cl` shows the dropdown with filtered candidates', async () => {
    const store = makeStore();
    const { getByTestId, queryByTestId } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');
    expect(queryByTestId('mention-dropdown')).toBeNull();

    await typeText(ta, '@cl');
    expect(queryByTestId('mention-dropdown')).not.toBeNull();
    // Only "claude-test" matches the prefix `cl`.
    expect(queryByTestId('mention-item-claude-test-key')).not.toBeNull();
    // "alice" / "bob" / "phil" are NOT matched.
    expect(queryByTestId('mention-item-alice-key')).toBeNull();
    expect(queryByTestId('mention-item-bob-key')).toBeNull();
  });

  it('online participants ranked first in the dropdown when query is empty', async () => {
    const store = makeStore();
    const { getByTestId, container } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');
    await typeText(ta, '@');
    const items = container.querySelectorAll('[role="option"]');
    // alice + claude-test (online) come before bob (offline). Phil is self
    // and excluded.
    expect(items.length).toBe(3);
    const keys = Array.from(items).map((el) => el.id.split('mention-listbox-opt-')[1]);
    expect(keys).toEqual(['alice-key', 'claude-test-key', 'bob-key']);
  });
});

describe('MessageInput @mention — explicit commit (Tab/Click)', () => {
  it('Tab commits the highlighted candidate, no trailing space', async () => {
    const store = makeStore();
    const { getByTestId } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');
    await typeText(ta, '@cl');
    await pressKey(ta, 'Tab');
    // After commit, the textarea's value should be `@claude-test` exactly.
    expect(ta.value).toBe('@claude-test');
  });

  it('clicking a candidate commits it (no trailing space)', async () => {
    const store = makeStore();
    const { getByTestId, queryByTestId } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');
    await typeText(ta, '@cl');
    const item = getByTestId('mention-item-claude-test-key');
    // mousedown is the commit trigger (so focus stays on textarea).
    await fireEvent.mouseDown(item);
    await tick();
    expect(ta.value).toBe('@claude-test');
    expect(queryByTestId('mention-dropdown')).toBeNull();
  });

  it('Esc dismisses the dropdown without committing', async () => {
    const store = makeStore();
    const { getByTestId, queryByTestId } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');
    await typeText(ta, '@cl');
    expect(queryByTestId('mention-dropdown')).not.toBeNull();
    await pressKey(ta, 'Escape');
    expect(queryByTestId('mention-dropdown')).toBeNull();
    // Text is unchanged.
    expect(ta.value).toBe('@cl');
  });
});

describe('MessageInput @mention — keyboard nav', () => {
  it('ArrowDown moves the highlight; textarea cursor unchanged', async () => {
    const store = makeStore();
    const { getByTestId, container } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');
    await typeText(ta, '@');
    const cursorBefore = ta.selectionStart;

    // Highlight moves 0 → 1
    await pressKey(ta, 'ArrowDown');
    const items = container.querySelectorAll('[role="option"]');
    expect(items.length).toBeGreaterThanOrEqual(2);
    // The second item now has aria-selected="true".
    expect(items[1].getAttribute('aria-selected')).toBe('true');
    // Textarea cursor unmoved.
    expect(ta.selectionStart).toBe(cursorBefore);
  });

  it('ArrowUp wraps when at index 0', async () => {
    const store = makeStore();
    const { getByTestId, container } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');
    await typeText(ta, '@');
    await pressKey(ta, 'ArrowUp');
    const items = container.querySelectorAll('[role="option"]');
    expect(items[items.length - 1].getAttribute('aria-selected')).toBe('true');
  });
});

describe('MessageInput @mention — implicit commit (word terminator)', () => {
  it('typing space after exact match commits and the space lands AFTER the token', async () => {
    const store = makeStore();
    const { getByTestId } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');
    await typeText(ta, '@bob');
    // bob matches an offline participant exactly. Press space (keydown
    // → handleKeydown commits, then default insert proceeds).
    await pressKey(ta, ' ');
    // Simulate browser inserting the space.
    ta.value = ta.value + ' ';
    ta.setSelectionRange(ta.value.length, ta.value.length);
    await fireEvent.input(ta, { target: ta });
    await tick();
    expect(ta.value).toBe('@bob ');
  });

  it('typing comma after exact match commits and comma lands AFTER the token', async () => {
    const store = makeStore();
    const { getByTestId } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');
    await typeText(ta, '@bob');
    await pressKey(ta, ',');
    ta.value = ta.value + ',';
    ta.setSelectionRange(ta.value.length, ta.value.length);
    await fireEvent.input(ta, { target: ta });
    await tick();
    expect(ta.value).toBe('@bob,');
  });
});

describe('MessageInput @mention — debounced implicit commit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('200ms idle after exact match silently commits', async () => {
    const store = makeStore();
    const { getByTestId, queryByTestId } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');
    // Use real-time-ish typing: each char triggers the debounce reset.
    // We type via fireEvent so the effect schedules its setTimeout under
    // fake timers.
    for (const ch of '@bob') {
      ta.value += ch;
      ta.setSelectionRange(ta.value.length, ta.value.length);
      await fireEvent.input(ta, { target: ta });
    }
    await tick();
    // Dropdown is open with "bob" highlighted (exact match).
    expect(queryByTestId('mention-dropdown')).not.toBeNull();
    // Advance 200ms — the debounce should fire commitCandidate.
    await vi.advanceTimersByTimeAsync(200);
    await tick();
    // After commit, dropdown is gone and text is exactly `@bob`.
    expect(ta.value).toBe('@bob');
    expect(queryByTestId('mention-dropdown')).toBeNull();
  });
});

describe('MessageInput @mention — send-time recipient resolution', () => {
  it('sends recipients=[key] when a token is committed', async () => {
    const store = makeStore();
    const { getByTestId } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');
    await typeText(ta, '@cl');
    await pressKey(ta, 'Tab');
    // Add a body after the mention.
    await typeText(ta, ' hello');
    expect(ta.value).toBe('@claude-test hello');
    // Click send.
    await fireEvent.click(getByTestId('send-button'));
    await tick();
    expect(store.sendMessage).toHaveBeenCalledTimes(1);
    expect(store.sendMessage).toHaveBeenCalledWith(
      '@claude-test hello',
      null,
      ['claude-test-key'],
    );
  });

  it('sends recipients=null when no tokens are committed', async () => {
    const store = makeStore();
    const { getByTestId } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');
    await typeText(ta, 'hi everyone');
    await fireEvent.click(getByTestId('send-button'));
    await tick();
    expect(store.sendMessage).toHaveBeenCalledWith('hi everyone', null, null);
  });
});

describe('MessageInput @mention — re-targeting on edit', () => {
  it('backspacing into a committed token re-spins the suggestion', async () => {
    const store = makeStore();
    const { getByTestId, queryByTestId } = render(MessageInput, {
      props: { store, channelName: 'general', typingUsers: [], onOpenEmoji: () => {} },
    });
    const ta = getByTestId('message-input');
    await typeText(ta, '@cl');
    await pressKey(ta, 'Tab');
    expect(ta.value).toBe('@claude-test');
    // Dropdown closed.
    expect(queryByTestId('mention-dropdown')).toBeNull();
    // Backspace one char → `@claude-tes` and dropdown reopens.
    ta.value = ta.value.slice(0, -1);
    ta.setSelectionRange(ta.value.length, ta.value.length);
    await fireEvent.input(ta, { target: ta });
    await tick();
    expect(ta.value).toBe('@claude-tes');
    expect(queryByTestId('mention-dropdown')).not.toBeNull();
    // The active suggestion's query is `claude-tes` and claude-test still
    // matches as a prefix.
    expect(queryByTestId('mention-item-claude-test-key')).not.toBeNull();
  });
});
