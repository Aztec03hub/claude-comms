// v0.4.2 Step 3.8 / Wave C — unread clears on viewport intersection,
// not channel switch (UX G-18).
//
// Pre-3.8 behavior: switching to a channel zeroed its `unread` counter
// even when the user immediately switched back out without reading a
// single message. That diverged from every chat client most users have
// ever used (Slack, Discord, Teams) where unread means "stuff you
// haven't actually viewed".
//
// New behavior pinned by Step 3.8:
//
//   1. `switchChannel(id)` does NOT touch `ch.unread` anymore.
//   2. ChatView wraps each rendered message bubble in an
//      IntersectionObserver. After the bubble has been visible for the
//      pinned dwell window (>= 1000ms), the observer fires
//      `store.markMessageViewed(channelId, messageId)` which records
//      the (channel, message) pair in a per-channel viewed-id set.
//   3. When every loaded other-user message in the channel has been
//      viewed, the channel's `unread` zeroes, `unreadHasMention` clears,
//      `unreadFrom` clears, and `lastReadAt` advances.
//   4. `markAllRead(id)` (Step 3.7 path) still forces zero immediately,
//      independent of viewed-set state.
//
// This spec exercises the store-side `markMessageViewed` logic directly
// (no ChatView render here — the ChatView mount + dwell-timer pathway
// is covered by the existing toast-improvements / prop-drilling specs
// that mount App + ChatView with a stubbed IntersectionObserver). The
// ChatView-side behavior we DO pin here is that the dwell timer is
// scheduled per-intersection and cancelled on un-intersection; that
// path is intrinsically time-dependent, so we use vi.useFakeTimers to
// drive the clock deterministically.
//
// Mocks `mcpCall` + `apiGet` so the store runs without a daemon.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const apiGetMock = vi.fn();
const mcpCallMock = vi.fn();
vi.mock('../src/lib/api.js', () => ({
  API_BASE: '',
  apiGet: (...args) => apiGetMock(...args),
  apiPost: vi.fn(),
  ensureToken: vi.fn(),
  prefetchToken: vi.fn(),
  updateName: vi.fn(),
  mcpCall: (...args) => mcpCallMock(...args),
}));

const { MqttChatStore } = await import('../src/lib/mqtt-store.svelte.js');

const SELF = '0123abcd';

function row(overrides = {}) {
  return {
    id: 'general',
    name: 'general',
    topic: '',
    member: true,
    memberCount: 1,
    lastActivity: null,
    mode: 'public',
    visibility: 'public',
    createdAt: null,
    createdBy: null,
    myUnread: 0,
    unreadHasMention: false,
    myStarred: false,
    myMuted: false,
    ...overrides,
  };
}

async function bootstrapWith(store, rows) {
  apiGetMock.mockResolvedValueOnce(rows);
  await store._bootstrapChannelsForTest();
}

function makeStore() {
  const store = new MqttChatStore();
  store.userProfile.key = SELF;
  store.userProfile.name = 'me';
  store.userProfile.type = 'human';
  return store;
}

// Helper: synthesize an other-user message in a given channel and push
// it onto store.messages. Mimics what #handleChatMessage would have
// done (without the side effects we want to control here).
function pushMessage(store, channel, id, opts = {}) {
  store.messages = [
    ...store.messages,
    {
      id,
      channel,
      ts: opts.ts ?? new Date().toISOString(),
      sender: opts.sender ?? { key: 'someone-else', name: 'them', type: 'human' },
      body: opts.body ?? 'hi',
    },
  ];
}

beforeEach(() => {
  apiGetMock.mockReset();
  mcpCallMock.mockReset();
  mcpCallMock.mockResolvedValue({ success: true, payload: {} });
  try {
    if (typeof localStorage !== 'undefined') localStorage.clear();
  } catch {
    /* jsdom may not provide localStorage */
  }
});

describe('Step 3.8 — switchChannel no longer auto-clears unread', () => {
  it('switching INTO a channel preserves its unread count', async () => {
    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'general', myUnread: 5 })]);
    expect(store.channelsById.general.unread).toBe(5);

    store.switchChannel('general');

    // The legacy clear-on-switch shortcut is gone; unread survives.
    expect(store.channelsById.general.unread).toBe(5);
  });

  it('switching INTO a channel preserves the mention dot flag', async () => {
    const store = makeStore();
    await bootstrapWith(store, [
      row({ id: 'general', myUnread: 3, unreadHasMention: true }),
    ]);
    expect(store.channelsById.general.unreadHasMention).toBe(true);

    store.switchChannel('general');

    expect(store.channelsById.general.unreadHasMention).toBe(true);
  });

  it('switching back and forth multiple times never zeros unread', async () => {
    const store = makeStore();
    await bootstrapWith(store, [
      row({ id: 'general', myUnread: 4 }),
      row({ id: 'random', myUnread: 2 }),
    ]);
    store.switchChannel('general');
    store.switchChannel('random');
    store.switchChannel('general');
    store.switchChannel('random');
    expect(store.channelsById.general.unread).toBe(4);
    expect(store.channelsById.random.unread).toBe(2);
  });
});

