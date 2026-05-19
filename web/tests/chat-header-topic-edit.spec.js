// Tests for ChatHeader.svelte — v0.4.2 Step 3.2 (inline channel-topic edit
// from chat header).
//
// What this suite pins:
//
//   1. Role-gated edit affordance
//      - Owner sees the static topic AS a button + pencil icon button.
//      - Admin sees the same.
//      - Member sees the static topic as a DISABLED button + no pencil.
//      - currentUserRole === null also hides the affordance.
//
//   2. Click-to-edit input swap
//      - Clicking the topic button (when editable) swaps it for an input.
//      - The input mounts pre-populated with the current channel topic.
//      - The input grabs focus on swap.
//
//   3. Save / cancel behavior
//      - Enter calls store.setTopic(channelId, newTopic) and exits edit.
//      - Esc cancels without calling setTopic and restores the static
//        view with the ORIGINAL topic.
//      - Blur commits (matching ChannelDirectoryModal Admin tab).
//      - Saving the same string is a no-op (no setTopic call).
//      - Saving an empty string is accepted (clears the topic) — the
//        store's `comms_conversation_update` allows empty topics, and
//        we mirror that here so users can blank a stale topic.
//
//   4. Error surfacing
//      - When store.setTopic resolves { success: false, error }, the
//        onEditTopicError callback fires with that error string.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

import ChatHeader from '../src/components/ChatHeader.svelte';

// ── Helpers ────────────────────────────────────────────────────────────

function makeChannel(overrides = {}) {
  return {
    id: 'general',
    name: 'general',
    topic: 'a place for general chatter',
    memberCount: 5,
    ...overrides,
  };
}

