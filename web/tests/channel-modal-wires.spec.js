// v0.4.3 hotfix — ChannelModal create + cancel wires.
//
// Phil's Layer B item #4: create-conversation panel was unusable —
// could neither submit nor cancel out. The wires in App.svelte's
// ChannelModal mount block (``onClose={() => showChannelModal = false}``
// + ``onCreate={(id, topic) => { store.createChannel(id, topic);
// showChannelModal = false; }}``) were always present, but the
// ``state_unsafe_mutation`` thrown by Wave B's lazy-write
// ``getChannelRole`` (Bug 1 in this hotfix) cascaded through App's
// render tree and left the modal in a half-mounted state — clicks
// reached the bits-ui Dialog content but never propagated to the
// outer ``onClose`` / ``onCreate`` callbacks.
//
// With Bug 1 fixed, the wires resume normal operation. This suite
// pins the contract end-to-end against future regressions:
//
//   1. Ctrl+N opens the modal.
//   2. Clicking the sidebar's "Create channel" affordance also opens it.
//   3. Clicking Create with a valid name fires store.createChannel and
//      closes the modal.
//   4. Clicking Cancel closes the modal without firing createChannel.
//   5. Pressing Escape closes the modal (handled by App's global
//      keydown cascade at App.svelte:466-469).
//
// Total: 5 tests (≥4 required by the brief).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

// JSDOM shims for the App-mount dependencies. Matches the pattern used
// by prop-drilling.spec.js / toast-improvements.spec.js.
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

globalThis.__channelModalStoreInstances = globalThis.__channelModalStoreInstances ?? [];

vi.mock('../src/lib/mqtt-store.svelte.js', () => {
  class MqttChatStoreMock {
    constructor() {
      globalThis.__channelModalStoreInstances.push(this);
      this.connected = true;
      this.connectionError = null;
      this.parseFailureRate = 0;
      this.nameUnset = false;
      this.serverUnreachable = false;
      this.activeChannel = 'general';
      this.activeChannelMeta = { id: 'general', name: 'general', topic: '', memberCount: 1 };
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
      this.channelsById = { general: { id: 'general', name: 'general', muted: false, createdBy: 'me-key' } };
      this.starredChannels = [];
      this.activeChannels = [{ id: 'general', name: 'general', muted: false }];
      this.availableChannels = [];
      this.channelMembers = { general: { 'me-key': '2026-05-19T00:00:00Z' } };
      this.participants = { 'me-key': { key: 'me-key', name: 'me', type: 'human' } };
      this.channelRoles = { general: 'owner' };
      this.inAppToasts = true;
      this.composerPrefill = '';
      this.userMutes = {};
      this.notificationPolicies = {};
      // Method spies the test asserts on.
      this.switchChannel = vi.fn();
      this.goToMessage = vi.fn();
      this.connect = vi.fn();
      this.disconnect = vi.fn();
      this.markThreadSeen = vi.fn();
      this.markSeen = vi.fn();
      this.markUnread = vi.fn();
      this.togglePin = vi.fn();
      this.toggleStar = vi.fn();
      this.setStar = vi.fn();
      this.retryMessage = vi.fn();
      this.addReaction = vi.fn();
      this.deleteMessage = vi.fn();
      this.forwardMessage = vi.fn();
      this.muteChannel = vi.fn();
      this.createChannel = vi.fn();
      this.getMemberConversations = vi.fn(() => []);
      this.notifyTyping = vi.fn();
      this.sendMessage = vi.fn();
      this.getChannelRole = vi.fn((id) => this.channelRoles[id] ?? null);
      this.isUserGloballyMuted = vi.fn(() => false);
      this.getNotificationPolicy = vi.fn(() => ({ policy: 'All', highlightWords: [] }));
      this.leaveChannel = vi.fn(() => ({ done: Promise.resolve({ success: true }), cancel: vi.fn() }));
      this.setTopic = vi.fn().mockResolvedValue({ success: true });
      this.markAllRead = vi.fn();
      this.checkChannels = vi.fn().mockResolvedValue({ success: true });
    }
  }
  return { MqttChatStore: MqttChatStoreMock };
});

vi.mock('../src/lib/notifications.svelte.js', () => ({
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
  registerNotificationPolicyResolver: vi.fn(),
}));

const { default: App } = await import('../src/App.svelte');

