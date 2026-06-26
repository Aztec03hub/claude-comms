// Polish P1 (v0.4.2 Wave 0) — `markAllRead(channelId)` store method.
//
// The v0.4.0 Sidebar context menu's "Mark all as read" action was wired
// to a handler that short-circuited with a TODO because the store
// method didn't exist. `markAllRead` now closes that gap: it clears
// the per-channel ``unread`` counter, drops the mention-dot flag,
// stamps a ``lastReadAt`` cursor, drops the legacy v0.3.x first-unread
// pointer, persists the cleared markers, and fires a best-effort
// ``comms_check`` ack via ``mcpCall``.
//
// The MCP transport (`mcpCall`) and the bootstrap fetch (`apiGet`)
// are mocked so these specs run without a daemon. Pattern mirrors
// `tests/mqtt-store-channels.spec.js`.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted mocks for the api module. `apiGet` drives bootstrap;
// `mcpCall` is what `markAllRead` invokes for the server-side ack.
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

// Re-usable wire-row builder. Defaults match the Step 2.1 contract.
function row(overrides = {}) {
  return {
    id: 'general',
    name: 'general',
    topic: '',
    member: true,
    memberCount: 1,
    lastActivity: null,
    mode: 'public',
    visibility: 'listed',
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

beforeEach(() => {
  apiGetMock.mockReset();
  mcpCallMock.mockReset();
  // mcpCall returns a thenable so the store's `.catch` chain doesn't
  // throw a TypeError. Resolve to a benign success envelope.
  mcpCallMock.mockResolvedValue({ success: true });
  try {
    if (typeof localStorage !== 'undefined') localStorage.clear();
  } catch {
    /* jsdom may not provide localStorage in some environments */
  }
});

describe('MqttChatStore — Polish P1 markAllRead(channelId)', () => {
  it('clears the unread counter on the target channel', async () => {
    const store = new MqttChatStore();
    store.userProfile.key = '0123abcd';
    store.userProfile.name = 'test-user';
    store.userProfile.type = 'human';
    await bootstrapWith(store, [row({ id: 'general', myUnread: 7 })]);

    expect(store.channelsById.general.unread).toBe(7);

    store.markAllRead('general');

    expect(store.channelsById.general.unread).toBe(0);
  });

  it('clears the unreadHasMention flag on the target channel', async () => {
    const store = new MqttChatStore();
    store.userProfile.key = '0123abcd';
    store.userProfile.name = 'test-user';
    store.userProfile.type = 'human';
    await bootstrapWith(store, [
      row({ id: 'general', myUnread: 3, unreadHasMention: true }),
    ]);

    expect(store.channelsById.general.unreadHasMention).toBe(true);

    store.markAllRead('general');

    expect(store.channelsById.general.unreadHasMention).toBe(false);
  });

  it('updates lastReadAt to a recent ISO timestamp', async () => {
    const store = new MqttChatStore();
    store.userProfile.key = '0123abcd';
    store.userProfile.name = 'test-user';
    store.userProfile.type = 'human';
    await bootstrapWith(store, [row({ id: 'general', myUnread: 2 })]);

    const before = Date.now();
    store.markAllRead('general');
    const after = Date.now();

    const stamp = store.channelsById.general.lastReadAt;
    expect(typeof stamp).toBe('string');
    // ISO 8601 with millisecond precision, zulu suffix.
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const stampMs = Date.parse(stamp);
    expect(stampMs).toBeGreaterThanOrEqual(before);
    expect(stampMs).toBeLessThanOrEqual(after);
  });

  it('is a no-op when channelId is unknown', async () => {
    const store = new MqttChatStore();
    store.userProfile.key = '0123abcd';
    store.userProfile.name = 'test-user';
    store.userProfile.type = 'human';
    await bootstrapWith(store, [row({ id: 'general', myUnread: 4 })]);

    // Should not throw, should not affect existing channels.
    expect(() => store.markAllRead('does-not-exist')).not.toThrow();

    expect(store.channelsById.general.unread).toBe(4);
    // No mcpCall fires for the unknown-id path.
    expect(mcpCallMock).not.toHaveBeenCalled();
  });

  it('is a no-op when channelId is missing or empty', () => {
    const store = new MqttChatStore();
    store.userProfile.key = '0123abcd';
    store.userProfile.name = 'test-user';
    store.userProfile.type = 'human';

    expect(() => store.markAllRead()).not.toThrow();
    expect(() => store.markAllRead('')).not.toThrow();
    expect(() => store.markAllRead(null)).not.toThrow();
    expect(() => store.markAllRead(undefined)).not.toThrow();
    expect(mcpCallMock).not.toHaveBeenCalled();
  });

  it('fires a comms_check ack via mcpCall with the user key + channel id', async () => {
    const store = new MqttChatStore();
    store.userProfile.key = '0123abcd';
    store.userProfile.name = 'test-user';
    store.userProfile.type = 'human';
    await bootstrapWith(store, [row({ id: 'general', myUnread: 1 })]);

    store.markAllRead('general');

    expect(mcpCallMock).toHaveBeenCalledTimes(1);
    // Must pass `mark_seen: true` so the SERVER read cursor advances —
    // otherwise the next comms_check (reconnect / visibility-regain)
    // resurrects the unread + mention dot the user just cleared.
    expect(mcpCallMock).toHaveBeenCalledWith('comms_check', {
      key: '0123abcd',
      conversation: 'general',
      mark_seen: true,
    });
  });

  it('clears the legacy unreadFrom pointer so the unread divider re-anchors', async () => {
    const store = new MqttChatStore();
    store.userProfile.key = '0123abcd';
    store.userProfile.name = 'test-user';
    store.userProfile.type = 'human';
    await bootstrapWith(store, [
      row({ id: 'general', myUnread: 5, unreadFrom: 'msg-abc' }),
    ]);

    expect(store.channelsById.general.unreadFrom).toBe('msg-abc');

    store.markAllRead('general');

    expect(store.channelsById.general.unreadFrom).toBeNull();
  });

  it('swallows mcpCall rejections so the local state stays correct', async () => {
    // The server-side ack is best-effort. If the daemon is down or
    // the call rejects, markAllRead must not throw and the local
    // unread clear must stick.
    mcpCallMock.mockReset();
    mcpCallMock.mockRejectedValueOnce(new Error('daemon offline'));

    const store = new MqttChatStore();
    store.userProfile.key = '0123abcd';
    store.userProfile.name = 'test-user';
    store.userProfile.type = 'human';
    await bootstrapWith(store, [row({ id: 'general', myUnread: 2 })]);

    expect(() => store.markAllRead('general')).not.toThrow();
    expect(store.channelsById.general.unread).toBe(0);

    // Let the microtask queue flush so the rejection handler runs and
    // the test doesn't leak an unhandled-rejection warning.
    await Promise.resolve();
    await Promise.resolve();
  });
});
