// v0.4.2 Step 3.6 (expanded): admin-action store accessors.
//
// Wave A's Step 3.1 ChannelAdminPanel ships visually functional but
// persistence-no-op because the 5 store accessors it calls under
// typeof guards (`getChannelRole`, `renameChannel`, `setVisibility`,
// `setMode`, `transferOwnership`) didn't exist on main. This spec
// locks in the Wave B implementation:
//
//   - happy path: connected → MCP call fires with the right payload,
//     optimistic local update sticks on success
//   - error path: MCP rejection → local state rolls back, envelope
//     surfaces { success: false, error }
//   - disconnected path: action queues on `#pendingAdminActions`,
//     local update applies optimistically, drain on reconnect fires
//     the MCP call FIFO and rolls back on failure
//
// `mcpCall` + `apiGet` are mocked so these specs run without a daemon.
// Pattern mirrors `tests/mqtt-store-mark-read.spec.js`.

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
  mcpCallMock.mockResolvedValue({ success: true, payload: {} });
  try {
    if (typeof localStorage !== 'undefined') localStorage.clear();
  } catch {
    /* jsdom may not provide localStorage */
  }
});

describe('MqttChatStore Step 3.6 getChannelRole (client-side inference)', () => {
  it('returns owner when the channel.createdBy matches the user key', async () => {
    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'mine', createdBy: '0123abcd' })]);

    expect(store.getChannelRole('mine')).toBe('owner');
    // Cache is populated reactively.
    expect(store.channelRoles.mine).toBe('owner');
  });

  it('returns owner when the channel.createdBy is the legacy display name (3.0a grandfather)', async () => {
    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'legacy', createdBy: 'test-user' })]);

    expect(store.getChannelRole('legacy')).toBe('owner');
  });

  it('returns member when the channel.createdBy is a different user', async () => {
    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'other', createdBy: 'someone-else' })]);

    expect(store.getChannelRole('other')).toBe('member');
    expect(store.channelRoles.other).toBe('member');
  });

  it('returns null for an unknown channel id', async () => {
    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'general' })]);

    expect(store.getChannelRole('does-not-exist')).toBeNull();
    expect(store.channelRoles['does-not-exist']).toBeUndefined();
  });

  it('returns null for missing/empty channel id', () => {
    const store = makeStore();
    expect(store.getChannelRole()).toBeNull();
    expect(store.getChannelRole('')).toBeNull();
    expect(store.getChannelRole(null)).toBeNull();
  });
});

describe('MqttChatStore Step 3.6 renameChannel', () => {
  it('happy path: fires comms_conversation_update with name + commits local update', async () => {
    const store = makeStore();
    store.connected = true;
    await bootstrapWith(store, [row({ id: 'ch-1', name: 'old-name' })]);

    const result = await store.renameChannel('ch-1', 'new-name');

    expect(result).toEqual({ success: true });
    expect(store.channelsById['ch-1'].name).toBe('new-name');
    // v0.4.2 Wave C [VERIFY-3.6b-3] reconciliation: wire field is
    // `display_name`, not the legacy `name`. The slug (`conversation`)
    // is immutable per 3.6b's tightened validator; only the human-
    // readable display name is mutable.
    expect(mcpCallMock).toHaveBeenCalledWith('comms_conversation_update', {
      key: '0123abcd',
      conversation: 'ch-1',
      display_name: 'new-name',
    });
  });

  it('error path: MCP rejection rolls back the optimistic name change', async () => {
    mcpCallMock.mockResolvedValueOnce({ success: false, error: 'backend rejected' });

    const store = makeStore();
    store.connected = true;
    await bootstrapWith(store, [row({ id: 'ch-1', name: 'old-name' })]);

    const result = await store.renameChannel('ch-1', 'new-name');

    expect(result).toEqual({ success: false, error: 'backend rejected' });
    expect(store.channelsById['ch-1'].name).toBe('old-name');
  });

  it('disconnected: queues the rename, applies local change, drains on reconnect', async () => {
    const store = makeStore();
    expect(store.connected).toBe(false);
    await bootstrapWith(store, [row({ id: 'ch-1', name: 'old-name' })]);

    const result = await store.renameChannel('ch-1', 'queued-name');

    expect(result).toEqual({ success: true, queued: true });
    expect(store.channelsById['ch-1'].name).toBe('queued-name');
    expect(store._pendingAdminActionsLengthForTest()).toBe(1);
    // No MCP call yet; queued for reconnect.
    expect(mcpCallMock).not.toHaveBeenCalled();

    // Simulate reconnect drain.
    await store._drainPendingAdminActionsForTest();

    // v0.4.2 Wave C [VERIFY-3.6b-3] reconciliation: queued rename
    // also drains with `display_name`.
    expect(mcpCallMock).toHaveBeenCalledWith('comms_conversation_update', {
      key: '0123abcd',
      conversation: 'ch-1',
      display_name: 'queued-name',
    });
    expect(store._pendingAdminActionsLengthForTest()).toBe(0);
  });

  it('rejects missing channel id and empty name without firing MCP', async () => {
    const store = makeStore();
    store.connected = true;
    await bootstrapWith(store, [row({ id: 'ch-1' })]);

    const r1 = await store.renameChannel('', 'x');
    const r2 = await store.renameChannel('ch-1', '');
    const r3 = await store.renameChannel('ch-1', '   ');

    expect(r1.success).toBe(false);
    expect(r2.success).toBe(false);
    expect(r3.success).toBe(false);
    expect(mcpCallMock).not.toHaveBeenCalled();
  });
});

