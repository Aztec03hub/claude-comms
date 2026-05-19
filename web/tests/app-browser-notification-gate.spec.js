// v0.4.2 Wave G follow-up [VERIFY-WAVE-G-4-FOLLOWUP]. App.svelte's
// call to ``sendNotification(...)`` now forwards the full
// (channel, mentions, userKey, muted) context tuple so the browser
// Notification policy gate in ``notifications.svelte.js`` (Wave G
// landed the infrastructure on 6e8c8c9) can apply the full Mentions-
// only suppression + muted-bypass-on-mention rules end-to-end.
//
// What this file pins
// -------------------
// 1. policy='Off' on the channel suppresses the browser Notification
//    (sendNotification still gets called but the gate returns null).
// 2. policy='Mentions' fires the Notification on an @mention but NOT
//    on an ordinary message.
// 3. policy='All' + muted=true + non-mention: the mute legacy flag
//    suppresses the Notification.
// 4. policy='All' + muted=true + @mention: the mention bypasses the
//    mute legacy flag and the Notification fires (the Wave G fix).
//
// How the assertions work
// -----------------------
// We mock ``sendNotification`` so we can inspect its received options
// directly. App.svelte builds the options object using the real
// channel + mentions + muted values from the store, so checking
// those args is equivalent to checking the gate's input. We then
// hand the same (policy, options) tuple to the real
// ``shouldNotifyForPolicy`` to compute the expected gate verdict.
// This decouples the App-level forwarding (what THIS test owns) from
// the gate's decision math (covered by notifications-policy-gate.spec.js).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';

// JSDOM polyfills mirroring app-toast-mention-muted.spec.js so App.svelte's
// transitive component tree (ChatView IntersectionObserver, MessageInput
// ResizeObserver, notifications module Notification probe) mounts cleanly.
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

globalThis.__mockStoreInstances = globalThis.__mockStoreInstances || [];
globalThis.__gateTestSeed = globalThis.__gateTestSeed || {
  messages: [],
  channels: [{ id: 'general', muted: false }],
  policyByChannel: {},
  activeChannel: 'other',
};

vi.mock('../src/lib/mqtt-store.svelte.js', () => {
  class MqttChatStoreMock {
    constructor() {
      this.connected = true;
      this.connectionError = null;
      this.parseFailureRate = 0;
      this.nameUnset = false;
      this.activeChannel = globalThis.__gateTestSeed.activeChannel || 'other';
      this.activeChannelMeta = { topic: '' };
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
      this.messages = globalThis.__gateTestSeed.messages || [];
      this.channels = globalThis.__gateTestSeed.channels || [
        { id: 'general', muted: false },
      ];
      this.starredChannels = [];
      this.participants = {};
      this.channelMembers = {};
      this.inAppToasts = true;
      this.composerPrefill = '';
      this.notificationPolicies = {};
      this.archivedChannelsCount = 0;
      this.banner = null;
      this.unreadElsewhere = 0;
      this.bootstrapFailed = false;
      this.daemonReachable = true;
      this.lastReadAtByChannel = {};
      this.artifactsDirty = 0;
      this.latestArtifactRefNotification = null;
      this.parseFailures = [];
      this.threadParentMessageId = null;
      this.__policyByChannelId = {
        ...(globalThis.__gateTestSeed.policyByChannel || {}),
      };
      this.getNotificationPolicy = vi.fn((id) => {
        return (
          this.__policyByChannelId[id] || { policy: 'All', highlightWords: [] }
        );
      });
      this.setNotificationPolicy = vi.fn((id, policy, words) => {
        this.__policyByChannelId[id] = {
          policy,
          highlightWords: Array.isArray(words) ? words : [],
        };
        return { success: true };
      });
      this.cycleNotificationPolicy = vi.fn(() => 'Mentions');
      this.connect = vi.fn();
      this.disconnect = vi.fn();
      this.switchChannel = vi.fn();
      this.goToMessage = vi.fn();
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
      this.getMemberConversations = vi.fn(() => []);
      this.notifyTyping = vi.fn();
      this.sendMessage = vi.fn();
      this.editMessage = vi.fn();
      this.isUserGloballyMuted = vi.fn(() => false);
      this.muteUserGlobally = vi.fn();
      this.unmuteUserGlobally = vi.fn();
      this.startDM = vi.fn();
      this.kickMember = vi.fn();
      this.inviteParticipant = vi.fn();
      this.setMute = vi.fn();
      this.setStar = vi.fn();
      this.markAllRead = vi.fn();
      this.renameChannel = vi.fn();
      this.setTopic = vi.fn();
      this.leaveChannel = vi.fn();
      this.deleteChannel = vi.fn();
      this.archiveChannel = vi.fn();
      this.setProfileStatus = vi.fn();
      this.clearProfileStatus = vi.fn();
      globalThis.__mockStoreInstances.push(this);
    }
  }
  return { MqttChatStore: MqttChatStoreMock };
});

// Spy on sendNotification so we can introspect the options App.svelte
// passes. We don't stub it with vi.fn() blank because the real
// shouldNotifyForPolicy helper is what we run on the captured options
// to compute the expected gate verdict.
const sendNotificationSpy = vi.fn(() => null);
vi.mock('../src/lib/notifications.svelte.js', async () => {
  const actual = await vi.importActual('../src/lib/notifications.svelte.js');
  return {
    ...actual,
    requestPermission: vi.fn(),
    sendNotification: sendNotificationSpy,
  };
});