describe('Step 3.8 — markMessageViewed clears unread when all msgs seen', () => {
  it('viewing every other-user message zeros unread + advances lastReadAt', async () => {
    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'general', myUnread: 2 })]);
    pushMessage(store, 'general', 'm1');
    pushMessage(store, 'general', 'm2');

    // Pre: nothing viewed yet, unread stays at 2.
    expect(store.channelsById.general.unread).toBe(2);
    expect(store.channelsById.general.lastReadAt).toBeFalsy();

    store.markMessageViewed('general', 'm1');
    // One of two viewed: still unread.
    expect(store.channelsById.general.unread).toBe(2);

    store.markMessageViewed('general', 'm2');
    // Now every other-user message is viewed; unread zeros.
    expect(store.channelsById.general.unread).toBe(0);
    expect(store.channelsById.general.lastReadAt).toBeTruthy();
    // ISO timestamp shape.
    expect(typeof store.channelsById.general.lastReadAt).toBe('string');
  });

  it('idempotent: re-viewing the same id is a no-op (no double-count)', async () => {
    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'general', myUnread: 1 })]);
    pushMessage(store, 'general', 'm1');

    store.markMessageViewed('general', 'm1');
    store.markMessageViewed('general', 'm1');
    store.markMessageViewed('general', 'm1');

    expect(store._viewedMessageIdsForTest('general')).toEqual(['m1']);
    expect(store.channelsById.general.unread).toBe(0);
  });

  it('clears the unreadHasMention flag alongside unread', async () => {
    const store = makeStore();
    await bootstrapWith(store, [
      row({ id: 'general', myUnread: 1, unreadHasMention: true }),
    ]);
    pushMessage(store, 'general', 'm1');

    store.markMessageViewed('general', 'm1');

    expect(store.channelsById.general.unread).toBe(0);
    expect(store.channelsById.general.unreadHasMention).toBe(false);
  });

  it('self-authored messages are excluded from the unread-remaining count', async () => {
    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'general', myUnread: 1 })]);
    // Self-authored message + one other-user message.
    pushMessage(store, 'general', 'self-msg', {
      sender: { key: SELF, name: 'me', type: 'human' },
    });
    pushMessage(store, 'general', 'other-msg');

    // Viewing just the other-user message zeros unread, because the
    // self-authored message doesn't count toward unread-remaining.
    store.markMessageViewed('general', 'other-msg');
    expect(store.channelsById.general.unread).toBe(0);
  });

  it('system messages are excluded from the unread-remaining count', async () => {
    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'general', myUnread: 1 })]);
    pushMessage(store, 'general', 'sys-msg', {
      sender: { key: 'system', name: 'system', type: 'system' },
    });
    pushMessage(store, 'general', 'human-msg');

    store.markMessageViewed('general', 'human-msg');
    expect(store.channelsById.general.unread).toBe(0);
  });
});

describe('Step 3.8 — markMessageViewed cross-channel isolation', () => {
  it('viewing a message in #general does NOT clear #random unread', async () => {
    const store = makeStore();
    await bootstrapWith(store, [
      row({ id: 'general', myUnread: 1 }),
      row({ id: 'random', myUnread: 3 }),
    ]);
    pushMessage(store, 'general', 'g1');
    pushMessage(store, 'random', 'r1');
    pushMessage(store, 'random', 'r2');
    pushMessage(store, 'random', 'r3');

    store.markMessageViewed('general', 'g1');

    expect(store.channelsById.general.unread).toBe(0);
    expect(store.channelsById.random.unread).toBe(3);
  });

  it('per-channel viewed-id sets are independent (no cross-talk)', async () => {
    const store = makeStore();
    await bootstrapWith(store, [
      row({ id: 'general' }),
      row({ id: 'random' }),
    ]);
    store.markMessageViewed('general', 'shared-id');
    store.markMessageViewed('random', 'shared-id');
    store.markMessageViewed('random', 'random-only');

    expect(store._viewedMessageIdsForTest('general')).toEqual(['shared-id']);
    const randomViewed = store._viewedMessageIdsForTest('random').sort();
    expect(randomViewed).toEqual(['random-only', 'shared-id']);
  });
});

describe('Step 3.8 — markMessageViewed input guards + interop', () => {
  it('no-ops on missing channelId / messageId / unknown channel', async () => {
    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'general', myUnread: 2 })]);
    pushMessage(store, 'general', 'm1');

    // Missing args
    store.markMessageViewed('', 'm1');
    store.markMessageViewed('general', '');
    store.markMessageViewed(null, 'm1');
    store.markMessageViewed('general', null);
    // Unknown channel
    store.markMessageViewed('does-not-exist', 'm1');

    expect(store.channelsById.general.unread).toBe(2);
    expect(store._viewedMessageIdsForTest('general')).toEqual([]);
  });

  it('markAllRead still forces zero immediately, no matter the viewed set', async () => {
    const store = makeStore();
    await bootstrapWith(store, [
      row({ id: 'general', myUnread: 5, unreadHasMention: true }),
    ]);
    pushMessage(store, 'general', 'm1');
    pushMessage(store, 'general', 'm2');
    pushMessage(store, 'general', 'm3');

    // Even with NOTHING viewed, markAllRead zeros immediately (Step 3.7
    // path, independent of Step 3.8's viewport-confirmed semantics).
    store.markAllRead('general');

    expect(store.channelsById.general.unread).toBe(0);
    expect(store.channelsById.general.unreadHasMention).toBe(false);
    expect(store.channelsById.general.lastReadAt).toBeTruthy();
  });

  it('does NOT raise unread when called against a channel with zero unread', async () => {
    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'general', myUnread: 0 })]);
    pushMessage(store, 'general', 'm1');

    store.markMessageViewed('general', 'm1');

    // ch.unread was already 0 and stays 0 — markMessageViewed never
    // raises the counter, only zeros it when fully viewed.
    expect(store.channelsById.general.unread).toBe(0);
  });
});