describe('MqttChatStore Step 3.6 setVisibility', () => {
  it('happy path: fires comms_conversation_update with visibility', async () => {
    const store = makeStore();
    store.connected = true;
    await bootstrapWith(store, [row({ id: 'ch-1', visibility: 'public' })]);

    const result = await store.setVisibility('ch-1', 'private');

    expect(result).toEqual({ success: true });
    expect(store.channelsById['ch-1'].visibility).toBe('private');
    expect(mcpCallMock).toHaveBeenCalledWith('comms_conversation_update', {
      key: '0123abcd',
      conversation: 'ch-1',
      visibility: 'private',
    });
  });

  it('error path: rolls back optimistic visibility on MCP rejection', async () => {
    mcpCallMock.mockResolvedValueOnce({ success: false, error: 'unknown field' });

    const store = makeStore();
    store.connected = true;
    await bootstrapWith(store, [row({ id: 'ch-1', visibility: 'public' })]);

    const result = await store.setVisibility('ch-1', 'private');

    expect(result.success).toBe(false);
    expect(store.channelsById['ch-1'].visibility).toBe('public');
  });

  it('disconnected: queues and drains via reconnect', async () => {
    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'ch-1', visibility: 'public' })]);

    const result = await store.setVisibility('ch-1', 'private');

    expect(result.queued).toBe(true);
    expect(store.channelsById['ch-1'].visibility).toBe('private');
    expect(store._pendingAdminActionsLengthForTest()).toBe(1);

    await store._drainPendingAdminActionsForTest();
    expect(mcpCallMock).toHaveBeenCalledWith('comms_conversation_update', {
      key: '0123abcd',
      conversation: 'ch-1',
      visibility: 'private',
    });
  });
});

describe('MqttChatStore Step 3.6 setMode', () => {
  it('happy path: fires comms_conversation_update with mode', async () => {
    const store = makeStore();
    store.connected = true;
    await bootstrapWith(store, [row({ id: 'ch-1', mode: 'public' })]);

    const result = await store.setMode('ch-1', 'invite');

    expect(result).toEqual({ success: true });
    expect(store.channelsById['ch-1'].mode).toBe('invite');
    expect(mcpCallMock).toHaveBeenCalledWith('comms_conversation_update', {
      key: '0123abcd',
      conversation: 'ch-1',
      mode: 'invite',
    });
  });

  it('error path: rolls back optimistic mode on MCP rejection', async () => {
    mcpCallMock.mockResolvedValueOnce({ success: false, error: 'nope' });

    const store = makeStore();
    store.connected = true;
    await bootstrapWith(store, [row({ id: 'ch-1', mode: 'public' })]);

    const result = await store.setMode('ch-1', 'invite');

    expect(result.success).toBe(false);
    expect(store.channelsById['ch-1'].mode).toBe('public');
  });

  it('disconnected: queue + drain on reconnect fires the wire call', async () => {
    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'ch-1', mode: 'public' })]);

    const r = await store.setMode('ch-1', 'invite');
    expect(r.queued).toBe(true);
    expect(store._pendingAdminActionsLengthForTest()).toBe(1);

    await store._drainPendingAdminActionsForTest();
    expect(mcpCallMock).toHaveBeenCalledWith('comms_conversation_update', {
      key: '0123abcd',
      conversation: 'ch-1',
      mode: 'invite',
    });
  });
});

