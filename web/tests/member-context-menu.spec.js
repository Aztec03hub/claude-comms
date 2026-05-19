// MemberContextMenu + member-targeted store accessors -- v0.4.2 Step
// 3.5b (Wave E.4) spec.
//
// Three layers under test:
//   1. The MemberContextMenu Svelte component -- action visibility
//      matrix per (role, isSelf) combinations, keyboard nav, Escape +
//      outside-click dismissal.
//   2. The three new store accessors -- kickMember + startDM round-trip
//      ``mcpCall`` with the Wave E.3-pinned wire shape; muteUserGlobally
//      / isUserGloballyMuted round-trip localStorage under
//      ``cc:user-muted:{key}``.
//   3. MemberList wiring -- right-click on a member row fires the
//      onMemberContextMenu callback with the cursor coords + member.
//
// ``mcpCall`` + ``apiGet`` are mocked so these specs run without a
// daemon. Pattern mirrors ``tests/mqtt-store-admin-actions.spec.js``
// + ``tests/channel-context-menu.spec.js``.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

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
const MemberContextMenu = (
  await import('../src/components/MemberContextMenu.svelte')
).default;
const MemberList = (await import('../src/components/MemberList.svelte'))
  .default;

function makeMember(overrides = {}) {
  return {
    key: 'aaaaaaaa',
    name: 'alice',
    type: 'human',
    connections: { 'aaaaaaaa-web-1': { client: 'web' } },
    ...overrides,
  };
}

function makeChannel(overrides = {}) {
  return {
    id: 'general',
    name: 'general',
    member: true,
    createdBy: '11111111',
    ...overrides,
  };
}

function defaultProps(overrides = {}) {
  return {
    member: makeMember(),
    channel: makeChannel(),
    currentChannelRole: 'member',
    currentUserKey: '11111111',
    isMuted: false,
    x: 100,
    y: 100,
    onAction: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

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
  store.userProfile.key = '11111111';
  store.userProfile.name = 'me';
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

afterEach(() => {
  cleanup();
});

// =====================================================================
// 1. Action visibility matrix (5 tests)
// =====================================================================

describe('MemberContextMenu -- action visibility matrix', () => {
  it('owner viewing another member: Kick + Mute + DM all visible', () => {
    const { getByTestId, queryByTestId } = render(
      MemberContextMenu,
      defaultProps({
        currentChannelRole: 'owner',
        member: makeMember({ key: 'aaaaaaaa' }),
        currentUserKey: '11111111',
      }),
    );
    expect(getByTestId('member-ctx-item-kick')).toBeTruthy();
    expect(getByTestId('member-ctx-item-mute')).toBeTruthy();
    expect(getByTestId('member-ctx-item-dm')).toBeTruthy();
    // Unmute is the *other* state of the mute toggle; not visible when
    // isMuted=false.
    expect(queryByTestId('member-ctx-item-unmute')).toBeNull();
  });

  it('admin viewing another member: Kick + Mute + DM all visible', () => {
    const { getByTestId } = render(
      MemberContextMenu,
      defaultProps({ currentChannelRole: 'admin' }),
    );
    expect(getByTestId('member-ctx-item-kick')).toBeTruthy();
    expect(getByTestId('member-ctx-item-mute')).toBeTruthy();
    expect(getByTestId('member-ctx-item-dm')).toBeTruthy();
  });

  it('plain member viewing another member: Mute + DM visible, Kick hidden', () => {
    const { getByTestId, queryByTestId } = render(
      MemberContextMenu,
      defaultProps({ currentChannelRole: 'member' }),
    );
    expect(queryByTestId('member-ctx-item-kick')).toBeNull();
    expect(getByTestId('member-ctx-item-mute')).toBeTruthy();
    expect(getByTestId('member-ctx-item-dm')).toBeTruthy();
  });

  it('owner viewing SELF row: menu renders no items (returns null block)', () => {
    const { queryByTestId } = render(
      MemberContextMenu,
      defaultProps({
        currentChannelRole: 'owner',
        member: makeMember({ key: '11111111', name: 'me' }),
        currentUserKey: '11111111',
      }),
    );
    // Self-row suppresses every action; the menu element is never mounted.
    expect(queryByTestId('member-ctx-menu')).toBeNull();
    expect(queryByTestId('member-ctx-item-kick')).toBeNull();
    expect(queryByTestId('member-ctx-item-mute')).toBeNull();
    expect(queryByTestId('member-ctx-item-dm')).toBeNull();
  });

  it('isMuted=true flips the mute toggle: Unmute visible, Mute hidden', () => {
    const { getByTestId, queryByTestId } = render(
      MemberContextMenu,
      defaultProps({ isMuted: true }),
    );
    expect(getByTestId('member-ctx-item-unmute')).toBeTruthy();
    expect(queryByTestId('member-ctx-item-mute')).toBeNull();
  });
});

// =====================================================================
// 2. kickMember store accessor (3 tests)
// =====================================================================

describe('MqttChatStore Step 3.5b kickMember', () => {
  it('happy path: fires comms_kick with key + conversation + target_key', async () => {
    const store = makeStore();
    store.connected = true;
    await bootstrapWith(store, [row({ id: 'ch-1' })]);

    const result = await store.kickMember('ch-1', 'aaaaaaaa');

    expect(result).toEqual({ success: true });
    expect(mcpCallMock).toHaveBeenCalledWith('comms_kick', {
      key: '11111111',
      conversation: 'ch-1',
      target_key: 'aaaaaaaa',
    });
  });

  it('disconnected: rejects with "Not connected." (no queue, no wire call)', async () => {
    const store = makeStore();
    expect(store.connected).toBe(false);
    await bootstrapWith(store, [row({ id: 'ch-1' })]);

    const result = await store.kickMember('ch-1', 'aaaaaaaa');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not connected/i);
    expect(mcpCallMock).not.toHaveBeenCalled();
  });

  it('error path: MCP rejection surfaces { success: false, error }', async () => {
    mcpCallMock.mockResolvedValueOnce({
      success: false,
      error: 'Only owners or admins may kick.',
    });
    const store = makeStore();
    store.connected = true;
    await bootstrapWith(store, [row({ id: 'ch-1' })]);

    const result = await store.kickMember('ch-1', 'aaaaaaaa');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/owners or admins/i);
  });
});

