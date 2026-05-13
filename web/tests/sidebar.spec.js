// Sidebar.svelte shell-shape coverage (v0.4.0 Step 2.12 rewrite).
//
// The sidebar is now a thin shell that:
//   1. Renders 3 SidebarChannelSection instances (Starred/Active/Available)
//   2. Houses ChannelContextMenu state (open/close, channel anchor)
//   3. Houses LeaveChannelDialog state with a pre-leave gate (>50 msgs OR
//      starred OR pinned-by-me)
//   4. Wires section row clicks: Starred/Active → switchChannel,
//      Available → joinChannel
//   5. Wires star toggle to onStarToggle prop (fallback store.setStar)
//   6. Does NOT sort (SORT-LOCK invariant) — sections receive pre-sorted
//      arrays from store's $derived projections
//
// G-5 (version label) and G-25 (connection status footer) coverage lives
// in sidebar-fixes.spec.js. SidebarChannelRow / SidebarChannelSection
// behavior lives in their own specs.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

import Sidebar from '../src/components/Sidebar.svelte';

// ── Fixtures ───────────────────────────────────────────────────────────

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

/**
 * Build a store mock with three channels by default:
 *   - 'general'     : starred member channel
 *   - 'random'      : member but not starred
 *   - 'announcements': non-member (Available)
 *
 * Plus all the lifecycle / star / mute method stubs the shell calls.
 */
function makeStore(overrides = {}) {
  const channelsById = {
    general: makeChannel('general', { starred: true, topic: 'Main', member: true }),
    random: makeChannel('random', { starred: false, topic: 'Off-topic', member: true }),
    announcements: makeChannel('announcements', {
      starred: false,
      topic: 'Broadcasts',
      member: false,
      visibility: 'listed',
    }),
    ...(overrides.channelsById ?? {}),
  };
  const store = {
    channelsById,
    channels: Object.values(channelsById),
    activeChannel: overrides.activeChannel ?? 'general',
    connected: true,
    connectionError: null,
    userProfile: overrides.userProfile ?? { key: 'phil-key', name: 'phil', type: 'human' },
    messages: overrides.messages ?? [],
    pinnedMessages: overrides.pinnedMessages ?? [],
    get starredChannels() {
      return Object.values(this.channelsById).filter((c) => c.member && c.starred && !c.archived);
    },
    get activeChannels() {
      return Object.values(this.channelsById).filter((c) => c.member && !c.starred && !c.archived);
    },
    get availableChannels() {
      return Object.values(this.channelsById).filter((c) => !c.member && c.visibility === 'listed' && !c.archived);
    },
    switchChannel: vi.fn(),
    joinChannel: vi.fn(() => Promise.resolve({ success: true })),
    leaveChannel: vi.fn(() => ({ done: Promise.resolve({ success: true }), cancel: () => {} })),
    closeChannel: vi.fn(() => ({ done: Promise.resolve({ success: true }), cancel: () => {} })),
    deleteChannel: vi.fn(() => Promise.resolve({ success: true })),
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
      ...overrides,
    },
  });
}

// LocalStorage cleanup so the section-collapse persistence keys don't
// leak between tests.
beforeEach(() => {
  try { localStorage.clear(); } catch { /* ignore */ }
});
afterEach(() => {
  cleanup();
  try { localStorage.clear(); } catch { /* ignore */ }
});

// ── Section rendering ──────────────────────────────────────────────────