describe('MqttChatStore Step 3.6 transferOwnership', () => {
  it('happy path: fires update with created_by + demotes local role to member', async () => {
    const store = makeStore();
    store.connected = true;
    await bootstrapWith(store, [row({ id: 'ch-1', createdBy: '0123abcd' })]);

    // Pre-condition: caller is owner.
    expect(store.getChannelRole('ch-1')).toBe('owner');

    const result = await store.transferOwnership('ch-1', 'new-owner-key');

    expect(result).toEqual({ success: true });
    expect(store.channelsById['ch-1'].createdBy).toBe('new-owner-key');
    expect(store.channelRoles['ch-1']).toBe('member');
    expect(mcpCallMock).toHaveBeenCalledWith('comms_conversation_update', {
      key: '0123abcd',
      conversation: 'ch-1',
      created_by: 'new-owner-key',
    });
  });

  it('1-arg call from ChannelAdminPanel: returns structured error without firing MCP', async () => {
    const store = makeStore();
    store.connected = true;
    await bootstrapWith(store, [row({ id: 'ch-1', createdBy: '0123abcd' })]);

    const result = await store.transferOwnership('ch-1');

    expect(result).toEqual({ success: false, error: 'New-owner key required.' });
    expect(store.channelsById['ch-1'].createdBy).toBe('0123abcd');
    expect(mcpCallMock).not.toHaveBeenCalled();
  });

  it('error path: rolls back createdBy AND restores the previous role', async () => {
    mcpCallMock.mockResolvedValueOnce({ success: false, error: 'forbidden' });

    const store = makeStore();
    store.connected = true;
    await bootstrapWith(store, [row({ id: 'ch-1', createdBy: '0123abcd' })]);

    expect(store.getChannelRole('ch-1')).toBe('owner');

    const result = await store.transferOwnership('ch-1', 'new-owner-key');

    expect(result.success).toBe(false);
    expect(store.channelsById['ch-1'].createdBy).toBe('0123abcd');
    expect(store.channelRoles['ch-1']).toBe('owner');
  });

  it('disconnected: queue + drain on reconnect persists the transfer', async () => {
    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'ch-1', createdBy: '0123abcd' })]);

    expect(store.getChannelRole('ch-1')).toBe('owner');

    const r = await store.transferOwnership('ch-1', 'new-owner-key');
    expect(r.queued).toBe(true);
    expect(store.channelsById['ch-1'].createdBy).toBe('new-owner-key');
    expect(store.channelRoles['ch-1']).toBe('member');
    expect(store._pendingAdminActionsLengthForTest()).toBe(1);

    await store._drainPendingAdminActionsForTest();
    expect(mcpCallMock).toHaveBeenCalledWith('comms_conversation_update', {
      key: '0123abcd',
      conversation: 'ch-1',
      created_by: 'new-owner-key',
    });
  });
});

describe('MqttChatStore Step 3.6 admin-action queue behavior', () => {
  it('FIFO drain order across heterogeneous queued actions', async () => {
    const store = makeStore();
    await bootstrapWith(store, [
      row({ id: 'ch-a', name: 'a', visibility: 'public' }),
      row({ id: 'ch-b', name: 'b', mode: 'public' }),
    ]);

    await store.renameChannel('ch-a', 'a-renamed');
    await store.setVisibility('ch-a', 'private');
    await store.setMode('ch-b', 'invite');

    expect(store._pendingAdminActionsLengthForTest()).toBe(3);

    await store._drainPendingAdminActionsForTest();

    // All three MCP calls fired in insertion order.
    // v0.4.2 Wave C [VERIFY-3.6b-3]: rename now lands on `display_name`.
    expect(mcpCallMock).toHaveBeenCalledTimes(3);
    const calls = mcpCallMock.mock.calls.map((c) => c[1]);
    expect(calls[0].display_name).toBe('a-renamed');
    expect(calls[1].visibility).toBe('private');
    expect(calls[2].mode).toBe('invite');
    expect(store._pendingAdminActionsLengthForTest()).toBe(0);
  });

  it('drain rolls back the local change when a queued run rejects', async () => {
    // The first queued call succeeds; the second rejects so we can
    // assert the rollback runs only for the failing one.
    mcpCallMock.mockResolvedValueOnce({ success: true, payload: {} });
    mcpCallMock.mockResolvedValueOnce({ success: false, error: 'rejected on reconnect' });

    const store = makeStore();
    await bootstrapWith(store, [
      row({ id: 'ch-a', visibility: 'public' }),
      row({ id: 'ch-b', mode: 'public' }),
    ]);

    await store.setVisibility('ch-a', 'private');
    await store.setMode('ch-b', 'invite');

    expect(store.channelsById['ch-a'].visibility).toBe('private');
    expect(store.channelsById['ch-b'].mode).toBe('invite');

    await store._drainPendingAdminActionsForTest();

    // ch-a's rename committed; ch-b's mode rolled back.
    expect(store.channelsById['ch-a'].visibility).toBe('private');
    expect(store.channelsById['ch-b'].mode).toBe('public');
  });
});
