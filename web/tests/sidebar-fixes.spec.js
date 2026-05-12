// Sidebar.svelte UX fixes — coverage for v0.3.3 Step 1.4 (G-4 + G-5 + G-25).
//
// These tests render the real component against a hand-rolled store that
// exposes only the surfaces Sidebar reads. We're not exercising the full
// ChatStore — the goal is to pin behavior at the seams Sidebar depends on:
//
//   G-4   Star toggle button is wired to handleStarToggle(); clicking it
//         calls store.toggleStar() (or the optional onStarToggle prop),
//         and the click does NOT bubble up to the row-level
//         switchChannel handler. Both starred (filled) and unstarred
//         (hollow) variants are tested.
//
//   G-5   The brand-version label reflects package.json's version, not a
//         stale hardcoded literal. Asserted against the real package.json
//         resolved via the same Vite JSON import the component uses.
//
//   G-25  The footer ustatus + status-dot reflect store.connected /
//         store.connectionError using the three-state machine that
//         mirrors ConnectionStatus.svelte:
//           connected            → "Online"        (.online)
//           !connected && error  → "Offline"       (.offline)
//           !connected && !error → "Reconnecting…" (.connecting)
//
// Test helper: `makeStore()` returns a Svelte 5 reactive plain object
// (we use `$state.raw` semantics here — plain JS object is fine because
// the assertions read state immediately after a synchronous prop swap
// via `rerender`, not across reactive boundaries).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

import Sidebar from '../src/components/Sidebar.svelte';
import pkg from '../package.json';

// ── Fixtures ───────────────────────────────────────────────────────────

function makeStore({ connected = true, connectionError = null, channels = null } = {}) {
  const defaultChannels = [
    { id: 'general', topic: 'Main', starred: false, unread: 0, muted: false },
    { id: 'project-alpha', topic: 'Project A', starred: true, unread: 0, muted: false },
    { id: 'lora-training', topic: 'LoRA', starred: true, unread: 0, muted: false },
    { id: 'random', topic: 'Off-topic', starred: false, unread: 0, muted: false },
  ];
  const store = {
    channels: channels ?? defaultChannels,
    activeChannel: 'general',
    connected,
    connectionError,
    userProfile: { key: 'phil-key', name: 'phil', type: 'human' },
    switchChannel: vi.fn(),
    muteChannel: vi.fn(),
    toggleStar: vi.fn(function (channelId) {
      const ch = store.channels.find((c) => c.id === channelId);
      if (ch) ch.starred = !ch.starred;
    }),
    get starredChannels() {
      return this.channels.filter((c) => c.starred);
    },
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
      onMuteChannel: vi.fn(),
      onOpenSettings: vi.fn(),
      ...overrides,
    },
  });
}

afterEach(() => {
  cleanup();
});

// ── G-4: Star toggle wiring ────────────────────────────────────────────

describe('Sidebar G-4 — star toggle wiring', () => {
  it('clicking the star button on an UNSTARRED row calls store.toggleStar with that channel id', async () => {
    const store = makeStore();
    const { getByTestId } = renderSidebar(store);

    // 'general' is unstarred — its star button should be present and
    // clicking it should flip the starred bit via store.toggleStar.
    const starBtn = getByTestId('channel-star-general');
    await fireEvent.click(starBtn);

    expect(store.toggleStar).toHaveBeenCalledTimes(1);
    expect(store.toggleStar).toHaveBeenCalledWith('general');
    // The row-level switchChannel must NOT fire — event.stopPropagation()
    // is what keeps the star button from accidentally switching channels.
    expect(store.switchChannel).not.toHaveBeenCalled();
  });

  it('clicking the star button on a STARRED row also calls toggleStar and does not bubble', async () => {
    const store = makeStore();
    const { getByTestId } = renderSidebar(store);

    // 'project-alpha' lives in the starred section — clicking its star
    // (the filled variant) must unstar it.
    const starBtn = getByTestId('channel-star-project-alpha');
    expect(starBtn.classList.contains('starred')).toBe(true);
    await fireEvent.click(starBtn);

    expect(store.toggleStar).toHaveBeenCalledTimes(1);
    expect(store.toggleStar).toHaveBeenCalledWith('project-alpha');
    expect(store.switchChannel).not.toHaveBeenCalled();
  });

  it('prefers the parent-supplied onStarToggle prop when provided', async () => {
    const store = makeStore();
    const onStarToggle = vi.fn();
    const { getByTestId } = renderSidebar(store, { onStarToggle });

    await fireEvent.click(getByTestId('channel-star-random'));

    // When the parent supplies onStarToggle, we route through it instead
    // of touching the store directly — gives the parent a hook for
    // analytics / optimistic UI / etc. without altering store contract.
    expect(onStarToggle).toHaveBeenCalledTimes(1);
    expect(onStarToggle).toHaveBeenCalledWith('random');
    expect(store.toggleStar).not.toHaveBeenCalled();
  });
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