describe('Sidebar shell — section rendering', () => {
  it('renders all three SidebarChannelSection instances (Starred / Active / Available)', () => {
    const store = makeStore();
    const { getByTestId } = renderSidebar(store);

    expect(getByTestId('sidebar-channel-section-Starred')).toBeTruthy();
    expect(getByTestId('sidebar-channel-section-Active')).toBeTruthy();
    expect(getByTestId('sidebar-channel-section-Available')).toBeTruthy();
  });

  it('Starred section shows the row count matching store.starredChannels.length', () => {
    const store = makeStore();
    const { getByTestId } = renderSidebar(store);

    // Default fixture: 'general' is the only starred member channel.
    expect(getByTestId('sidebar-channel-section-count-Starred').textContent.trim()).toBe('1');
    expect(getByTestId('sidebar-channel-row-general')).toBeTruthy();
  });

  it('Active section shows the row count matching store.activeChannels.length', () => {
    const store = makeStore();
    const { getByTestId } = renderSidebar(store);

    // Default fixture: 'random' is the only member-but-unstarred channel.
    expect(getByTestId('sidebar-channel-section-count-Active').textContent.trim()).toBe('1');
    expect(getByTestId('sidebar-channel-row-random')).toBeTruthy();
  });

  it('Available section shows the row count matching store.availableChannels.length', () => {
    const store = makeStore();
    const { getByTestId } = renderSidebar(store);

    // Default fixture: 'announcements' is non-member, listed.
    expect(getByTestId('sidebar-channel-section-count-Available').textContent.trim()).toBe('1');
    expect(getByTestId('sidebar-channel-row-announcements')).toBeTruthy();
  });

  it('renders the empty-state copy in each section when its array is empty', () => {
    // Override the channelsById entirely (the default fixture's three
    // channels would otherwise survive the {} spread). Easiest: build
    // a store and stub the three derived getters to empty arrays.
    const store = makeStore();
    Object.defineProperty(store, 'starredChannels', { get: () => [], configurable: true });
    Object.defineProperty(store, 'activeChannels', { get: () => [], configurable: true });
    Object.defineProperty(store, 'availableChannels', { get: () => [], configurable: true });
    const { getByTestId } = renderSidebar(store);

    const starredEmpty = getByTestId('sidebar-channel-section-empty-Starred');
    const activeEmpty = getByTestId('sidebar-channel-section-empty-Active');
    const availableEmpty = getByTestId('sidebar-channel-section-empty-Available');
    expect(starredEmpty.textContent).toContain('No starred channels');
    expect(activeEmpty.textContent).toContain("You haven't joined any channels yet");
    expect(availableEmpty.textContent).toContain('No channels available');
  });
});

// ── Row click semantics ────────────────────────────────────────────────

describe('Sidebar shell — row click routing', () => {
  it('clicking a Starred row calls store.switchChannel', async () => {
    const store = makeStore();
    const { getByTestId } = renderSidebar(store);

    await fireEvent.click(getByTestId('sidebar-channel-row-general'));

    expect(store.switchChannel).toHaveBeenCalledWith('general');
    expect(store.joinChannel).not.toHaveBeenCalled();
  });

  it('clicking an Active row calls store.switchChannel (not joinChannel)', async () => {
    const store = makeStore();
    const { getByTestId } = renderSidebar(store);

    await fireEvent.click(getByTestId('sidebar-channel-row-random'));

    expect(store.switchChannel).toHaveBeenCalledWith('random');
    expect(store.joinChannel).not.toHaveBeenCalled();
  });

  it('clicking an Available row calls store.joinChannel (not switchChannel directly)', async () => {
    const store = makeStore();
    const { getByTestId } = renderSidebar(store);

    await fireEvent.click(getByTestId('sidebar-channel-row-announcements'));
    // joinChannel is async; let microtasks flush so any follow-up
    // switchChannel call (on success) lands before we assert.
    await Promise.resolve();
    await tick();

    expect(store.joinChannel).toHaveBeenCalledWith('announcements');
    // The shell switches into the channel on a successful join.
    expect(store.switchChannel).toHaveBeenCalledWith('announcements');
  });
});

// ── Star toggle ────────────────────────────────────────────────────────

describe('Sidebar shell — star toggle', () => {
  it('clicking a row star button calls the parent onStarToggle prop when supplied', async () => {
    const store = makeStore();
    const onStarToggle = vi.fn();
    const { getByTestId } = renderSidebar(store, { onStarToggle });

    await fireEvent.click(getByTestId('row-star-random'));

    expect(onStarToggle).toHaveBeenCalledWith('random');
    expect(store.setStar).not.toHaveBeenCalled();
    // Row click must NOT fire — the star button stops propagation.
    expect(store.switchChannel).not.toHaveBeenCalled();
  });

  it('falls back to store.setStar when no onStarToggle prop is supplied', async () => {
    const store = makeStore();
    const { getByTestId } = renderSidebar(store, { onStarToggle: undefined });

    // 'random' is unstarred; the fallback should call setStar('random', true).
    await fireEvent.click(getByTestId('row-star-random'));

    expect(store.setStar).toHaveBeenCalledWith('random', true);
    expect(store.switchChannel).not.toHaveBeenCalled();
  });
});

// ── Context menu mount ─────────────────────────────────────────────────

