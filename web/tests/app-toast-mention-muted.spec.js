// v0.4.2 Step 3.9 (Wave G) — App.svelte toast handler [VERIFY-WAVE-G-1] fix.
//
// What this file pins
// ───────────────────
// The Design Spec §8.2 invariant for the in-app toast surface:
//   - A mention message on a muted channel STILL surfaces a toast
//     (mute reduces opacity + suppresses ordinary toasts, but never
//     squashes a mention — the user opted into mention-only alerts
//     when they muted).
//   - A highlight-word match (Q7) on a muted channel ALSO surfaces a
//     toast (it's a user-opted-in "you want to know about this"
//     signal, same semantics as @mention).
//   - The per-channel notification policy (Step 3.9):
//       'Off'      → never toast for this channel.
//       'Mentions' → toast only when @mention OR highlight-word hit.
//       'All'      → toast on every message.
//   - The legacy ``ch.muted`` flag suppresses ORDINARY toasts but
//     never blocks a mention.
//
// Pre-Wave-G bug: App.svelte:479 short-circuited the toast on
// ``ch && ch.muted`` regardless of mention status, dropping the
// mention-on-muted toast on the floor. The Wave G edit replaces that
// guard with a policy-aware decision tree that bypasses muted-
// suppression on mentions/highlight-hits.
//
// What we exercise
// ────────────────
//   1. mention + muted: toast IS fired (the bug fix).
//   2. ordinary + muted (no mention, no highlight): toast is NOT fired.
//   3. policy='Off': never toasts, regardless of mention/muted state.
//   4. policy='All': toasts on every message, regardless of muted.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';

// JSDOM polyfills mirroring the toast-improvements spec; App.svelte
// transitively pulls in ChatView (IntersectionObserver) and
// MessageInput (ResizeObserver).
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

// ── MqttChatStore mock ────────────────────────────────────────────
//
// We need fine-grained control over ``store.messages`` (to feed a
// specific last-message into App's notification $effect) AND over
// ``store.getNotificationPolicy`` (to drive the policy branch). The
// existing toast-improvements spec already proved this mock pattern
// works at scale; we extend it minimally with the Wave G accessor
// surfaces. ``store.messages`` is set BEFORE mount so the $effect
// reads the seeded value on its first run.