function makeStore(overrides = {}) {
  return {
    setTopic: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

function makeProps(overrides = {}) {
  return {
    channel: makeChannel(),
    currentUserRole: 'owner',
    store: makeStore(),
    onEditTopicError: vi.fn(),
    ...overrides,
  };
}

async function flush() {
  await Promise.resolve();
  await tick();
}

afterEach(() => {
  cleanup();
});

// ── 1. Role-gated edit affordance ──────────────────────────────────────

describe('ChatHeader — role-gated edit affordance', () => {
  it('owner sees the edit-topic pencil button', () => {
    const props = makeProps({ currentUserRole: 'owner' });
    const { queryByTestId, getByTestId } = render(ChatHeader, { props });
    expect(queryByTestId('chat-header-topic-edit-btn')).not.toBeNull();
    // Static topic button is rendered + enabled.
    const staticBtn = getByTestId('chat-header-topic-static');
    expect(staticBtn.hasAttribute('disabled')).toBe(false);
    expect(staticBtn.classList.contains('editable')).toBe(true);
  });

  it('admin sees the edit-topic pencil button', () => {
    const props = makeProps({ currentUserRole: 'admin' });
    const { queryByTestId, getByTestId } = render(ChatHeader, { props });
    expect(queryByTestId('chat-header-topic-edit-btn')).not.toBeNull();
    expect(getByTestId('chat-header-topic-static').hasAttribute('disabled')).toBe(false);
  });

  it('member sees the topic as a disabled button with no pencil', () => {
    const props = makeProps({ currentUserRole: 'member' });
    const { queryByTestId, getByTestId } = render(ChatHeader, { props });
    expect(queryByTestId('chat-header-topic-edit-btn')).toBeNull();
    const staticBtn = getByTestId('chat-header-topic-static');
    expect(staticBtn.hasAttribute('disabled')).toBe(true);
    expect(staticBtn.classList.contains('editable')).toBe(false);
  });

  it('currentUserRole === null hides the edit affordance', () => {
    const props = makeProps({ currentUserRole: null });
    const { queryByTestId } = render(ChatHeader, { props });
    expect(queryByTestId('chat-header-topic-edit-btn')).toBeNull();
  });
});

// ── 2. Click-to-edit input swap ────────────────────────────────────────

describe('ChatHeader — click-to-edit input swap', () => {
  it('clicking the static topic swaps to an input pre-populated with the current topic', async () => {
    const props = makeProps({
      channel: makeChannel({ topic: 'design discussions only' }),
    });
    const { getByTestId, queryByTestId } = render(ChatHeader, { props });

    await fireEvent.click(getByTestId('chat-header-topic-static'));
    await flush();

    const input = queryByTestId('chat-header-topic-input');
    expect(input).not.toBeNull();
    expect(input.value).toBe('design discussions only');
    // The static button should no longer be in the DOM.
    expect(queryByTestId('chat-header-topic-static')).toBeNull();
  });

  it('input auto-focuses on swap (so the user can type immediately)', async () => {
    const props = makeProps();
    const { getByTestId } = render(ChatHeader, { props });
    await fireEvent.click(getByTestId('chat-header-topic-static'));
    await flush();
    const input = getByTestId('chat-header-topic-input');
    expect(document.activeElement).toBe(input);
  });
});

// ── 3. Save / cancel behavior ──────────────────────────────────────────

describe('ChatHeader — save / cancel behavior', () => {
  it('Enter calls store.setTopic(channelId, newTopic) and exits edit', async () => {
    const store = makeStore();
    const props = makeProps({
      channel: makeChannel({ id: 'design', topic: 'old topic' }),
      store,
    });
    const { getByTestId, queryByTestId } = render(ChatHeader, { props });

    await fireEvent.click(getByTestId('chat-header-topic-static'));
    await flush();
    const input = getByTestId('chat-header-topic-input');
    await fireEvent.input(input, { target: { value: 'new topic' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await flush();

    expect(store.setTopic).toHaveBeenCalledTimes(1);
    expect(store.setTopic).toHaveBeenCalledWith('design', 'new topic');
    // Edit mode exits.
    expect(queryByTestId('chat-header-topic-input')).toBeNull();
  });

  it('Esc cancels without calling setTopic and restores the static view', async () => {
    const store = makeStore();
    const props = makeProps({
      channel: makeChannel({ topic: 'original' }),
      store,
    });
    const { getByTestId, queryByTestId } = render(ChatHeader, { props });

    await fireEvent.click(getByTestId('chat-header-topic-static'));
    await flush();
    const input = getByTestId('chat-header-topic-input');
    await fireEvent.input(input, { target: { value: 'unsaved edits' } });
    await fireEvent.keyDown(input, { key: 'Escape' });
    await flush();

    expect(store.setTopic).not.toHaveBeenCalled();
    // Static view restored with original topic.
    const staticBtn = queryByTestId('chat-header-topic-static');
    expect(staticBtn).not.toBeNull();
    expect(staticBtn.textContent.trim()).toBe('original');
  });

  it('saving the same topic is a no-op (no setTopic call)', async () => {
    const store = makeStore();
    const props = makeProps({
      channel: makeChannel({ topic: 'unchanged' }),
      store,
    });
    const { getByTestId } = render(ChatHeader, { props });

    await fireEvent.click(getByTestId('chat-header-topic-static'));
    await flush();
    const input = getByTestId('chat-header-topic-input');
    // No edit; press Enter.
    await fireEvent.keyDown(input, { key: 'Enter' });
    await flush();

    expect(store.setTopic).not.toHaveBeenCalled();
  });

  it('saving an empty string is accepted (clears the topic via setTopic)', async () => {
    // Step 3.2 contract decision: empty topic == clear. The store's
    // `setTopic` already forwards "" to MCP, which accepts it.
    const store = makeStore();
    const props = makeProps({
      channel: makeChannel({ topic: 'will be cleared' }),
      store,
    });
    const { getByTestId } = render(ChatHeader, { props });

    await fireEvent.click(getByTestId('chat-header-topic-static'));
    await flush();
    const input = getByTestId('chat-header-topic-input');
    await fireEvent.input(input, { target: { value: '' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    await flush();

    expect(store.setTopic).toHaveBeenCalledTimes(1);
    expect(store.setTopic).toHaveBeenCalledWith('general', '');
  });

  it('blur commits the draft (matches ChannelDirectoryModal Admin tab)', async () => {
    const store = makeStore();
    const props = makeProps({
      channel: makeChannel({ id: 'design', topic: 'before' }),
      store,
    });
    const { getByTestId } = render(ChatHeader, { props });

    await fireEvent.click(getByTestId('chat-header-topic-static'));
    await flush();
    const input = getByTestId('chat-header-topic-input');
    await fireEvent.input(input, { target: { value: 'after' } });
    await fireEvent.blur(input);
    await flush();

    expect(store.setTopic).toHaveBeenCalledTimes(1);
    expect(store.setTopic).toHaveBeenCalledWith('design', 'after');
  });
});

// ── 4. Error surfacing ─────────────────────────────────────────────────

describe('ChatHeader — error surfacing', () => {
  it('store.setTopic { success: false, error } fires onEditTopicError with the error string', async () => {
    const store = makeStore({
      setTopic: vi.fn().mockResolvedValue({
        success: false,
        error: 'Server rejected the topic.',
      }),
    });
    const onEditTopicError = vi.fn();
    const props = makeProps({ store, onEditTopicError });
    const { getByTestId } = render(ChatHeader, { props });

    await fireEvent.click(getByTestId('chat-header-topic-static'));
    await flush();
    const input = getByTestId('chat-header-topic-input');
    await fireEvent.input(input, { target: { value: 'something new' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    // Two microtask ticks: one for the async setTopic resolution, one
    // for the callback dispatch.
    await flush();
    await flush();

    expect(onEditTopicError).toHaveBeenCalledTimes(1);
    expect(onEditTopicError).toHaveBeenCalledWith('Server rejected the topic.');
  });
});