describe('Sidebar shell — context menu', () => {
  it('right-clicking a row opens the ChannelContextMenu with that channel', async () => {
    const store = makeStore();
    const { getByTestId, queryByTestId } = renderSidebar(store);

    // No menu mounted initially.
    expect(queryByTestId('channel-ctx-menu')).toBeNull();

    await fireEvent.contextMenu(getByTestId('sidebar-channel-row-random'));
    await tick();

    expect(getByTestId('channel-ctx-menu')).toBeTruthy();
  });

  it('selecting the Star item in the context menu calls store.setStar with toggled value', async () => {
    const store = makeStore();
    const { getByTestId } = renderSidebar(store);

    // Open the menu over 'random' (currently unstarred).
    await fireEvent.contextMenu(getByTestId('sidebar-channel-row-random'));
    await tick();

    // ChannelContextMenu emits actionId 'toggle-star' via the Star/Unstar row.
    await fireEvent.click(getByTestId('channel-ctx-item-toggle-star'));
    await tick();

    expect(store.setStar).toHaveBeenCalledWith('random', true);
  });

  it('selecting the Copy-link item writes the channel link to the clipboard', async () => {
    const store = makeStore();
    const writeText = vi.fn(() => Promise.resolve());
    // Mock navigator.clipboard.writeText for the test environment.
    const originalClipboard = globalThis.navigator?.clipboard;
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true,
    });

    try {
      const { getByTestId } = renderSidebar(store);
      await fireEvent.contextMenu(getByTestId('sidebar-channel-row-random'));
      await tick();
      await fireEvent.click(getByTestId('channel-ctx-item-copy-link'));
      // microtask flush for the await in handleContextAction
      await Promise.resolve();
      await Promise.resolve();

      expect(writeText).toHaveBeenCalledWith('/#/c/random');
    } finally {
      if (originalClipboard) {
        Object.defineProperty(globalThis.navigator, 'clipboard', {
          value: originalClipboard,
          writable: true,
          configurable: true,
        });
      }
    }
  });
});

// ── Leave-dialog pre-leave gate ────────────────────────────────────────

describe('Sidebar shell — leave dialog gate', () => {
  it('Leave context action fires silent store.leaveChannel when no trigger condition holds', async () => {
    // Fixture: 'random' is a regular member channel (not starred, no
    // pinned authorship, no message count > 50). Leave should be silent.
    const store = makeStore();
    const { getByTestId, queryByTestId } = renderSidebar(store);

    await fireEvent.contextMenu(getByTestId('sidebar-channel-row-random'));
    await tick();
    await fireEvent.click(getByTestId('channel-ctx-item-leave'));
    await tick();

    expect(store.leaveChannel).toHaveBeenCalledWith('random');
    expect(queryByTestId('leave-channel-dialog')).toBeNull();
  });

  it('Leave action mounts the confirmation dialog when the channel is starred', async () => {
    // 'general' is starred in the default fixture. Leave should mount
    // the dialog instead of firing leaveChannel directly.
    const store = makeStore();
    const { getByTestId, queryByTestId } = renderSidebar(store);

    await fireEvent.contextMenu(getByTestId('sidebar-channel-row-general'));
    await tick();
    // The starred-channel context menu's Leave item is suppressed when
    // the user is the channel creator — 'general' has createdBy:null so
    // isCreator is false → Leave IS shown.
    await fireEvent.click(getByTestId('channel-ctx-item-leave'));
    await tick();

    expect(getByTestId('leave-channel-dialog')).toBeTruthy();
    // Silent leave must NOT have fired yet — dialog confirms it.
    expect(store.leaveChannel).not.toHaveBeenCalled();
    // The dialog should display the starred-warning copy.
    expect(queryByTestId('leave-channel-starred-warning')).toBeTruthy();
  });

  it('Leave action mounts the dialog when the user has authored pinned messages in the channel', async () => {
    // Set up a non-starred channel where the user authored a pinned msg.
    const store = makeStore({
      pinnedMessages: [
        { id: 'm1', channel: 'random', from: 'phil-key', body: 'pinned thing' },
      ],
    });
    const { getByTestId, queryByTestId } = renderSidebar(store);

    await fireEvent.contextMenu(getByTestId('sidebar-channel-row-random'));
    await tick();
    await fireEvent.click(getByTestId('channel-ctx-item-leave'));
    await tick();

    expect(getByTestId('leave-channel-dialog')).toBeTruthy();
    expect(store.leaveChannel).not.toHaveBeenCalled();
    expect(queryByTestId('leave-channel-pinned-warning')).toBeTruthy();
  });

  it('Leave action mounts the dialog when the user has > 50 messages in the channel', async () => {
    // Build a messages array with 51 messages by the current user in 'random'.
    const messages = [];
    for (let i = 0; i < 51; i += 1) {
      messages.push({ id: `m${i}`, channel: 'random', from: 'phil-key', body: 'noise' });
    }
    const store = makeStore({ messages });
    const { getByTestId } = renderSidebar(store);

    await fireEvent.contextMenu(getByTestId('sidebar-channel-row-random'));
    await tick();
    await fireEvent.click(getByTestId('channel-ctx-item-leave'));
    await tick();

    expect(getByTestId('leave-channel-dialog')).toBeTruthy();
    expect(store.leaveChannel).not.toHaveBeenCalled();
  });

  it('confirming the Leave dialog fires store.leaveChannel and unmounts the dialog', async () => {
    const store = makeStore();
    const { getByTestId, queryByTestId } = renderSidebar(store);

    await fireEvent.contextMenu(getByTestId('sidebar-channel-row-general'));
    await tick();
    await fireEvent.click(getByTestId('channel-ctx-item-leave'));
    await tick();

    expect(getByTestId('leave-channel-dialog')).toBeTruthy();

    await fireEvent.click(getByTestId('leave-channel-confirm'));
    await tick();

    expect(store.leaveChannel).toHaveBeenCalledWith('general');
    expect(queryByTestId('leave-channel-dialog')).toBeNull();
  });

  it('cancelling the Leave dialog does NOT fire store.leaveChannel and unmounts the dialog', async () => {
    const store = makeStore();
    const { getByTestId, queryByTestId } = renderSidebar(store);

    await fireEvent.contextMenu(getByTestId('sidebar-channel-row-general'));
    await tick();
    await fireEvent.click(getByTestId('channel-ctx-item-leave'));
    await tick();

    expect(getByTestId('leave-channel-dialog')).toBeTruthy();

    await fireEvent.click(getByTestId('leave-channel-cancel'));
    await tick();

    expect(store.leaveChannel).not.toHaveBeenCalled();
    expect(queryByTestId('leave-channel-dialog')).toBeNull();
  });
});

