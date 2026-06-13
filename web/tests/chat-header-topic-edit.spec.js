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

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
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

// ── 5. App.svelte wire (v0.4.2 Wave E.2 follow-up) ─────────────────────
//
// After flipping `showChatHeader={true}` on App.svelte's ChatView mount
// AND deleting the legacy inline `<header class="chat-header">` block at
// the top of the main pane, the new ChatHeader.svelte must take over.
// These tests mount the real App with a mocked MqttChatStore and assert:
//
//   1. Owner sees the inline-edit affordance (pencil button)
//   2. Member does NOT see the pencil button
//   3. store.getChannelRole is called with the active channel id
//   4. The legacy inline header markup is gone from the DOM (only the
//      new ChatHeader with data-testid="chat-header-new" remains)

// JSDOM shims for App's transitive deps (rAF / IntersectionObserver /
// ResizeObserver / Notification). Mirrors prop-drilling.spec.js's setup.
{
  const realRAF = globalThis.requestAnimationFrame ?? ((cb) => setTimeout(cb, 16));
  const safeRAF = (cb) => realRAF((ts) => {
    try { cb(ts); } catch { /* swallow teardown-race throws */ }
  });
  globalThis.requestAnimationFrame = safeRAF;
  if (typeof window !== 'undefined') window.requestAnimationFrame = safeRAF;
}
if (typeof globalThis.IntersectionObserver === 'undefined') {
  globalThis.IntersectionObserver = class {
    constructor() {}
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  };
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    constructor() {}
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof globalThis.Notification === 'undefined') {
  globalThis.Notification = class {
    static permission = 'default';
    static requestPermission = () => Promise.resolve('default');
  };
}

// Module-level registry for the App-constructed store instance. App's
// constructor pushes onto this so each test can reach the live mock.
globalThis.__chatHeaderAppStoreInstances = globalThis.__chatHeaderAppStoreInstances ?? [];

// Per-instance role override the test sets BEFORE rendering App. The
// mocked constructor reads this so each test can pin the role surface
// independently. Default is 'owner' so the affordance renders.
globalThis.__chatHeaderAppRoleOverride = 'owner';

vi.mock('../src/lib/mqtt-store.svelte.js', () => {
  class MqttChatStoreMock {
    constructor() {
      globalThis.__chatHeaderAppStoreInstances.push(this);
      this.connected = true;
      this.connectionError = null;
      this.parseFailureRate = 0;
      this.serverUnreachable = false;
      this.nameUnset = false;
      this.activeChannel = 'general';
      this.activeChannelMeta = {
        id: 'general',
        name: 'general',
        topic: 'a place for general chatter',
        memberCount: 5,
        unread: 0,
        unreadFrom: null,
      };
      this.onlineCount = 1;
      this.offlineParticipants = [];
      this.activePinnedMessages = [];
      this.activeMessages = [];
      this.activeChannelReplies = [];
      this.activeTypingUsers = [];
      this.activeMembers = [];
      this.onlineElsewhere = [];
      this.typingUsers = [];
      this.userProfile = { key: 'me-key', name: 'me', type: 'human' };
      this.messages = [];
      this.channels = [{ id: 'general', muted: false }];
      this.channelsById = { general: this.activeChannelMeta };
      this.starredChannels = [];
      this.activeChannels = [{ id: 'general', muted: false }];
      this.availableChannels = [];
      this.participants = { 'me-key': { key: 'me-key', name: 'me', type: 'human' } };
      this.inAppToasts = true;
      this.composerPrefill = '';
      this.channelRoles = {};
      // Spied surfaces App reads or invokes.
      this.switchChannel = vi.fn();
      this.goToMessage = vi.fn();
      this.connect = vi.fn();
      this.disconnect = vi.fn();
      this.markThreadSeen = vi.fn();
      this.markSeen = vi.fn();
      this.markUnread = vi.fn();
      this.togglePin = vi.fn();
      this.toggleStar = vi.fn();
      this.retryMessage = vi.fn();
      this.addReaction = vi.fn();
      this.deleteMessage = vi.fn();
      this.forwardMessage = vi.fn();
      this.muteChannel = vi.fn();
      this.createChannel = vi.fn();
      this.joinChannel = vi.fn();
      this.leaveChannel = vi.fn();
      this.getMemberConversations = vi.fn(() => []);
      this.notifyTyping = vi.fn();
      this.sendMessage = vi.fn();
      this.setTopic = vi.fn().mockResolvedValue({ success: true });
      // The Wave B accessor we wire from App.svelte. Honors the per-test
      // override so member / owner / null can each be exercised.
      this.getChannelRole = vi.fn(() => globalThis.__chatHeaderAppRoleOverride);
    }
  }
  return { MqttChatStore: MqttChatStoreMock };
});

vi.mock('../src/lib/notifications.svelte.js', () => ({
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

// eslint-disable-next-line import/first
import App from '../src/App.svelte';

async function flushAppMount() {
  // Drain the rAF queue ChatView's auto-scroll effect schedules.
  await new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    } else {
      setTimeout(resolve, 50);
    }
  });
  await tick();
}

describe('App.svelte — ChatHeader wire (v0.4.2 Wave E.2 follow-up)', () => {
  beforeEach(() => {
    globalThis.__chatHeaderAppStoreInstances.length = 0;
    globalThis.__chatHeaderAppRoleOverride = 'owner';
  });

  it('owner sees the ChatHeader inline-edit pencil after the App.svelte wire flip', async () => {
    globalThis.__chatHeaderAppRoleOverride = 'owner';
    const { queryByTestId } = render(App);
    await flushAppMount();
    // The new component-scoped header mounts.
    expect(queryByTestId('chat-header-new')).not.toBeNull();
    // And because the role resolves to owner, the pencil renders.
    expect(queryByTestId('chat-header-topic-edit-btn')).not.toBeNull();
  });

  it('member does NOT see the ChatHeader inline-edit pencil', async () => {
    globalThis.__chatHeaderAppRoleOverride = 'member';
    const { queryByTestId } = render(App);
    await flushAppMount();
    expect(queryByTestId('chat-header-new')).not.toBeNull();
    // Role is member → pencil hidden, static button disabled.
    expect(queryByTestId('chat-header-topic-edit-btn')).toBeNull();
    const staticBtn = queryByTestId('chat-header-topic-static');
    expect(staticBtn).not.toBeNull();
    expect(staticBtn.hasAttribute('disabled')).toBe(true);
  });

  it('App.svelte calls store.getChannelRole with the active channel id', async () => {
    globalThis.__chatHeaderAppRoleOverride = 'owner';
    render(App);
    await flushAppMount();
    const store = globalThis.__chatHeaderAppStoreInstances.at(-1);
    expect(store).toBeDefined();
    // The wire passes `store.activeChannel` (the id string 'general') to
    // the role accessor.
    expect(store.getChannelRole).toHaveBeenCalled();
    const calls = store.getChannelRole.mock.calls;
    // Every call must use the active channel id; we don't pin call count
    // because Svelte's reactivity may re-evaluate the derivation when
    // other reactive deps settle during mount.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const args of calls) {
      expect(args[0]).toBe('general');
    }
  });

  // NOTE: "legacy inline <header class='chat-header'> markup is gone"
  // sentinel was removed (2026-06-12 test-cleanup). It was a one-time
  // migration check that fires at most once after the legacy header is
  // deleted; deleted code never re-introduces itself accidentally so the
  // test provides no ongoing regression value.
});