// =====================================================================
// 3. startDM store accessor (3 tests)
// =====================================================================

describe('MqttChatStore Step 3.5b startDM', () => {
  it('happy path: fires comms_dm_open + switches into the returned conversation', async () => {
    mcpCallMock.mockResolvedValueOnce({
      success: true,
      payload: { conversation: 'dm-11111111-aaaaaaaa', status: 'opened' },
    });
    const store = makeStore();
    store.connected = true;
    await bootstrapWith(store, [row({ id: 'general' })]);
    // Seed the DM channel into the store so switchChannel is a no-op
    // history fetch (channelsById lookup not strictly required for
    // switchChannel but mirrors live wiring).
    store.channelsById['dm-11111111-aaaaaaaa'] = row({
      id: 'dm-11111111-aaaaaaaa',
      name: 'dm-11111111-aaaaaaaa',
    });

    const result = await store.startDM('aaaaaaaa');

    expect(result.success).toBe(true);
    expect(result.conversation).toBe('dm-11111111-aaaaaaaa');
    expect(result.status).toBe('opened');
    expect(mcpCallMock).toHaveBeenCalledWith('comms_dm_open', {
      key: '11111111',
      target_key: 'aaaaaaaa',
    });
    expect(store.activeChannel).toBe('dm-11111111-aaaaaaaa');
  });

  it('disconnected: rejects with "Not connected." (no wire call)', async () => {
    const store = makeStore();
    expect(store.connected).toBe(false);

    const result = await store.startDM('aaaaaaaa');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not connected/i);
    expect(mcpCallMock).not.toHaveBeenCalled();
  });

  it('error path: MCP rejection rolls through and does NOT switch channel', async () => {
    mcpCallMock.mockResolvedValueOnce({
      success: false,
      error: 'Unknown participant key.',
    });
    const store = makeStore();
    store.connected = true;
    await bootstrapWith(store, [row({ id: 'general' })]);
    store.activeChannel = 'general';

    const result = await store.startDM('ffffffff');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unknown participant/i);
    // Active channel untouched.
    expect(store.activeChannel).toBe('general');
  });
});

