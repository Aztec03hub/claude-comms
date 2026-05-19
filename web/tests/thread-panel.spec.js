// Component tests for ThreadPanel.svelte — UX G-36 / v0.4.2 Step 3.12.
//
// Step 3.12 swaps the pre-3.12 inline `<input type="text">` thread
// composer for a `MessageInput` mount routed through a thread-scoped
// store proxy that stamps `parentMessage.id` as `replyTo` on every send.
// These tests pin:
//
//   1. Legacy-path back-compat: when the panel is mounted without a
//      `store` prop (App.svelte's current call site at the time of this
//      change), the inline composer is used and `onSendReply` fires.
//   2. New-path mount: with a live `store`, the inline composer is
//      replaced by `<MessageInput>` (visible via the
//      `data-testid="message-input"` textarea and the `thread-composer`
//      wrapper).
//   3. Default-path send routes through the thread proxy and ends up
//      calling `store.sendMessage(body, parentMessage.id, opts)` —
//      proving the `replyTo` is rewritten from null to the parent id.
//   4. Slash command `/me` typed in the thread composer routes through
//      the thread proxy too — the synthesized action body lands on
//      `store.sendMessage` with the thread parent stamped.
//   5. Slash command `/help` typed in the thread composer is consumed
//      by the registry without firing a regular send (asserts the
//      slash interception still runs inside threads).
//   6. Explicit `replyTo` (e.g. `/reply <other-uuid>`) is forwarded
//      verbatim — the thread proxy does NOT clobber a non-null
//      `replyTo`. This is the safety case for cross-thread replies
//      typed from inside a thread.
//   7. The legacy panel header (title, reply count, close button) is
//      rendered identically in both composer modes, so the thread
//      UI shell is unchanged.
//
// No em dashes in user-facing assertion text (Standing Rule §I.6 #11).

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

import ThreadPanel from '../src/components/ThreadPanel.svelte';

// ── Fixtures ─────────────────────────────────────────────────────────────

const PARENT_ID = '00000000-0000-4000-8000-00000000aaaa';

function makeParent(overrides = {}) {
  return {
    id: PARENT_ID,
    ts: '2026-05-19T01:00:00Z',
    sender: { key: 'phil-key', name: 'phil', type: 'human' },
    body: 'kicking off a thread',
    ...overrides,
  };
}

function makeReplies() {
  return [
    {
      id: '00000000-0000-4000-8000-00000000bbb1',
      ts: '2026-05-19T01:01:00Z',
      sender: { key: 'ember-key', name: 'ember', type: 'agent' },
      body: 'first reply',
      reply_to: PARENT_ID,
    },
  ];
}

/**
 * Build a fake ChatStore with just the surface MessageInput touches
 * (participants, userProfile, composerPrefill, notifyTyping, activeChannel,
 * activeMembers, channelsById, sendMessage) plus the slash-command
 * registry's store callbacks (joinChannel/leaveChannel/...). Each method
 * is a `vi.fn` so individual tests can assert call args.
 */
function makeStore() {
  return {
    participants: {
      'phil-key': {
        key: 'phil-key',
        name: 'phil',
        type: 'human',
        connections: { 'web-1': {} },
      },
      'ember-key': {
        key: 'ember-key',
        name: 'ember',
        type: 'agent',
        connections: { 'agent-1': {} },
      },
    },
    userProfile: { key: 'phil-key', name: 'phil', type: 'human' },
    composerPrefill: null,
    activeChannel: 'general',
    activeMembers: [
      { key: 'phil-key', name: 'phil' },
      { key: 'ember-key', name: 'ember' },
    ],
    channelsById: { general: { id: 'general', starred: false, member: true } },
    sendMessage: vi.fn(),
    notifyTyping: vi.fn(),
    joinChannel: vi.fn().mockResolvedValue({ success: true }),
    leaveChannel: vi.fn().mockReturnValue({
      done: Promise.resolve({ success: true }),
      cancel: () => ({ tooLate: true }),
    }),
    closeChannel: vi.fn().mockReturnValue({
      done: Promise.resolve({ success: true }),
      cancel: () => ({ tooLate: true }),
    }),
    setTopic: vi.fn().mockResolvedValue({ success: true }),
    setStar: vi.fn().mockReturnValue({ success: true }),
    setMute: vi.fn().mockReturnValue({ success: true }),
  };
}