// ── SORT-LOCK invariant ────────────────────────────────────────────────

describe('Sidebar shell — SORT-LOCK invariant', () => {
  it('renders channels in the exact order store.activeChannels delivers them (no in-template sort)', () => {
    // Construct an Active section with channels in a specific order that
    // is NOT alphabetical, to prove the shell doesn't re-sort.
    const channelsById = {
      zebra: makeChannel('zebra', { starred: false, member: true }),
      alpha: makeChannel('alpha', { starred: false, member: true }),
      mango: makeChannel('mango', { starred: false, member: true }),
    };
    // Build a store whose activeChannels projection preserves insertion
    // order (zebra, alpha, mango) rather than alphabetizing — the real
    // store would alphabetize, but the SHELL's contract is to render
    // whatever order the projection hands in.
    const store = makeStore({ channelsById });
    Object.defineProperty(store, 'activeChannels', {
      get() {
        return [
          channelsById.zebra,
          channelsById.alpha,
          channelsById.mango,
        ];
      },
      configurable: true,
    });

    const { container } = renderSidebar(store);
    const rows = container.querySelectorAll(
      '[data-testid="sidebar-channel-section-body-Active"] [data-testid^="sidebar-channel-row-"]'
    );
    const ids = Array.from(rows).map((el) =>
      el.getAttribute('data-testid').replace('sidebar-channel-row-', '')
    );
    expect(ids).toEqual(['zebra', 'alpha', 'mango']);
  });
});

// ── Header / footer chrome wiring ──────────────────────────────────────

describe('Sidebar shell — chrome wiring', () => {
  it('clicking the New Conversation button calls onCreateChannel', async () => {
    const store = makeStore();
    const onCreateChannel = vi.fn();
    const { getByTestId } = renderSidebar(store, { onCreateChannel });

    await fireEvent.click(getByTestId('sidebar-create-channel'));

    expect(onCreateChannel).toHaveBeenCalledTimes(1);
  });

  it('clicking the Browse All button calls onBrowseChannels', async () => {
    const store = makeStore();
    const onBrowseChannels = vi.fn();
    const { getByTestId } = renderSidebar(store, { onBrowseChannels });

    await fireEvent.click(getByTestId('sidebar-browse-channels'));

    expect(onBrowseChannels).toHaveBeenCalledTimes(1);
  });

  it('clicking the user-profile region calls onShowProfile with the current user identity', async () => {
    const store = makeStore();
    const onShowProfile = vi.fn();
    const { getByTestId } = renderSidebar(store, { onShowProfile });

    await fireEvent.click(getByTestId('sidebar-user-profile'));

    expect(onShowProfile).toHaveBeenCalledTimes(1);
    const arg = onShowProfile.mock.calls[0][0];
    expect(arg).toMatchObject({ key: 'phil-key', name: 'phil', type: 'human', status: 'online' });
  });
});
