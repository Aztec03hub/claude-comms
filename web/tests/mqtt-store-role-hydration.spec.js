// Role hydration: hydrateChannelRoles pulls the authoritative per-channel
// role from the server (comms_get_channel_role) into channelRoles so the
// client-side accessor reflects 'admin' (not just inferred owner/member).
//
// Mirrors tests/mqtt-store-admin-actions.spec.js: mcpCall + apiGet mocked,
// store bootstrapped via the test hook.

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
    id: 'design',
    name: 'design',
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
  } catch { /* ignore */ }
});

describe('hydrateChannelRoles', () => {
  it('overwrites the inferred role with the server role (admin)', async () => {
    const store = makeStore();
    // Channel created by someone else → client infers 'member'.
    await bootstrapWith(store, [row({ id: 'design', createdBy: 'someone-else' })]);
    expect(store.getChannelRole('design')).toBe('member');

    // Server says the caller is actually an admin of #design.
    mcpCallMock.mockResolvedValue({
      success: true,
      payload: { role: 'admin', participant_key: '0123abcd', conversation: 'design' },
    });

    await store.hydrateChannelRoles();

    expect(store.getChannelRole('design')).toBe('admin');
    // It queried comms_get_channel_role for the channel.
    expect(mcpCallMock).toHaveBeenCalledWith(
      'comms_get_channel_role',
      expect.objectContaining({ key: '0123abcd', conversation: 'design' }),
    );
  });

  it('reflects owner from the server', async () => {
    const store = makeStore();
    await bootstrapWith(store, [row({ id: 'design', createdBy: 'someone-else' })]);

    mcpCallMock.mockResolvedValue({
      success: true,
      payload: { role: 'owner', participant_key: '0123abcd', conversation: 'design' },
    });
    await store.hydrateChannelRoles();
    expect(store.getChannelRole('design')).toBe('owner');
  });

  it('leaves the optimistic inference when the server call fails', async () => {
    const store = makeStore();
    // Caller created it → inferred 'owner'.
    await bootstrapWith(store, [row({ id: 'design', createdBy: '0123abcd' })]);
    expect(store.getChannelRole('design')).toBe('owner');

    mcpCallMock.mockResolvedValue({ success: false, error: 'daemon down' });
    await store.hydrateChannelRoles();

    // Unchanged — the inference survives a failed hydration.
    expect(store.getChannelRole('design')).toBe('owner');
  });
});
