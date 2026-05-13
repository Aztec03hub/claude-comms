// Sidebar.svelte UX fixes — coverage for v0.3.3 Step 1.4 chrome (G-5 + G-25).
//
// v0.4.0 Step 2.12 (sidebar shell rewrite): the G-4 star-toggle invariants
// moved out of Sidebar.svelte and now live in SidebarChannelRow
// (covered by `sidebar-channel-row.spec.js`) plus the new
// `sidebar.spec.js` shell-shape suite. The G-5 brand version label and
// G-25 connection-status footer are STILL owned by Sidebar.svelte, so
// those two suites stay here.
//
//   G-5   The brand-version label reflects package.json's version, not a
//         stale hardcoded literal.
//
//   G-25  The footer ustatus + status-dot reflect store.connected /
//         store.connectionError using the three-state machine that
//         mirrors ConnectionStatus.svelte:
//           connected            → "Online"        (.online)
//           !connected && error  → "Offline"       (.offline)
//           !connected && !error → "Reconnecting…" (.connecting)

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';

import Sidebar from '../src/components/Sidebar.svelte';
import pkg from '../package.json';

// ── Fixtures ───────────────────────────────────────────────────────────

function makeStore({ connected = true, connectionError = null } = {}) {
  // Minimal shape the new shell reads — three sorted-array projections,
  // channelsById, userProfile, messages, pinnedMessages, lifecycle stubs.
  const channelsById = {
    general: { id: 'general', name: 'general', topic: 'Main', starred: false, unread: 0, muted: false, member: true, mode: 'public', visibility: 'listed', createdBy: null },
  };
  const store = {
    channelsById,
    channels: Object.values(channelsById),
    activeChannel: 'general',
    connected,
    connectionError,
    userProfile: { key: 'phil-key', name: 'phil', type: 'human' },
    messages: [],
    pinnedMessages: [],
    get starredChannels() { return Object.values(this.channelsById).filter(c => c.member && c.starred); },
    get activeChannels() { return Object.values(this.channelsById).filter(c => c.member && !c.starred); },
    get availableChannels() { return Object.values(this.channelsById).filter(c => !c.member); },
    switchChannel: vi.fn(),
    muteChannel: vi.fn(),
    toggleStar: vi.fn(),
    setStar: vi.fn(),
    setMute: vi.fn(),
    joinChannel: vi.fn(() => Promise.resolve({ success: true })),
    leaveChannel: vi.fn(() => ({ done: Promise.resolve({ success: true }), cancel: () => {} })),
    closeChannel: vi.fn(() => ({ done: Promise.resolve({ success: true }), cancel: () => {} })),
    deleteChannel: vi.fn(() => Promise.resolve({ success: true })),
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

afterEach(() => {
  cleanup();
});

// ── G-5: Version label sourced from package.json ───────────────────────

describe('Sidebar G-5 — version label', () => {
  it('renders the version from package.json, not a stale hardcoded literal', () => {
    const store = makeStore();
    const { getByTestId } = renderSidebar(store);

    const versionEl = getByTestId('sidebar-version');
    // The component imports package.json the same way this test does,
    // so they must agree. If package.json bumps, this test bumps with it.
    expect(versionEl.textContent).toBe(`v${pkg.version}`);
    // Belt-and-suspenders: the literal we replaced must never reappear.
    expect(versionEl.textContent).not.toBe('v0.1.0');
  });
});

// ── G-25: Status binding ───────────────────────────────────────────────

describe('Sidebar G-25 — connection status binding', () => {
  it('shows "Online" + green dot when store.connected is true', () => {
    const store = makeStore({ connected: true, connectionError: null });
    const { getByTestId } = renderSidebar(store);

    const status = getByTestId('sidebar-user-status');
    const dot = getByTestId('sidebar-status-dot');
    expect(status.textContent).toBe('Online');
    expect(status.classList.contains('online')).toBe(true);
    expect(dot.classList.contains('online')).toBe(true);
  });

  it('shows "Reconnecting…" + amber dot when not connected and no error yet', () => {
    const store = makeStore({ connected: false, connectionError: null });
    const { getByTestId } = renderSidebar(store);

    const status = getByTestId('sidebar-user-status');
    const dot = getByTestId('sidebar-status-dot');
    expect(status.textContent).toBe('Reconnecting…');
    expect(status.classList.contains('connecting')).toBe(true);
    expect(dot.classList.contains('connecting')).toBe(true);
  });

  it('shows "Offline" + red dot when not connected and an error is set', () => {
    const store = makeStore({
      connected: false,
      connectionError: 'Broker unavailable — is "claude-comms start" running?',
    });
    const { getByTestId } = renderSidebar(store);

    const status = getByTestId('sidebar-user-status');
    const dot = getByTestId('sidebar-status-dot');
    expect(status.textContent).toBe('Offline');
    expect(status.classList.contains('offline')).toBe(true);
    expect(dot.classList.contains('offline')).toBe(true);
  });
});