const { shouldNotifyForPolicy } = await import('../src/lib/notifications.svelte.js');
const App = (await import('../src/App.svelte')).default;

beforeEach(() => {
  globalThis.__mockStoreInstances.length = 0;
  globalThis.__gateTestSeed = {
    messages: [],
    channels: [{ id: 'general', muted: false }],
    policyByChannel: {},
    activeChannel: 'other',
  };
  sendNotificationSpy.mockClear();
  // Force the off-channel-or-hidden branch so App's notification
  // $effect actually invokes sendNotification.
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => true,
  });
});

afterEach(() => {
  cleanup();
});

async function renderAndPushMessage({ message, policyByChannel, channels }) {
  globalThis.__gateTestSeed.messages = [message];
  if (channels) globalThis.__gateTestSeed.channels = channels;
  if (policyByChannel)
    globalThis.__gateTestSeed.policyByChannel = policyByChannel;
  const ui = render(App);
  await tick();
  await tick();
  return { ui };
}

function makeMessage(overrides = {}) {
  return {
    id: 'm-' + Math.random().toString(16).slice(2, 10),
    ts: new Date().toISOString(),
    sender: { key: 'them-key', name: 'them', type: 'human' },
    body: 'hi',
    channel: 'general',
    mentions: null,
    ...overrides,
  };
}

/**
 * Pull the (channel, mentions, userKey, muted) tuple App.svelte
 * forwarded to sendNotification and feed it through the real gate
 * to compute the expected fire/suppress verdict. This is the
 * end-to-end assertion: App passes the right context AND the gate
 * agrees on the result.
 */
function gateVerdictForLastCall(policy) {
  expect(sendNotificationSpy).toHaveBeenCalledTimes(1);
  const [, options] = sendNotificationSpy.mock.calls[0];
  return {
    options,
    shouldFire: shouldNotifyForPolicy(policy, {
      mentions: options.mentions,
      userKey: options.userKey,
      muted: options.muted === true,
      body: options.body,
    }),
  };
}

describe('App.svelte - [VERIFY-WAVE-G-4-FOLLOWUP] sendNotification forwards channel/mentions/userKey/muted', () => {
  it('policy="Off" on channel: sendNotification args feed a gate verdict of suppress', async () => {
    const policy = { policy: 'Off', highlightWords: [] };
    await renderAndPushMessage({
      message: makeMessage({
        body: 'heads up @me',
        mentions: ['me-key'],
      }),
      channels: [{ id: 'general', muted: false }],
      policyByChannel: { general: policy },
    });
    const { options, shouldFire } = gateVerdictForLastCall(policy);
    // Forwarding sanity: App passed the channel + mention + userKey
    // so the gate has full context to apply policy=Off.
    expect(options.channel).toBe('general');
    expect(options.mentions).toEqual(['me-key']);
    expect(options.userKey).toBe('me-key');
    expect(options.muted).toBe(false);
    expect(shouldFire).toBe(false);
  });

  it('policy="Mentions": @mention message triggers a fire verdict from the gate', async () => {
    const policy = { policy: 'Mentions', highlightWords: [] };
    await renderAndPushMessage({
      message: makeMessage({
        body: 'pinging @me',
        mentions: ['me-key'],
      }),
      channels: [{ id: 'general', muted: false }],
      policyByChannel: { general: policy },
    });
    const { options, shouldFire } = gateVerdictForLastCall(policy);
    expect(options.mentions).toEqual(['me-key']);
    expect(options.userKey).toBe('me-key');
    expect(shouldFire).toBe(true);
  });

  it('policy="All" + muted + non-mention: gate suppresses (legacy mute still wins for ordinary messages)', async () => {
    const policy = { policy: 'All', highlightWords: [] };
    await renderAndPushMessage({
      message: makeMessage({
        body: 'just chatting',
        mentions: null,
      }),
      channels: [{ id: 'general', muted: true }],
      policyByChannel: { general: policy },
    });
    const { options, shouldFire } = gateVerdictForLastCall(policy);
    expect(options.channel).toBe('general');
    // App correctly reflected the channel's muted=true flag into the
    // forwarded options so the gate's muted-bypass branch can decide.
    expect(options.muted).toBe(true);
    expect(shouldFire).toBe(false);
  });

  it('policy="All" + muted + @mention: gate fires (mention bypasses mute, the Wave G bug fix)', async () => {
    const policy = { policy: 'All', highlightWords: [] };
    await renderAndPushMessage({
      message: makeMessage({
        body: 'heads up @me',
        mentions: ['me-key'],
      }),
      channels: [{ id: 'general', muted: true }],
      policyByChannel: { general: policy },
    });
    const { options, shouldFire } = gateVerdictForLastCall(policy);
    // The critical forwarding assertions: both muted=true AND the
    // mention list with the receiving user's key are present, so the
    // gate can apply the mention-bypasses-mute rule end-to-end.
    expect(options.muted).toBe(true);
    expect(options.mentions).toEqual(['me-key']);
    expect(options.userKey).toBe('me-key');
    expect(shouldFire).toBe(true);
  });
});