/**
 * Wholesale-set the textarea value (bypass per-char input events). The
 * default-path send + slash-command tests don't need per-keystroke
 * autocomplete state.
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

// ─────────────────────────────────────────────────────────────────────────
// 1. Legacy-path back-compat
// ─────────────────────────────────────────────────────────────────────────

describe('ThreadPanel — legacy onSendReply path (back-compat)', () => {
  test('mount without store renders the inline thread input and fires onSendReply', async () => {
    const onSendReply = vi.fn();
    const onClose = vi.fn();
    const { getByTestId, queryByTestId } = render(ThreadPanel, {
      props: {
        parentMessage: makeParent(),
        messages: makeReplies(),
        participants: { 'phil-key': {} },
        currentUser: { key: 'phil-key', name: 'phil' },
        onClose,
        onSendReply,
      },
    });

    // Legacy inline composer is mounted; the new MessageInput textarea is NOT.
    const legacyInput = getByTestId('thread-reply-input');
    expect(legacyInput).toBeTruthy();
    expect(queryByTestId('thread-composer')).toBeNull();
    expect(queryByTestId('message-input')).toBeNull();
    expect(getByTestId('thread-input-legacy')).toBeTruthy();

    // Typing + Enter routes through onSendReply (no MessageInput involved).
    legacyInput.value = 'hello from legacy';
    await fireEvent.input(legacyInput, { target: legacyInput });
    await fireEvent.keyDown(legacyInput, { key: 'Enter' });
    await tick();

    expect(onSendReply).toHaveBeenCalledTimes(1);
    expect(onSendReply).toHaveBeenCalledWith('hello from legacy');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. New-path mount — MessageInput is the composer
// ─────────────────────────────────────────────────────────────────────────

describe('ThreadPanel — MessageInput composer (3.12)', () => {
  test('mount with store renders MessageInput and hides the legacy input', async () => {
    const store = makeStore();
    const onClose = vi.fn();
    const { getByTestId, queryByTestId } = render(ThreadPanel, {
      props: {
        parentMessage: makeParent(),
        messages: [],
        participants: store.participants,
        currentUser: store.userProfile,
        onClose,
        store,
        channelName: 'general',
        typingUsers: [],
        onOpenEmoji: () => {},
      },
    });

    expect(getByTestId('thread-composer')).toBeTruthy();
    expect(getByTestId('message-input')).toBeTruthy();
    // Legacy inline composer is NOT rendered.
    expect(queryByTestId('thread-input-legacy')).toBeNull();
    expect(queryByTestId('thread-reply-input')).toBeNull();
  });

  test('default-path send rewrites replyTo to the thread parent id', async () => {
    const store = makeStore();
    const { getByTestId } = render(ThreadPanel, {
      props: {
        parentMessage: makeParent(),
        messages: [],
        onClose: () => {},
        store,
        channelName: 'general',
      },
    });

    const ta = getByTestId('message-input');
    await setText(ta, 'reply via shared composer');
    const sendBtn = getByTestId('send-button');
    await fireEvent.click(sendBtn);
    await tick();

    expect(store.sendMessage).toHaveBeenCalledTimes(1);
    const [body, replyTo, opts] = store.sendMessage.mock.calls[0];
    expect(body).toBe('reply via shared composer');
    // The thread proxy stamped the parent id even though MessageInput
    // passed null.
    expect(replyTo).toBe(PARENT_ID);
    // The autocomplete-path options envelope was preserved.
    expect(opts).toBeDefined();
    expect(opts.recipients).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Slash commands inside a thread composer
// ─────────────────────────────────────────────────────────────────────────

describe('ThreadPanel — slash commands in the thread composer', () => {
  test('/me action body is sent with replyTo rewritten to thread parent', async () => {
    const store = makeStore();
    const { getByTestId } = render(ThreadPanel, {
      props: {
        parentMessage: makeParent(),
        messages: [],
        onClose: () => {},
        store,
        channelName: 'general',
      },
    });

    const ta = getByTestId('message-input');
    await setText(ta, '/me waves at the thread');
    const sendBtn = getByTestId('send-button');
    await fireEvent.click(sendBtn);
    // The slash registry handler is async; flush.
    await tick();
    await Promise.resolve();
    await tick();

    expect(store.sendMessage).toHaveBeenCalledTimes(1);
    const [body, replyTo, opts] = store.sendMessage.mock.calls[0];
    // Registry strips the leading "/me " and emits a sendAs envelope
    // with `type: 'action'` and `body: 'waves at the thread'`.
    expect(body).toBe('waves at the thread');
    expect(replyTo).toBe(PARENT_ID);
    expect(opts).toBeDefined();
    expect(opts.kind).toBe('action');
  });

  test('/help is consumed by the registry and does NOT call store.sendMessage', async () => {
    const store = makeStore();
    const { getByTestId } = render(ThreadPanel, {
      props: {
        parentMessage: makeParent(),
        messages: [],
        onClose: () => {},
        store,
        channelName: 'general',
      },
    });

    // Listen for the requestToast CustomEvent — /help surfaces its
    // command list via the registry's `ok` envelope, which MessageInput
    // routes to a requestToast.
    const toastEvents = [];
    const onToast = (e) => toastEvents.push(e);
    document.addEventListener('requestToast', onToast);

    try {
      const ta = getByTestId('message-input');
      await setText(ta, '/help');
      const sendBtn = getByTestId('send-button');
      await fireEvent.click(sendBtn);
      // /help runs through the async registry handler.
      await tick();
      await Promise.resolve();
      await tick();

      // No regular outbound send fired — /help is a side-effect only.
      expect(store.sendMessage).not.toHaveBeenCalled();
      // The toast event carried the registry's `ok` payload (an
      // "Available commands:" string).
      expect(toastEvents.length).toBeGreaterThanOrEqual(1);
      const detail = toastEvents[0].detail;
      expect(detail.kind).toBe('info');
      expect(typeof detail.text).toBe('string');
      expect(detail.text).toContain('Available commands');
    } finally {
      document.removeEventListener('requestToast', onToast);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Explicit replyTo is forwarded verbatim (safety case)
// ─────────────────────────────────────────────────────────────────────────

describe('ThreadPanel — explicit replyTo is forwarded verbatim', () => {
  test('thread proxy does not clobber a non-null replyTo passed by MessageInput', async () => {
    const store = makeStore();
    const otherId = '00000000-0000-4000-8000-00000000cccc';
    const { getByTestId } = render(ThreadPanel, {
      props: {
        parentMessage: makeParent(),
        messages: [],
        onClose: () => {},
        store,
        channelName: 'general',
      },
    });

    // Drive the proxy directly via the threadStore exposed through
    // MessageInput's store prop. We assert proxy semantics by invoking
    // `sendMessage` via a side door — call `store.sendMessage` through
    // the rendered MessageInput's `/reply <uuid>` parser path.
    const ta = getByTestId('message-input');
    await setText(ta, `/reply ${otherId} cross-thread ping`);
    const sendBtn = getByTestId('send-button');
    await fireEvent.click(sendBtn);
    await tick();
    await Promise.resolve();
    await tick();

    expect(store.sendMessage).toHaveBeenCalledTimes(1);
    const [body, replyTo] = store.sendMessage.mock.calls[0];
    expect(body).toBe('cross-thread ping');
    // Explicit /reply id wins; the proxy did NOT rewrite it to PARENT_ID.
    expect(replyTo).toBe(otherId);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Shell preservation — header / replies render identically in both modes
// ─────────────────────────────────────────────────────────────────────────

describe('ThreadPanel — shell unchanged across composer modes', () => {
  test('header, reply count, close button render in MessageInput mode', async () => {
    const store = makeStore();
    const onClose = vi.fn();
    const { getByTestId, getByText } = render(ThreadPanel, {
      props: {
        parentMessage: makeParent(),
        messages: makeReplies(),
        onClose,
        store,
        channelName: 'general',
      },
    });

    // The panel + close button + reply-count chip are all present.
    expect(getByTestId('thread-panel')).toBeTruthy();
    expect(getByText('1 replies')).toBeTruthy();
    const closeBtn = getByTestId('thread-panel-close');
    expect(closeBtn).toBeTruthy();

    await fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
