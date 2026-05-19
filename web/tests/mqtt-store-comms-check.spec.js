// v0.4.2 Step 3.6: `comms_check` on connect + visibility-regain
// (UX G-10, G-11).
//
// When the MQTT client connects (initial OR reconnect), the store
// must fetch authoritative unread state from the daemon via a
// single `comms_check` MCP call (no `conversation` arg → server
// scans every joined conversation). The response's `unread_summary`
// hydrates `channels[id].unread`, `channels[id].lastActivity`, and
// `channels[id].unreadHasMention`.
//
// On `document.visibilitychange` → `visible` the store re-fires the
// same call, subject to a 30s throttle so a user thrashing browser
// focus doesn't hammer the daemon.
//
// `mcpCall` + `apiGet` are mocked so these specs run without a daemon.
// The `_simulateVisibilityRegainForTest` + `_setLastCommsCheckAtForTest`
// seams drive the throttle gate without a jsdom dispatch.

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

function makeStore() {
  const store = new MqttChatStore();
  store.userProfile.key = '0123abcd';
  store.userProfile.name = 'test-user';
  store.userProfile.type = 'human';
  return store;
}

beforeEach(() => {
  apiGetMock.mockReset();
  mcpCallMock.mockReset();
  mcpCallMock.mockResolvedValue({ success: true, payload: { unread_summary: [] } });
});

describe('MqttChatStore Step 3.6 checkChannels()', () => {
  it('issues a single comms_check call with no conversation arg', async () => {
    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'general' })]);
    mcpCallMock.mockReset();
    mcpCallMock.mockResolvedValueOnce({
      success: true,
      payload: { unread_summary: [] },
    });

    await store.checkChannels();

    expect(mcpCallMock).toHaveBeenCalledTimes(1);
    expect(mcpCallMock).toHaveBeenCalledWith('comms_check', {
      key: '0123abcd',
    });
  });

  it('hydrates unread + lastActivity from the unread_summary response', async () => {
    mcpCallMock.mockResolvedValueOnce({
      success: true,
      payload: {
        unread_summary: [
          {
            conversation: 'general',
            unread_count: 5,
            latest: { ts: '2026-05-18T20:00:00.000Z' },
          },
          {
            conversation: 'random',
            unread_count: 2,
            latest: { ts: '2026-05-18T20:01:00.000Z' },
          },
        ],
      },
    });

    const store = makeStore();
    await bootstrapWith(store, [
      row({ id: 'general' }),
      row({ id: 'random' }),
    ]);

    await store.checkChannels();

    expect(store.channelsById.general.unread).toBe(5);
    expect(store.channelsById.general.lastActivity).toBe('2026-05-18T20:00:00.000Z');
    expect(store.channelsById.random.unread).toBe(2);
    expect(store.channelsById.random.lastActivity).toBe('2026-05-18T20:01:00.000Z');
  });

  it('sets unreadHasMention when the latest message mentions the caller', async () => {
    mcpCallMock.mockResolvedValueOnce({
      success: true,
      payload: {
        unread_summary: [
          {
            conversation: 'general',
            unread_count: 1,
            latest: {
              ts: '2026-05-18T20:00:00.000Z',
              mentions: ['0123abcd', 'someone-else'],
            },
          },
        ],
      },
    });

    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'general' })]);

    await store.checkChannels();

    expect(store.channelsById.general.unreadHasMention).toBe(true);
  });

  it('zeroes unread on joined channels NOT present in the server summary', async () => {
    // Server says only "general" has unread; "random" should be zeroed.
    mcpCallMock.mockResolvedValueOnce({
      success: true,
      payload: {
        unread_summary: [{ conversation: 'general', unread_count: 3, latest: null }],
      },
    });

    const store = makeStore();
    await bootstrapWith(store, [
      row({ id: 'general', myUnread: 0 }),
      row({ id: 'random', myUnread: 7, unreadHasMention: true }),
    ]);

    // Pre-condition: random has stale local unread.
    expect(store.channelsById.random.unread).toBe(7);

    await store.checkChannels();

    expect(store.channelsById.general.unread).toBe(3);
    expect(store.channelsById.random.unread).toBe(0);
    expect(store.channelsById.random.unreadHasMention).toBe(false);
  });

  it('records the throttle timestamp even when the call rejects', async () => {
    mcpCallMock.mockResolvedValueOnce({ success: false, error: 'daemon down' });

    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'general' })]);

    const before = Date.now();
    const result = await store.checkChannels();
    const after = Date.now();

    expect(result.success).toBe(false);
    // Throttle slot moved forward so a rapid retry would still be throttled.
    const stamp = store._lastCommsCheckAtForTest();
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(after);
  });

  it('returns an error envelope when the user has no participant key', async () => {
    const store = new MqttChatStore();
    // userProfile.key starts as ''.
    expect(store.userProfile.key).toBe('');

    const result = await store.checkChannels();

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/participant key/i);
    expect(mcpCallMock).not.toHaveBeenCalled();
  });
});

describe('MqttChatStore Step 3.6 visibility-regain throttle', () => {
  it('skips the call when fired within 30s of the previous comms_check', async () => {
    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'general' })]);

    // First call: throttle slot is 0, fires the call.
    await store.checkChannels();
    expect(mcpCallMock).toHaveBeenCalledTimes(1);

    // Simulate a visibilitychange fired immediately after.
    const result = await store._simulateVisibilityRegainForTest();
    expect(result).toEqual({ success: true, throttled: true });
    // Still just the one call; the throttle held.
    expect(mcpCallMock).toHaveBeenCalledTimes(1);
  });

  it('re-fires the call when the throttle window has elapsed', async () => {
    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'general' })]);

    await store.checkChannels();
    expect(mcpCallMock).toHaveBeenCalledTimes(1);

    // Wind the throttle stamp back beyond the 30s window.
    store._setLastCommsCheckAtForTest(Date.now() - 60_000);

    const result = await store._simulateVisibilityRegainForTest();
    expect(result.throttled).toBeUndefined();
    expect(result.success).toBe(true);
    expect(mcpCallMock).toHaveBeenCalledTimes(2);
  });

  it('connect path bypasses the throttle by resetting the timestamp slot', async () => {
    // We don't drive the real connect handler here (it needs a broker
    // client) but we exercise its semantics: setting the slot to 0
    // before calling checkChannels guarantees the call fires even if
    // a previous one was recent.
    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'general' })]);

    await store.checkChannels();
    expect(mcpCallMock).toHaveBeenCalledTimes(1);

    // Reset the slot (this is what the connect handler does).
    store._setLastCommsCheckAtForTest(0);
    await store.checkChannels();
    expect(mcpCallMock).toHaveBeenCalledTimes(2);
  });
});
