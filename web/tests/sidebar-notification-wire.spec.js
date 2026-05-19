// v0.4.2 Wave G follow-up [VERIFY-WAVE-G-3 + VERIFY-WAVE-G-5].
// Sidebar.svelte plumbing for the new ``notificationPolicy`` /
// ``currentNotificationPolicy`` props + the bootstrap pre-warm path.
//
// What this file pins
// ───────────────────
// 1. ``getChannelNotificationPolicy`` is forwarded into each
//    SidebarChannelSection → SidebarChannelRow, so the bell-icon
//    variant renders for non-default policies on the FIRST sidebar
//    paint (no need to interact with the row first).
// 2. The ChannelContextMenu mount in Sidebar.svelte receives
//    ``currentNotificationPolicy`` for the anchored channel, so the
//    Q8 quickview row shows the actual current state instead of the
//    silent default ``'All'`` fall-back.
// 3. The Sidebar's ``handleContextAction`` switch handles
//    ``actionId='notif:cycle'`` by calling
//    ``store.cycleNotificationPolicy(channelId)`` and closing the
//    menu (which already happens unconditionally at the top of the
//    handler).
// 4. The store's ``#prewarmNotificationPolicies`` helper, fired from
//    ``#bootstrapChannels`` after ``#restoreLocalChannelState``,
//    populates ``store.notificationPolicies`` with one entry per
//    bootstrapped channel so consumers don't have to wait for an
//    interaction to seed the reactive cache.
//
// Total: 8 tests (target floor was ≥6).

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

const Sidebar = (await import('../src/components/Sidebar.svelte')).default;
const { MqttChatStore } = await import('../src/lib/mqtt-store.svelte.js');

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