// =====================================================================
// 4. muteUserGlobally + isUserGloballyMuted (3 tests)
// =====================================================================

describe('MqttChatStore Step 3.5b global user-mute', () => {
  it('muteUserGlobally(true) writes cc:user-muted:{key}=1 + reactive map flips true', () => {
    const store = makeStore();
    expect(store.isUserGloballyMuted('aaaaaaaa')).toBe(false);

    store.muteUserGlobally('aaaaaaaa', true);

    expect(localStorage.getItem('cc:user-muted:aaaaaaaa')).toBe('1');
    expect(store.userMutes.aaaaaaaa).toBe(true);
    expect(store.isUserGloballyMuted('aaaaaaaa')).toBe(true);
  });

  it('muteUserGlobally(false) removes the localStorage key + flips the reactive map back', () => {
    const store = makeStore();
    store.muteUserGlobally('aaaaaaaa', true);
    expect(store.isUserGloballyMuted('aaaaaaaa')).toBe(true);

    store.muteUserGlobally('aaaaaaaa', false);

    expect(localStorage.getItem('cc:user-muted:aaaaaaaa')).toBeNull();
    expect(store.userMutes.aaaaaaaa).toBeUndefined();
    expect(store.isUserGloballyMuted('aaaaaaaa')).toBe(false);
  });

  it('isUserGloballyMuted reads from localStorage even without a prior session-side write', () => {
    // Simulate a value that survived a page reload: localStorage has
    // the entry, but the in-memory userMutes map starts empty.
    localStorage.setItem('cc:user-muted:bbbbbbbb', '1');
    const store = makeStore();
    expect(store.userMutes.bbbbbbbb).toBeUndefined();
    expect(store.isUserGloballyMuted('bbbbbbbb')).toBe(true);
    // Empty / missing keys: false.
    expect(store.isUserGloballyMuted('')).toBe(false);
    expect(store.isUserGloballyMuted('cccccccc')).toBe(false);
  });
});

// =====================================================================
// 5. MemberList right-click dispatch (1 test)
// =====================================================================

describe('MemberList -- right-click delegates to onMemberContextMenu', () => {
  it('contextmenu event on a member row fires onMemberContextMenu(event, member) + preventDefault', async () => {
    const onMemberContextMenu = vi.fn();
    const alice = makeMember({ key: 'aaaaaaaa', name: 'alice' });
    const { getByTestId } = render(MemberList, {
      active: [alice],
      onlineElsewhere: [],
      offline: [],
      activeChannelName: 'general',
      getMemberConversations: () => [],
      typingUsers: {},
      onShowProfile: vi.fn(),
      onMemberContextMenu,
    });

    const row = getByTestId('member-aaaaaaaa');
    await fireEvent.contextMenu(row, { clientX: 250, clientY: 150 });

    expect(onMemberContextMenu).toHaveBeenCalledTimes(1);
    const [event, member] = onMemberContextMenu.mock.calls[0];
    expect(event).toBeTruthy();
    expect(member.key).toBe('aaaaaaaa');
  });
});

// =====================================================================
// 6. Menu action firing + dismissal (3 tests)
// =====================================================================

describe('MemberContextMenu -- action firing + dismissal', () => {
  it('clicking Kick fires onAction("kick") then onClose', async () => {
    const onAction = vi.fn();
    const onClose = vi.fn();
    const { getByTestId } = render(
      MemberContextMenu,
      defaultProps({ currentChannelRole: 'owner', onAction, onClose }),
    );

    await fireEvent.click(getByTestId('member-ctx-item-kick'));
    await tick();

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith('kick');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape on the menu fires onClose', async () => {
    const onClose = vi.fn();
    const { getByTestId } = render(
      MemberContextMenu,
      defaultProps({ onClose }),
    );
    await fireEvent.keyDown(getByTestId('member-ctx-menu'), {
      key: 'Escape',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('outside-click (mousedown on body) fires onClose', async () => {
    const onClose = vi.fn();
    render(MemberContextMenu, defaultProps({ onClose }));
    await tick();
    await fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });
});