globalThis.__mockStoreInstances = globalThis.__mockStoreInstances || [];
// v0.4.2 Step 3.9 (Wave G) test seed slot. Set BEFORE ``render(App)``
// so the mocked store's constructor seeds ``messages`` + ``channels``
// + ``__policyByChannelId`` to the desired pre-mount state. App's
// notification $effect reads ``store.messages`` on its first run, so
// the seeded last-message exercises the toast decision tree
// immediately without any post-render reassignment dance.
globalThis.__toastTestSeed = globalThis.__toastTestSeed || {
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
      this.activeChannel = globalThis.__toastTestSeed.activeChannel || 'other';
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
      // Seeded from the per-test slot so App's $effect sees the
      // chosen last-message on its first run.
      this.messages = globalThis.__toastTestSeed.messages || [];
      this.channels = globalThis.__toastTestSeed.channels || [
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
      // Policy + cycle accessors per Step 3.9 (Wave G) contract.
      // Seeded from the per-test slot; ``getNotificationPolicy``
      // reads from this map.
      this.__policyByChannelId = {
        ...(globalThis.__toastTestSeed.policyByChannel || {}),
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
      // Method spies for surfaces App may touch on mount.
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

vi.mock('../src/lib/notifications.svelte.js', () => ({
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

const App = (await import('../src/App.svelte')).default;

beforeEach(() => {
  globalThis.__mockStoreInstances.length = 0;
  globalThis.__toastTestSeed = {
    messages: [],
    channels: [{ id: 'general', muted: false }],
    policyByChannel: {},
    activeChannel: 'other',
  };
  // Force the "off-channel-or-hidden" guard branch so the toast
  // decision logic runs even when message.channel === activeChannel.
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => true,
  });
});

afterEach(() => {
  cleanup();
});

/**
 * Seed the next-constructed store + render App. Because App's
 * notification $effect reads ``store.messages`` on its first run
 * and the mocked store's ``messages`` field is plain (not $state),
 * we must seed the data BEFORE the constructor runs — at render
 * time. Tests populate ``globalThis.__toastTestSeed`` via this
 * helper, then render() triggers the mocked constructor which copies
 * the seed into the new instance.
 */
async function renderAndPushMessage({ message, policyByChannel, channels }) {
  globalThis.__toastTestSeed.messages = [message];
  if (channels) globalThis.__toastTestSeed.channels = channels;
  if (policyByChannel)
    globalThis.__toastTestSeed.policyByChannel = policyByChannel;
  const ui = render(App);
  await tick();
  await tick();
  const store = globalThis.__mockStoreInstances.at(-1);
  expect(store).toBeDefined();
  return { ui, store };
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

describe('App.svelte — Step 3.9 (Wave G) toast handler mention-on-muted fix', () => {
  it('mention + muted: toast IS fired (the [VERIFY-WAVE-G-1] bug fix)', async () => {
    const { ui } = await renderAndPushMessage({
      message: makeMessage({
        body: 'heads up @me',
        mentions: ['me-key'],
      }),
      channels: [{ id: 'general', muted: true }],
      policyByChannel: { general: { policy: 'Mentions', highlightWords: [] } },
    });
    const toasts = ui.queryAllByTestId('toast');
    // Pre-Wave-G this was 0 (mute squashed the mention). Post-fix
    // it's at least 1.
    expect(toasts.length).toBeGreaterThanOrEqual(1);
  });

  it('ordinary + muted (no mention, no highlight): toast is NOT fired', async () => {
    const { ui } = await renderAndPushMessage({
      message: makeMessage({
        body: 'just a normal message',
        mentions: null,
      }),
      channels: [{ id: 'general', muted: true }],
      policyByChannel: { general: { policy: 'All', highlightWords: [] } },
    });
    const toasts = ui.queryAllByTestId('toast');
    // muted + ordinary → mute should still suppress per the original
    // contract; the bug fix only bypasses muted-suppression for
    // mention/highlight hits.
    expect(toasts.length).toBe(0);
  });

  it('policy="Off": never toasts, even for an @mention', async () => {
    const { ui } = await renderAndPushMessage({
      message: makeMessage({
        body: 'heads up @me',
        mentions: ['me-key'],
      }),
      channels: [{ id: 'general', muted: false }],
      policyByChannel: { general: { policy: 'Off', highlightWords: [] } },
    });
    const toasts = ui.queryAllByTestId('toast');
    // Off is the user's explicit "shut up" — wins over mention.
    expect(toasts.length).toBe(0);
  });

  it('policy="All": toasts on an ordinary unmuted message', async () => {
    const { ui } = await renderAndPushMessage({
      message: makeMessage({
        body: 'morning everyone',
        mentions: null,
      }),
      channels: [{ id: 'general', muted: false }],
      policyByChannel: { general: { policy: 'All', highlightWords: [] } },
    });
    const toasts = ui.queryAllByTestId('toast');
    expect(toasts.length).toBeGreaterThanOrEqual(1);
  });

  it('highlight-word match + muted: toast IS fired (Q7 bypass parallels mention)', async () => {
    const { ui } = await renderAndPushMessage({
      message: makeMessage({
        body: 'PRODUCTION RELEASE is happening now',
        mentions: null,
      }),
      channels: [{ id: 'general', muted: true }],
      policyByChannel: {
        general: { policy: 'Mentions', highlightWords: ['release'] },
      },
    });
    const toasts = ui.queryAllByTestId('toast');
    // Highlight-word hit short-circuits the muted-suppression branch
    // identically to an @mention (the Q7 invariant).
    expect(toasts.length).toBeGreaterThanOrEqual(1);
  });
});