function makeStubStore(overrides = {}) {
  const channelsById = {
    general: makeChannel('general', { starred: true, topic: 'Main', member: true }),
    random: makeChannel('random', { topic: 'Off-topic', member: true }),
    announcements: makeChannel('announcements', {
      topic: 'Broadcasts',
      member: false,
      visibility: 'listed',
    }),
    ...(overrides.channelsById ?? {}),
  };
  const policies = overrides.notificationPolicies ?? {};
  const store = {
    channelsById,
    channels: Object.values(channelsById),
    activeChannel: overrides.activeChannel ?? 'general',
    connected: true,
    connectionError: null,
    userProfile: overrides.userProfile ?? { key: 'phil-key', name: 'phil', type: 'human' },
    messages: overrides.messages ?? [],
    pinnedMessages: overrides.pinnedMessages ?? [],
    notificationPolicies: policies,
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
    setStar: vi.fn(),
    setMute: vi.fn(),
    markAllRead: vi.fn(),
    getNotificationPolicy: vi.fn((id) =>
      policies[id] ?? { policy: 'All', highlightWords: [] },
    ),
    cycleNotificationPolicy: vi.fn((id) => {
      const cur = policies[id]?.policy ?? 'All';
      const next = cur === 'All' ? 'Mentions' : cur === 'Mentions' ? 'Off' : 'All';
      policies[id] = { policy: next, highlightWords: policies[id]?.highlightWords ?? [] };
      return next;
    }),
    setNotificationPolicy: vi.fn(),
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

beforeEach(() => {
  apiGetMock.mockReset();
  mcpCallMock.mockReset();
  mcpCallMock.mockResolvedValue({ success: true, payload: {} });
  try { localStorage.clear(); } catch { /* ignore */ }
});

afterEach(() => {
  cleanup();
  try { localStorage.clear(); } catch { /* ignore */ }
});

// ── 1. notificationPolicy plumbing → SidebarChannelRow bell variant ────

describe('Wave G follow-up - Sidebar forwards notificationPolicy to rows', () => {
  it('renders the BellDot variant on a row whose policy is Mentions', () => {
    const store = makeStubStore({
      notificationPolicies: {
        random: { policy: 'Mentions', highlightWords: [] },
      },
    });
    const { getByTestId } = renderSidebar(store);

    const bell = getByTestId('row-notif-bell-random');
    expect(bell).toBeTruthy();
    expect(bell.getAttribute('data-policy')).toBe('Mentions');
    expect(bell.classList.contains('variant-mentions')).toBe(true);

    // ``getNotificationPolicy`` was consulted for the random row.
    expect(store.getNotificationPolicy).toHaveBeenCalledWith('random');
  });

  it('renders the BellOff variant on a row whose policy is Off', () => {
    const store = makeStubStore({
      notificationPolicies: {
        general: { policy: 'Off', highlightWords: [] },
      },
    });
    const { getByTestId } = renderSidebar(store);

    const bell = getByTestId('row-notif-bell-general');
    expect(bell.getAttribute('data-policy')).toBe('Off');
    expect(bell.classList.contains('variant-off')).toBe(true);
  });

  it('renders no bell badge at all on a row whose policy is the default "All"', () => {
    const store = makeStubStore();
    const { queryByTestId } = renderSidebar(store);

    // Wave G's SidebarChannelRow gates the entire <span class="row-notif-bell">
    // block on a non-'All' policy (silent renderer-side branch for the
    // default), so the breadcrumb element is absent, not just untoned.
    expect(queryByTestId('row-notif-bell-random')).toBeNull();
    expect(queryByTestId('row-notif-bell-general')).toBeNull();
  });
});

// ── 2. ChannelContextMenu mount receives currentNotificationPolicy ─────

describe('Wave G follow-up - Sidebar passes currentNotificationPolicy to ChannelContextMenu', () => {
  it('shows the channel\'s current policy in the Q8 quickview row label', async () => {
    const store = makeStubStore({
      notificationPolicies: {
        random: { policy: 'Mentions', highlightWords: [] },
      },
    });
    const { getByTestId } = renderSidebar(store);

    // Trigger the context menu via the row's contextmenu event. The
    // row's data-testid is sidebar-channel-row-{id} per the existing
    // Sidebar tests' convention.
    const row = getByTestId('sidebar-channel-row-random');
    await fireEvent.contextMenu(row);
    await tick();

    const quickRow = getByTestId('channel-ctx-item-notif:cycle');
    expect(quickRow).toBeTruthy();
    expect(quickRow.textContent).toMatch(/Notifications:\s*Mentions/);
    expect(quickRow.getAttribute('data-quickview')).toBe('true');
  });

  it('shows "Notifications: All" when no policy override is configured', async () => {
    const store = makeStubStore();
    const { getByTestId } = renderSidebar(store);

    const row = getByTestId('sidebar-channel-row-random');
    await fireEvent.contextMenu(row);
    await tick();

    const quickRow = getByTestId('channel-ctx-item-notif:cycle');
    expect(quickRow.textContent).toMatch(/Notifications:\s*All/);
  });
});

// ── 3. handleContextAction handles notif:cycle ─────────────────────────

describe('Wave G follow-up - Sidebar handleContextAction notif:cycle', () => {
  it('clicking the quickview row calls store.cycleNotificationPolicy and closes the menu', async () => {
    const store = makeStubStore({
      notificationPolicies: {
        random: { policy: 'All', highlightWords: [] },
      },
    });
    const { getByTestId, queryByTestId } = renderSidebar(store);

    const row = getByTestId('sidebar-channel-row-random');
    await fireEvent.contextMenu(row);
    await tick();

    const quickRow = getByTestId('channel-ctx-item-notif:cycle');
    await fireEvent.click(quickRow);
    await tick();

    expect(store.cycleNotificationPolicy).toHaveBeenCalledTimes(1);
    expect(store.cycleNotificationPolicy).toHaveBeenCalledWith('random');
    // Menu is closed (the row + every other ctx-item has been unmounted).
    expect(queryByTestId('channel-ctx-item-notif:cycle')).toBeNull();
  });

  it('cycling an unset policy advances the label on the next open of the same channel', async () => {
    const store = makeStubStore();
    const { getByTestId } = renderSidebar(store);

    // First open: defaults to "All".
    const row = getByTestId('sidebar-channel-row-random');
    await fireEvent.contextMenu(row);
    await tick();
    expect(getByTestId('channel-ctx-item-notif:cycle').textContent).toMatch(/Notifications:\s*All/);

    // Cycle → "Mentions".
    await fireEvent.click(getByTestId('channel-ctx-item-notif:cycle'));
    await tick();

    // Re-open: now reflects the new state.
    await fireEvent.contextMenu(row);
    await tick();
    expect(getByTestId('channel-ctx-item-notif:cycle').textContent).toMatch(/Notifications:\s*Mentions/);
  });
});

// ── 4. Bootstrap pre-warm (VERIFY-WAVE-G-5) ────────────────────────────

describe('Wave G follow-up - bootstrap pre-warms notificationPolicies cache', () => {
  it('populates store.notificationPolicies for every bootstrapped channel', async () => {
    const store = new MqttChatStore();
    apiGetMock.mockResolvedValueOnce([
      { id: 'general', name: 'general', member: true },
      { id: 'random', name: 'random', member: true },
      { id: 'announcements', name: 'announcements', member: false, visibility: 'listed' },
    ]);
    await store._bootstrapChannelsForTest();

    // Each bootstrapped channel now has a cache entry (default policy).
    expect(store.notificationPolicies['general']).toBeTruthy();
    expect(store.notificationPolicies['general']).toEqual({
      policy: 'All',
      highlightWords: [],
    });
    expect(store.notificationPolicies['random']).toBeTruthy();
    expect(store.notificationPolicies['announcements']).toBeTruthy();
  });

  it('preserves explicit policies from localStorage during pre-warm', async () => {
    // Seed localStorage BEFORE bootstrap so the lazy-decode path runs.
    localStorage.setItem(
      'cc:notif-policy:general',
      JSON.stringify({ policy: 'Off', highlightWords: ['ship'] }),
    );

    const store = new MqttChatStore();
    apiGetMock.mockResolvedValueOnce([
      { id: 'general', name: 'general', member: true },
      { id: 'random', name: 'random', member: true },
    ]);
    await store._bootstrapChannelsForTest();

    expect(store.notificationPolicies['general']).toEqual({
      policy: 'Off',
      highlightWords: ['ship'],
    });
    // The unseeded channel still gets the default entry from pre-warm.
    expect(store.notificationPolicies['random']).toEqual({
      policy: 'All',
      highlightWords: [],
    });
  });
});
