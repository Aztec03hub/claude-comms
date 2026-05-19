// v0.4.2 Step 3.6b follow-ups (Wave C) — frontend reconciliation
// regression suite.
//
// The 3.6b backend tightened `tool_comms_conversation_update`:
//
//   - `visibility` accepts only `'public'` / `'private'` (the legacy
//     `'listed'` / `'unlisted'` strings are rejected).
//   - Rename uses the `display_name` field; the legacy `name` field is
//     rejected because the slug is immutable.
//
// This spec pins the matching frontend behavior so a future regression
// (someone reintroducing the legacy strings or the legacy `name` wire
// field) gets caught immediately.
//
// [VERIFY-3.6b-2] visibility wire values are `'public'` / `'private'`
// [VERIFY-3.6b-3] renameChannel wire field is `display_name`
//
// Pattern mirrors mqtt-store-admin-actions.spec.js: mock `mcpCall` +
// `apiGet`, drive the store directly.

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

describe('Wave C [VERIFY-3.6b-2] — setVisibility uses pinned public/private', () => {
  it('setVisibility(id, "public") fires comms_conversation_update with visibility:"public"', async () => {
    const store = makeStore();
    store.connected = true;
    await bootstrapWith(store, [row({ id: 'ch-1', visibility: 'private' })]);

    const result = await store.setVisibility('ch-1', 'public');

    expect(result).toEqual({ success: true });
    expect(mcpCallMock).toHaveBeenCalledWith('comms_conversation_update', {
      key: '0123abcd',
      conversation: 'ch-1',
      visibility: 'public',
    });
    // Legacy 'listed' must NOT appear anywhere in the wire payload.
    const payload = mcpCallMock.mock.calls[0][1];
    expect(payload.visibility).not.toBe('listed');
  });

  it('setVisibility(id, "private") fires with visibility:"private" (not "unlisted")', async () => {
    const store = makeStore();
    store.connected = true;
    await bootstrapWith(store, [row({ id: 'ch-1', visibility: 'public' })]);

    await store.setVisibility('ch-1', 'private');

    expect(mcpCallMock).toHaveBeenCalledWith('comms_conversation_update', {
      key: '0123abcd',
      conversation: 'ch-1',
      visibility: 'private',
    });
    const payload = mcpCallMock.mock.calls[0][1];
    expect(payload.visibility).not.toBe('unlisted');
  });

  it('#channelRowFromPayload defaults visibility to "public" (not legacy "listed")', async () => {
    const store = makeStore();
    // Row with NO visibility field — store should default it.
    await bootstrapWith(store, [{ id: 'sparse', name: 'sparse' }]);

    const sparse = store.channels.find((c) => c.id === 'sparse');
    expect(sparse.visibility).toBe('public');
    expect(sparse.visibility).not.toBe('listed');
  });
});

describe('Wave C [VERIFY-3.6b-3] — renameChannel uses display_name wire field', () => {
  it('connected rename fires comms_conversation_update with display_name (not name)', async () => {
    const store = makeStore();
    store.connected = true;
    await bootstrapWith(store, [row({ id: 'ch-1', name: 'old' })]);

    await store.renameChannel('ch-1', 'shiny-new');

    expect(mcpCallMock).toHaveBeenCalledWith('comms_conversation_update', {
      key: '0123abcd',
      conversation: 'ch-1',
      display_name: 'shiny-new',
    });
    // Legacy `name` field must NOT appear in the wire payload — the
    // 3.6b validator rejects it (slug is immutable).
    const payload = mcpCallMock.mock.calls[0][1];
    expect(payload.name).toBeUndefined();
    expect(payload.display_name).toBe('shiny-new');
  });

  it('queued (disconnected) rename also drains with display_name', async () => {
    const store = makeStore();
    expect(store.connected).toBe(false);
    await bootstrapWith(store, [row({ id: 'ch-1', name: 'old' })]);

    const result = await store.renameChannel('ch-1', 'queued-new');
    expect(result).toEqual({ success: true, queued: true });
    expect(mcpCallMock).not.toHaveBeenCalled();

    await store._drainPendingAdminActionsForTest();

    expect(mcpCallMock).toHaveBeenCalledTimes(1);
    const payload = mcpCallMock.mock.calls[0][1];
    expect(payload.display_name).toBe('queued-new');
    expect(payload.name).toBeUndefined();
  });

  it('local optimistic update still pins ch.name to the new display value', async () => {
    // The internal channel row's `name` field carries the display
    // value (the store hasn't grown a separate `displayName` field
    // yet; the brief explicitly defers that refactor). The wire
    // payload uses `display_name` but the local read path still uses
    // `name` for back-compat with every consumer.
    const store = makeStore();
    store.connected = true;
    await bootstrapWith(store, [row({ id: 'ch-1', name: 'old' })]);

    await store.renameChannel('ch-1', 'new-shiny');

    expect(store.channelsById['ch-1'].name).toBe('new-shiny');
  });

  it('rollback on backend rejection restores the previous name', async () => {
    mcpCallMock.mockResolvedValueOnce({ success: false, error: 'slug immutable' });

    const store = makeStore();
    store.connected = true;
    await bootstrapWith(store, [row({ id: 'ch-1', name: 'original' })]);

    const result = await store.renameChannel('ch-1', 'attempted');

    expect(result).toEqual({ success: false, error: 'slug immutable' });
    expect(store.channelsById['ch-1'].name).toBe('original');
  });
});
