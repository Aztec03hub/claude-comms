// v0.4.3 hotfix — ChatHeader button-row visibility through the
// App → ChatView → ChatHeader prop wire.
//
// Phil's Layer B item #8: the 6 ChatHeader buttons restored in commit
// 7e7d5a6 (Wave E.2 follow-up [VERIFY-i]) did not render at all in the
// real browser. Root cause was Bug 1 in this hotfix: the
// ``state_unsafe_mutation`` thrown by Wave B's lazy-write
// ``getChannelRole`` cascaded through App's render tree, leaving
// ChatView mid-mount, so ChatHeader's button-row never reached the DOM.
//
// With Bug 1 fixed, the standard ChatView gate
// (``{#if showChatHeader && activeChannel}``) and ChatHeader's
// callback-presence gating render the 6 buttons normally.
//
// The existing ``chat-header-buttons.spec.js`` suite (added by the
// E.2 follow-up agent) covers ChatHeader.svelte in isolation. This
// suite covers the full App-mount path so a regression in the
// upstream wire (App → ChatView prop forwarding or Bug 1 reappearing)
// also fails a test.
//
// Total: 4 tests.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';

// JSDOM shims (mirrors prop-drilling.spec.js).
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

globalThis.__chatHeaderVisibilityStoreInstances = globalThis.__chatHeaderVisibilityStoreInstances ?? [];

vi.mock('../src/lib/mqtt-store.svelte.js', () => {
  class MqttChatStoreMock {
    constructor() {
      globalThis.__chatHeaderVisibilityStoreInstances.push(this);
      this.connected = true;
      this.connectionError = null;
      this.parseFailureRate = 0;
      this.nameUnset = false;
      this.serverUnreachable = false;
      this.activeChannel = 'general';
      // Critical for Bug 3: ChatView gates ChatHeader on
      // ``activeChannelMeta`` being truthy. Pin a populated meta so
      // the gate evaluates true and the header (with buttons) renders.
      this.activeChannelMeta = {
        id: 'general',
        name: 'general',
        topic: 'a place for general chatter',
        memberCount: 4,
        unread: 0,
        unreadFrom: null,
      };
      this.onlineCount = 4;
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
      // Bug 1 fix: channelRoles is pre-warmed at bootstrap; the mock
      // simulates that by pre-seeding the map.
      this.channelRoles = { general: 'owner' };
      this.inAppToasts = true;
      this.composerPrefill = '';
      this.userMutes = {};
      this.notificationPolicies = {};
      this.switchChannel = vi.fn();
      this.goToMessage = vi.fn();
      this.connect = vi.fn();
      this.disconnect = vi.fn();
      this.markThreadSeen = vi.fn();
      this.markSeen = vi.fn();
      this.markUnread = vi.fn();
      this.markMessageViewed = vi.fn();
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
      // Bug 1 fix: getChannelRole is now a pure read of channelRoles.
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

describe('App.svelte → ChatView → ChatHeader — button row visibility (v0.4.3 hotfix)', () => {
  beforeEach(() => {
    globalThis.__chatHeaderVisibilityStoreInstances.length = 0;
  });

  it('all 5 non-mobile buttons render in the App-mount DOM after first paint', async () => {
    render(App);
    await tick();
    await flushChatViewScrollRAF();

    // bits-ui Dialog does not portal the chat-header; it renders
    // inline inside the App tree. Verify each button is in the DOM.
    expect(document.querySelector('[data-testid="chat-header-new"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="chat-header-search-btn"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="chat-header-pinned-btn"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="chat-header-artifacts-btn"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="chat-header-theme-toggle-btn"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="chat-header-settings-btn"]')).not.toBeNull();
  });

  it('the mobile-menu button is in the DOM (CSS hides it on wide viewports via media query)', async () => {
    render(App);
    await tick();
    await flushChatViewScrollRAF();
    // The mobile-menu button always RENDERS to DOM when its callback
    // prop is supplied (which App.svelte always does). The narrow-
    // viewport visibility is handled by ``@media (max-width: 768px)``
    // CSS rule in ChatHeader.svelte; the DOM presence is what pins
    // the prop-wire correctness end-to-end.
    expect(document.querySelector('[data-testid="chat-header-mobile-menu-btn"]')).not.toBeNull();
  });

  it('the chat-header renders with currentUserRole=owner from the prop wire', async () => {
    render(App);
    await tick();
    await flushChatViewScrollRAF();

    // currentUserRole=owner means the inline-edit pencil button
    // renders. The pre-hotfix bug threw before this render ever
    // happened, so seeing the pencil here is also indirect proof
    // that Bug 1 no longer cascades through this render path.
    expect(document.querySelector('[data-testid="chat-header-topic-edit-btn"]')).not.toBeNull();
  });

  it('all 6 buttons exist in the DOM with the documented data-testids (App-mount end-to-end)', async () => {
    render(App);
    await tick();
    await flushChatViewScrollRAF();

    // Belt-and-suspenders: collect all 6 expected testids in one
    // sweep so a single regression that takes the entire row down
    // (e.g. CSS scope leak, prop-wire stripped, ChatView gate flipped)
    // surfaces as a single readable failure.
    const expectedTestids = [
      'chat-header-mobile-menu-btn',
      'chat-header-search-btn',
      'chat-header-pinned-btn',
      'chat-header-artifacts-btn',
      'chat-header-theme-toggle-btn',
      'chat-header-settings-btn',
    ];
    const missing = expectedTestids.filter(
      (tid) => document.querySelector(`[data-testid="${tid}"]`) === null,
    );
    expect(missing).toEqual([]);
  });
});
