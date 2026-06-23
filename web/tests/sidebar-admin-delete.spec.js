// Sidebar — admin-role context-menu gating + reserved-channel suppression
// + refused-delete toast feedback (admin-kick-delete fix).
//
// Exercises the full right-click -> ChannelContextMenu -> delete flow
// through the real Sidebar shell so the new prop wiring (isAdminOrOwner,
// isReserved, onRequestToast) is verified end to end.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

import Sidebar from '../src/components/Sidebar.svelte';

function makeChannel(id, overrides = {}) {
  return {
    id,
    name: id,
    topic: '',
    member: true,
    memberCount: 2,
    mode: 'public',
    visibility: 'listed',
    starred: false,
    muted: false,
    muteLevel: 'off',
    unread: 0,
    unreadHasMention: false,
    unreadFrom: null,
    lastActivity: null,
    createdAt: null,
    createdBy: null,
    archived: false,
    archived_at: null,
    archived_by: null,
    ...overrides,
  };
}

function makeStore(overrides = {}) {
  const channelsById = {
    general: makeChannel('general', { member: true, createdBy: null }),
    design: makeChannel('design', { member: true, createdBy: 'someone-else' }),
    ...(overrides.channelsById ?? {}),
  };
  const roles = overrides.roles ?? {};
  const store = {
    channelsById,
    channels: Object.values(channelsById),
    activeChannel: 'design',
    connected: true,
    connectionError: null,
    userProfile: { key: 'phil-key', name: 'phil', type: 'human' },
    messages: [],
    pinnedMessages: [],
    get starredChannels() {
      return Object.values(this.channelsById).filter((c) => c.member && c.starred && !c.archived);
    },
    get activeChannels() {
      return Object.values(this.channelsById).filter((c) => c.member && !c.starred && !c.archived);
    },
    get availableChannels() {
      return Object.values(this.channelsById).filter((c) => !c.member && c.visibility === 'listed' && !c.archived);
    },
    getChannelRole: vi.fn((id) => roles[id] ?? 'member'),
    switchChannel: vi.fn(),
    joinChannel: vi.fn(() => Promise.resolve({ success: true })),
    leaveChannel: vi.fn(() => ({ done: Promise.resolve({ success: true }), cancel: () => {} })),
    closeChannel: vi.fn(() => ({ done: Promise.resolve({ success: true }), cancel: () => {} })),
    deleteChannel:
      overrides.deleteChannel ?? vi.fn(() => Promise.resolve({ success: true })),
    archiveChannel: vi.fn(() => ({ done: Promise.resolve({ success: true }), cancel: () => {} })),
    setStar: vi.fn(),
    setMute: vi.fn(),
    setTopic: vi.fn(() => Promise.resolve({ success: true })),
    toggleStar: vi.fn(),
    muteChannel: vi.fn(),
  };
  return store;
}

function renderSidebar(store, overrides = {}) {
  return render(Sidebar, {
    props: {
      store,
      onCreateChannel: vi.fn(),
      onBrowseChannels: vi.fn(),
      onShowProfile: vi.fn(),
      onOpenSettings: vi.fn(),
      onConfirmDestructive: vi.fn().mockResolvedValue(true),
      ...overrides,
    },
  });
}

beforeEach(() => {
  try { localStorage.clear(); } catch { /* ignore */ }
});
afterEach(() => {
  cleanup();
  try { localStorage.clear(); } catch { /* ignore */ }
});

describe('Sidebar — admin-role context menu', () => {
  it('shows Delete/Close for a non-creator admin (role from getChannelRole)', async () => {
    const store = makeStore({ roles: { design: 'admin' } });
    const { getByTestId, queryByTestId } = renderSidebar(store);

    await fireEvent.contextMenu(getByTestId('sidebar-channel-row-design'));
    await tick();

    expect(getByTestId('channel-ctx-item-delete')).toBeTruthy();
    expect(getByTestId('channel-ctx-item-close')).toBeTruthy();
    expect(queryByTestId('channel-ctx-item-leave')).toBeNull();
  });

  it('shows only Leave for a plain member', async () => {
    const store = makeStore({ roles: { design: 'member' } });
    const { getByTestId, queryByTestId } = renderSidebar(store);

    await fireEvent.contextMenu(getByTestId('sidebar-channel-row-design'));
    await tick();

    expect(getByTestId('channel-ctx-item-leave')).toBeTruthy();
    expect(queryByTestId('channel-ctx-item-delete')).toBeNull();
    expect(queryByTestId('channel-ctx-item-close')).toBeNull();
  });

  it('suppresses Delete/Close for the reserved #general channel even for an admin', async () => {
    const store = makeStore({ roles: { general: 'admin' } });
    const { getByTestId, queryByTestId } = renderSidebar(store);

    await fireEvent.contextMenu(getByTestId('sidebar-channel-row-general'));
    await tick();

    expect(queryByTestId('channel-ctx-item-delete')).toBeNull();
    expect(queryByTestId('channel-ctx-item-close')).toBeNull();
  });
});

describe('Sidebar — refused delete feedback', () => {
  it('surfaces a toast when the server refuses a delete', async () => {
    const deleteChannel = vi.fn(() =>
      Promise.resolve({ success: false, error: 'Only the creator, an owner, or an admin may delete.' }),
    );
    const store = makeStore({ roles: { design: 'admin' }, deleteChannel });
    const onRequestToast = vi.fn();
    const { getByTestId } = renderSidebar(store, { onRequestToast });

    await fireEvent.contextMenu(getByTestId('sidebar-channel-row-design'));
    await tick();
    await fireEvent.click(getByTestId('channel-ctx-item-delete'));
    // Let the confirm promise + deleteChannel promise settle.
    await tick();
    await Promise.resolve();
    await Promise.resolve();
    await tick();

    expect(deleteChannel).toHaveBeenCalledWith('design');
    expect(onRequestToast).toHaveBeenCalledTimes(1);
    expect(onRequestToast.mock.calls[0][0]).toContain('admin');
  });
});