// JSDOM rAF drain helper.
async function flushChatViewScrollRAF() {
  await new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    } else {
      setTimeout(resolve, 50);
    }
  });
  await tick();
}

describe('App.svelte — ChannelModal create + cancel wires (v0.4.3 hotfix)', () => {
  beforeEach(() => {
    globalThis.__channelModalStoreInstances.length = 0;
  });

  it('Ctrl+N opens the ChannelModal (mounts the bits-ui Dialog content)', async () => {
    const { queryByTestId } = render(App);
    await tick();
    await flushChatViewScrollRAF();

    // Pre-shortcut: modal is closed.
    expect(queryByTestId('channel-modal-content')).toBeNull();

    // Dispatch the Ctrl+N keydown on the keyboard registry's window
    // listener (the registry binds via window.addEventListener so a
    // window-dispatched KeyboardEvent is the right way to invoke it).
    const evt = new KeyboardEvent('keydown', {
      key: 'n',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(evt);
    await tick();
    await flushChatViewScrollRAF();

    // Post-shortcut: modal mounted. bits-ui renders into a portal so
    // queryByTestId reaches into document.body.
    expect(document.querySelector('[data-testid="channel-modal-content"]')).not.toBeNull();
  });

  it('clicking the sidebar Create channel affordance also opens the modal', async () => {
    render(App);
    await tick();
    await flushChatViewScrollRAF();

    // Sidebar exposes the create-channel button. Its testid is
    // ``sidebar-create-channel`` (verified by reading
    // Sidebar.svelte's source — used by sidebar tests).
    const createBtn = document.querySelector('[data-testid="sidebar-create-channel"]');
    expect(createBtn).not.toBeNull();
    await fireEvent.click(createBtn);
    await tick();

    expect(document.querySelector('[data-testid="channel-modal-content"]')).not.toBeNull();
  });

  it('Create button fires store.createChannel(name, description) and closes the modal', async () => {
    render(App);
    await tick();
    await flushChatViewScrollRAF();
    const store = globalThis.__channelModalStoreInstances.at(-1);

    // Open the modal via Ctrl+N.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true }));
    await tick();

    // Fill in the name input and click Create.
    const nameInput = document.querySelector('[data-testid="channel-modal-name-input"]');
    expect(nameInput).not.toBeNull();
    await fireEvent.input(nameInput, { target: { value: 'phoenix' } });
    await tick();

    const createBtn = document.querySelector('[data-testid="channel-modal-create"]');
    expect(createBtn).not.toBeNull();
    expect(createBtn.disabled).toBe(false);
    await fireEvent.click(createBtn);
    await tick();
    await flushChatViewScrollRAF();

    expect(store.createChannel).toHaveBeenCalledTimes(1);
    // The wire calls createChannel(sanitizedName, description). Empty
    // description default carries through as ''.
    expect(store.createChannel).toHaveBeenCalledWith('phoenix', '');
    // After create, the modal is unmounted (showChannelModal flipped false).
    expect(document.querySelector('[data-testid="channel-modal-content"]')).toBeNull();
  });

  it('Cancel button closes the modal without firing store.createChannel', async () => {
    render(App);
    await tick();
    await flushChatViewScrollRAF();
    const store = globalThis.__channelModalStoreInstances.at(-1);

    // Open the modal.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true }));
    await tick();
    expect(document.querySelector('[data-testid="channel-modal-content"]')).not.toBeNull();

    const cancelBtn = document.querySelector('[data-testid="channel-modal-cancel"]');
    expect(cancelBtn).not.toBeNull();
    await fireEvent.click(cancelBtn);
    await tick();
    await flushChatViewScrollRAF();

    expect(store.createChannel).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="channel-modal-content"]')).toBeNull();
  });

  it('Escape closes the modal (App.svelte global-keydown cascade)', async () => {
    render(App);
    await tick();
    await flushChatViewScrollRAF();
    const store = globalThis.__channelModalStoreInstances.at(-1);

    // Open the modal.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true }));
    await tick();
    expect(document.querySelector('[data-testid="channel-modal-content"]')).not.toBeNull();

    // Dispatch Escape on the window. App.svelte's handleGlobalKeydown
    // sees showChannelModal=true and flips it false (the bits-ui
    // Dialog's own Escape handler does the same via onOpenChange; both
    // paths converge on the same close action).
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await tick();
    await flushChatViewScrollRAF();

    expect(store.createChannel).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="channel-modal-content"]')).toBeNull();
  });
});
